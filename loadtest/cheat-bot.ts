/**
 * Cheating client. Proves the server rejects and corrects cheats.
 *
 *   npm run cheat -- --url http://localhost:8080
 *
 * Joins an authoritative room and, for --duration seconds, tries:
 *   1. teleport:    "state" messages claiming a far-away position
 *   2. speed hack:  10 "Up" inputs per tick instead of 1
 *   3. pos smuggle: inputs that carry x/y/pos fields
 *   4. replay:      re-sending old input seqs, and absurd seq jumps
 *   5. rapid fire:  Fire held every input
 *
 * It then checks, from the server's own snapshots, that the tank's path was
 * no longer than TANK_SPEED allows (10x inputs did not mean 10x speed), never reached the teleport target, and fired no
 * faster than the cooldown allows. It prints the server's rejection counters
 * from /metrics. Exit 0 if every cheat was blocked.
 */
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import {
  FIRE_COOLDOWN_SLACK_TICKS,
  FIRE_COOLDOWN_TICKS,
  INPUT_BURST,
  Key,
  PROTOCOL_VERSION,
  SnapshotStore,
  TANK_SPEED,
  TICK_MS,
  TICK_RATE,
  decodeServerMessage,
  type ClientMessage,
} from "@tanks/shared";
import { Bot, createRoom, runTicker, wsUrlFor } from "./src/bot.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    duration: { type: "string", default: "6" },
  },
});
const httpBase = (args.url ?? "http://localhost:8080").replace(/\/+$/, "");
const durationMs = Number(args.duration) * 1000;

async function main(): Promise<void> {
  const roomId = await createRoom(httpBase, "authoritative");
  // An honest bot so there is a target to shoot at.
  const honest = new Bot({ wsUrl: wsUrlFor(httpBase), roomId, mode: "authoritative", name: "honest", seed: 7 });
  await honest.connect();
  const stopHonest = runTicker([honest]);

  const ws = new WebSocket(wsUrlFor(httpBase));
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  // Raw JSON on purpose: a cheating client is not limited to well-formed protocol messages.
  const send = (m: ClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(m));
  const store = new SnapshotStore();
  let myId = -1;
  let latest = 0;
  const track: { tick: number; x: number; y: number; hp: number }[] = [];
  let shotsFired = 0;
  const errors = new Map<string, number>();

  ws.on("message", (d) => {
    const m = decodeServerMessage(d.toString());
    if (!m) return;
    if (m.t === "welcome") myId = m.playerId;
    if (m.t === "error") errors.set(m.code, (errors.get(m.code) ?? 0) + 1);
    if (m.t === "snap") {
      const w = store.apply(m);
      if (!w) return;
      latest = m.tick;
      const me = w.get(myId);
      if (me) track.push({ tick: m.tick, x: me.x, y: me.y, hp: me.hp });
      for (const ev of m.ev ?? []) if (ev.id === myId) shotsFired++;
    }
  });
  send({ t: "join", v: PROTOCOL_VERSION, roomId, name: "cheater" });
  await new Promise((r) => setTimeout(r, 300));

  const TELEPORT = { x: 1100, y: 700 };
  let seq = 0;
  const attempts = { teleport: 0, flood: 0, smuggle: 0, replay: 0, seqJump: 0, fireAttempts: 0 };
  const timer = setInterval(() => {
    // 1. teleport
    send({ t: "state", seq: seq + 1, x: TELEPORT.x, y: TELEPORT.y, angle: 0 });
    attempts.teleport++;
    // 2 + 5. speed hack with fire held: 10 inputs per tick
    for (let i = 0; i < 10; i++) {
      seq++;
      // Up+Left drives a circle (radius ~57 units), so walls never cap the distance.
      send({ t: "input", seq, keys: Key.Up | Key.Left | Key.Fire, aim: 0, vt: latest, ack: store.latestTick });
      attempts.flood++;
      attempts.fireAttempts++;
    }
    // 3. smuggle a position inside an input
    send({ t: "input", seq: seq + 1, keys: Key.Up, aim: 0, vt: latest, ack: store.latestTick, x: TELEPORT.x, y: TELEPORT.y });
    attempts.smuggle++;
    // 4. replay an old seq
    send({ t: "input", seq: Math.max(1, seq - 20), keys: Key.Up, aim: 0, vt: latest, ack: store.latestTick });
    attempts.replay++;
    send({ t: "input", seq: seq + 100_000, keys: Key.Up, aim: 0, vt: latest, ack: store.latestTick });
    attempts.seqJump++;
  }, TICK_MS);

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(timer);
  stopHonest();
  honest.leave();
  ws.close();
  await new Promise((r) => setTimeout(r, 200));

  // --- verdicts, from the server's snapshots ---
  const startTick = track[0]?.tick ?? 0;
  const endTick = track.at(-1)?.tick ?? 0;
  // Path length along the server's track, skipping death/respawn (a legitimate jump to the spawn point).
  let maxStepPerTick = 0;
  let pathLength = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (!a || !b || a.hp === 0 || b.hp === 0) continue;
    const ticks = Math.max(1, b.tick - a.tick);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    pathLength += d;
    maxStepPerTick = Math.max(maxStepPerTick, d / ticks);
  }
  const elapsedSec = (endTick - startTick) / TICK_RATE;
  const maxLegit = TANK_SPEED * (elapsedSec + INPUT_BURST / TICK_RATE);
  const teleported = track.some((p) => Math.hypot(p.x - TELEPORT.x, p.y - TELEPORT.y) < 1);
  const maxShots = Math.floor((endTick - startTick) / (FIRE_COOLDOWN_TICKS - FIRE_COOLDOWN_SLACK_TICKS)) + 1;

  const metrics = await (await fetch(`${httpBase}/metrics`)).text();
  const rejections: Record<string, number> = {};
  for (const m of metrics.matchAll(/^tanks_input_rejections_total\{reason="([a-z_]+)"\} (\d+)/gm)) {
    rejections[m[1] ?? ""] = Number(m[2]);
  }

  const checks = {
    noTeleport: !teleported,
    speedCapped: maxStepPerTick <= (TANK_SPEED / TICK_RATE) * INPUT_BURST + 1e-6 && pathLength <= maxLegit + 1e-6,
    fireRateCapped: shotsFired <= maxShots,
    rejectionsCounted:
      (rejections.client_position ?? 0) > 0 &&
      (rejections.rate_limit ?? 0) > 0 &&
      (rejections.seq_replay ?? 0) > 0 &&
      (rejections.seq_jump ?? 0) > 0 &&
      (rejections.malformed ?? 0) > 0 &&
      (rejections.fire_cooldown ?? 0) > 0,
  };
  const summary = {
    roomId,
    seconds: +elapsedSec.toFixed(2),
    attempts,
    observed: {
      pathLength: +pathLength.toFixed(1),
      unthrottledPathLength: +(maxLegit * 10).toFixed(0),
      maxLegitDistance: +maxLegit.toFixed(1),
      fastestStepPerTick: +maxStepPerTick.toFixed(2),
      normalStepPerTick: +(TANK_SPEED / TICK_RATE).toFixed(2),
      shotsAccepted: shotsFired,
      shotsAllowedMax: maxShots,
      reachedTeleportTarget: teleported,
    },
    serverRejections: rejections,
    errorsReceived: Object.fromEntries(errors),
    checks,
  };
  console.log(JSON.stringify(summary, null, 2));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? "OK: every cheat was rejected or corrected by the server" : "FAIL: a cheat got through");
  process.exitCode = ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

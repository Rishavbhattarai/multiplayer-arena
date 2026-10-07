/**
 * Headless bot swarm (Week 1: naive mode).
 *
 *   npm run bots -- --bots 2 --duration 5
 *   npm run bots -- --url http://localhost:8080 --room ABC123 --bots 20 --duration 30
 *
 * Each bot joins a room over WebSocket, drives itself with the shared
 * stepTank at 30 Hz (random-walk keys from a seeded PRNG), sends its
 * position every tick and counts the snapshots it receives.
 *
 * Exit code 0 if every bot joined, received snapshots, and saw every other
 * bot in at least one snapshot; 1 otherwise.
 *
 * TODO(week5): ramp mode (add bots until server p99 tick time > 33 ms),
 * per-bot RTT percentiles, and JSON results written to loadtest/results/.
 * YOUR TURN (see YOUR_TURN.md, push 3/3): the cheating bot goes in loadtest/cheat-bot.ts.
 */
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import {
  Key,
  PROTOCOL_VERSION,
  TICK_DT,
  TICK_MS,
  decodeServerMessage,
  encode,
  stepTank,
  type ClientMessage,
  type RoomInfo,
  type TankState,
} from "@tanks/shared";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    room: { type: "string" },
    bots: { type: "string", default: "2" },
    duration: { type: "string", default: "5" },
    seed: { type: "string", default: "42" },
  },
});

const httpBase = (args.url ?? "http://localhost:8080").replace(/\/+$/, "");
const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws`;
const botCount = Number(args.bots);
const durationMs = Number(args.duration) * 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BotResult {
  bot: number;
  playerId: number | null;
  snaps: number;
  maxEntitiesSeen: number;
  otherIdsSeen: number;
  lastServerTick: number;
  sent: number;
  bytesIn: number;
  bytesOut: number;
  errors: string[];
}

async function runBot(index: number, roomId: string, seed: number): Promise<BotResult> {
  const r: BotResult = {
    bot: index,
    playerId: null,
    snaps: 0,
    maxEntitiesSeen: 0,
    otherIdsSeen: 0,
    lastServerTick: 0,
    sent: 0,
    bytesIn: 0,
    bytesOut: 0,
    errors: [],
  };
  const rand = mulberry32(seed);
  const ws = new WebSocket(wsUrl);
  const others = new Set<number>();
  let state: TankState | null = null;
  let keys = 0;
  let seq = 0;
  let timer: NodeJS.Timeout | undefined;

  const send = (m: ClientMessage) => {
    const data = encode(m);
    r.bytesOut += data.length;
    r.sent++;
    ws.send(data);
  };

  await new Promise<void>((resolve) => {
    ws.on("open", () => send({ t: "join", v: PROTOCOL_VERSION, roomId, name: `bot-${index}` }));
    ws.on("message", (data) => {
      const text = data.toString();
      r.bytesIn += text.length;
      const msg = decodeServerMessage(text);
      if (!msg) {
        r.errors.push("undecodable message");
        return;
      }
      if (msg.t === "welcome") {
        r.playerId = msg.playerId;
        state = { ...msg.spawn };
        timer = setInterval(() => {
          if (!state) return;
          if (seq % 15 === 0) {
            const fwd = rand() < 0.8 ? Key.Up : 0;
            const turn = [0, Key.Left, Key.Right][Math.floor(rand() * 3)] ?? 0;
            keys = fwd | turn;
          }
          state = stepTank(state, keys, TICK_DT);
          send({ t: "state", seq: ++seq, x: state.x, y: state.y, angle: state.angle });
        }, TICK_MS);
      } else if (msg.t === "snap") {
        r.snaps++;
        r.lastServerTick = msg.tick;
        r.maxEntitiesSeen = Math.max(r.maxEntitiesSeen, msg.entities.length);
        for (const e of msg.entities) if (e.id !== r.playerId) others.add(e.id);
      } else if (msg.t === "error") {
        r.errors.push(`${msg.code}: ${msg.message}`);
      }
    });
    ws.on("error", (err) => {
      r.errors.push(err.message);
      resolve();
    });
    ws.on("close", () => resolve());
    setTimeout(() => {
      clearInterval(timer);
      ws.close();
    }, durationMs);
  });
  clearInterval(timer);
  r.otherIdsSeen = others.size;
  return r;
}

async function main(): Promise<void> {
  let roomId = args.room;
  if (!roomId) {
    const res = await fetch(`${httpBase}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "naive" }),
    });
    if (!res.ok) throw new Error(`create room failed: HTTP ${res.status}`);
    roomId = ((await res.json()) as RoomInfo).roomId;
  }
  console.log(`room ${roomId}: ${botCount} bot(s) for ${durationMs / 1000}s against ${wsUrl}`);

  const seed = Number(args.seed);
  const results = await Promise.all(Array.from({ length: botCount }, (_, i) => runBot(i, roomId, seed + i)));
  const secs = durationMs / 1000;
  for (const r of results) {
    console.log(
      JSON.stringify({
        ...r,
        snapsPerSec: +(r.snaps / secs).toFixed(1),
        kbInPerSec: +(r.bytesIn / 1024 / secs).toFixed(2),
        kbOutPerSec: +(r.bytesOut / 1024 / secs).toFixed(2),
      }),
    );
  }
  const ok = results.every(
    (r) => r.playerId !== null && r.snaps > 0 && r.otherIdsSeen >= botCount - 1 && r.errors.length === 0,
  );
  console.log(ok ? "OK: all bots joined, received snapshots and saw each other" : "FAIL: see results above");
  process.exitCode = ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Headless bot swarm.
 *
 *   npm run bots -- --bots 2 --duration 5                       # authoritative room, 2 bots
 *   npm run bots -- --mode naive --bots 2 --duration 5
 *   npm run bots -- --url http://localhost:8080 --room ABC123 --bots 6 --duration 60
 *   npm run bots -- --bots 4 --drop-every 3                     # reconnect chaos
 *
 * Exit code 0 if every bot joined, received snapshots, saw every other bot,
 * and (with --drop-every) every resume kept the same tank and position.
 */
import { parseArgs } from "node:util";
import { isRoomMode, type RoomMode } from "@tanks/shared";
import { Bot, createRoom, runTicker, wsUrlFor } from "./bot.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    room: { type: "string" },
    mode: { type: "string", default: "authoritative" },
    delta: { type: "string", default: "on" },
    bots: { type: "string", default: "2" },
    duration: { type: "string", default: "5" },
    seed: { type: "string", default: "42" },
    "drop-every": { type: "string" },
  },
});

const httpBase = (args.url ?? "http://localhost:8080").replace(/\/+$/, "");
const mode: RoomMode = isRoomMode(args.mode) ? args.mode : "authoritative";
const botCount = Number(args.bots);
const durationMs = Number(args.duration) * 1000;
const dropEveryMs = args["drop-every"] ? Number(args["drop-every"]) * 1000 : null;

async function main(): Promise<void> {
  const roomId = args.room ?? (await createRoom(httpBase, mode, args.delta !== "off"));
  console.log(`room ${roomId} (${mode}): ${botCount} bot(s) for ${durationMs / 1000}s against ${wsUrlFor(httpBase)}`);

  const bots = Array.from(
    { length: botCount },
    (_, i) => new Bot({ wsUrl: wsUrlFor(httpBase), roomId, mode, name: `bot-${i}`, seed: Number(args.seed) + i }),
  );
  await Promise.all(bots.map((b) => b.connect()));
  const stopTicker = runTicker(bots);

  let chaos: NodeJS.Timeout | undefined;
  if (dropEveryMs) {
    let i = 0;
    chaos = setInterval(() => {
      const b = bots[i++ % bots.length];
      if (b) void b.dropAndResume();
    }, dropEveryMs);
  }

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(chaos);
  stopTicker();
  for (const b of bots) b.leave();
  await new Promise((r) => setTimeout(r, 200));

  const secs = durationMs / 1000;
  for (const b of bots) {
    const s = b.stats;
    console.log(
      JSON.stringify({
        ...s,
        errors: s.errors.slice(0, 5),
        snapsPerSec: +(s.snaps / secs).toFixed(1),
        kbInPerSec: +(s.bytesIn / 1024 / secs).toFixed(2),
        kbOutPerSec: +(s.bytesOut / 1024 / secs).toFixed(2),
      }),
    );
  }
  const ok = bots.every(
    (b) =>
      b.stats.playerId !== null &&
      b.stats.snaps > 0 &&
      b.stats.othersSeen >= botCount - 1 &&
      b.stats.errors.length === 0 &&
      b.stats.reconnectFailures === 0 &&
      b.stats.resumeStateIntact !== false,
  );
  const resumes = bots.reduce((n, b) => n + b.stats.reconnects, 0);
  console.log(
    ok
      ? `OK: all bots joined, received snapshots and saw each other${dropEveryMs ? `; ${resumes} reconnects, state intact` : ""}`
      : "FAIL: see results above",
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Bandwidth per player: naive vs authoritative full snapshots vs
 * authoritative delta snapshots, same bots, same room sizes.
 *
 *   npm run bandwidth -- --rooms 4 --duration 20
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MAX_PLAYERS_PER_ROOM, type RoomMode, type ServerStats } from "@tanks/shared";
import { Bot, createRoom, runTicker, wsUrlFor } from "./bot.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    rooms: { type: "string", default: "4" },
    duration: { type: "string", default: "20" },
  },
});
const httpBase = (args.url ?? "http://localhost:8080").replace(/\/+$/, "");
const roomCount = Number(args.rooms);
const durationMs = Number(args.duration) * 1000;

interface Variant {
  label: string;
  mode: RoomMode;
  delta: boolean;
}
const VARIANTS: Variant[] = [
  { label: "naive (client positions, full snapshots)", mode: "naive", delta: false },
  { label: "authoritative, full snapshots", mode: "authoritative", delta: false },
  { label: "authoritative, delta snapshots", mode: "authoritative", delta: true },
];

async function run(v: Variant) {
  const bots: Bot[] = [];
  for (let r = 0; r < roomCount; r++) {
    const roomId = await createRoom(httpBase, v.mode, v.delta);
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      bots.push(new Bot({ wsUrl: wsUrlFor(httpBase), roomId, mode: v.mode, name: `b${r}-${i}`, seed: 1000 * r + i }));
    }
  }
  await Promise.all(bots.map((b) => b.connect()));
  const stop = runTicker(bots);
  await new Promise((res) => setTimeout(res, 2000)); // warm-up
  const in0 = bots.reduce((n, b) => n + b.stats.bytesIn, 0);
  const out0 = bots.reduce((n, b) => n + b.stats.bytesOut, 0);
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, durationMs));
  const secs = (performance.now() - t0) / 1000;
  const in1 = bots.reduce((n, b) => n + b.stats.bytesIn, 0);
  const out1 = bots.reduce((n, b) => n + b.stats.bytesOut, 0);
  const stats = (await (await fetch(`${httpBase}/stats`)).json()) as ServerStats;
  stop();
  for (const b of bots) b.leave();
  await new Promise((res) => setTimeout(res, 1500));
  const n = bots.length;
  const deltaShare = bots.reduce((s, b) => s + b.stats.deltaSnaps, 0) / Math.max(1, bots.reduce((s, b) => s + b.stats.snaps, 0));
  return {
    variant: v.label,
    players: n,
    downKBps: +((in1 - in0) / 1024 / secs / n).toFixed(2),
    upKBps: +((out1 - out0) / 1024 / secs / n).toFixed(2),
    serverOutKBpsPerPlayer: +(stats.bytesOutPerSec / 1024 / Math.max(1, stats.players)).toFixed(2),
    deltaShare: +deltaShare.toFixed(3),
    missingBase: bots.reduce((s, b) => s + b.stats.missingBase, 0),
  };
}

async function main(): Promise<void> {
  const results = [];
  for (const v of VARIANTS) {
    const r = await run(v);
    console.log(JSON.stringify(r));
    results.push(r);
  }
  const full = results[1]?.downKBps ?? 0;
  const delta = results[2]?.downKBps ?? 0;
  console.log(`\n${roomCount} rooms x ${MAX_PLAYERS_PER_ROOM} bots, ${durationMs / 1000}s each\n`);
  console.log("| variant | down KB/s per player | up KB/s per player |");
  console.log("|---|---|---|");
  for (const r of results) console.log(`| ${r.variant} | ${r.downKBps} | ${r.upKBps} |`);
  console.log(`\ndelta vs full (authoritative): ${full ? (((full - delta) / full) * 100).toFixed(0) : "?"}% less downstream`);
  mkdirSync(fileURLToPath(new URL("../results/", import.meta.url)), { recursive: true });
  const out = fileURLToPath(new URL("../results/bandwidth.json", import.meta.url));
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), rooms: roomCount, playersPerRoom: MAX_PLAYERS_PER_ROOM, seconds: durationMs / 1000, results }, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Ramp load test: add bots until the server's p99 tick time exceeds the
 * 33.3 ms budget (or it can no longer hold 30 ticks/s).
 *
 *   npm run start:server                      # terminal 1 (record the hardware!)
 *   npm run ramp -- --step 96 --max 2400      # terminal 2
 *
 * Bots run in --workers child processes so the bots are not the bottleneck;
 * each step reports worker CPU so a bot-limited run is visible. Server
 * numbers come from GET /stats (exact percentiles over a 5 s window) and
 * process CPU from GET /metrics.
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MAX_PLAYERS_PER_ROOM, TICK_MS, isRoomMode, type RoomMode, type ServerStats } from "@tanks/shared";
import { createRoom, wsUrlFor } from "./bot.js";
import type { WorkerCommand, WorkerStats } from "./worker.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    mode: { type: "string", default: "authoritative" },
    step: { type: "string", default: "96" },
    "step-seconds": { type: "string", default: "10" },
    max: { type: "string", default: "2400" },
    workers: { type: "string", default: "6" },
    out: { type: "string" },
    label: { type: "string", default: "" },
  },
});

const httpBase = (args.url ?? "http://localhost:8080").replace(/\/+$/, "");
const mode: RoomMode = isRoomMode(args.mode) ? args.mode : "authoritative";
const step = Number(args.step);
const stepMs = Number(args["step-seconds"]) * 1000;
const max = Number(args.max);
const workerCount = Number(args.workers);

interface Row {
  players: number;
  ticksPerSec: number;
  tickP50Ms: number;
  tickP99Ms: number;
  tickMaxMs: number;
  serverCpuPct: number;
  serverKBOutPerSec: number;
  kbPerPlayerPerSec: number;
  botSnapsPerSecPerBot: number;
  maxWorkerCpuPct: number;
  /** Host 1-minute load average when the row was measured (other processes share the machine). */
  hostLoad1m: number;
}

class WorkerHandle {
  private readonly child: ChildProcess;
  private pending: ((m: unknown) => void)[] = [];
  constructor() {
    this.child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (m) => this.pending.shift()?.(m));
  }
  request<T>(cmd: WorkerCommand): Promise<T> {
    return new Promise((resolve) => {
      this.pending.push((m) => resolve(m as T));
      this.child.send(cmd);
    });
  }
  stop(): void {
    this.child.send({ cmd: "stop" } satisfies WorkerCommand);
  }
}

async function serverCpuSeconds(): Promise<number> {
  const text = await (await fetch(`${httpBase}/metrics`)).text();
  const m = /^tanks_process_cpu_seconds_total (\S+)/m.exec(text);
  return m ? Number(m[1]) : 0;
}

async function main(): Promise<void> {
  const workers = Array.from({ length: workerCount }, () => new WorkerHandle());
  const rows: Row[] = [];
  let players = 0;
  let w = 0;
  let stopReason = `reached --max ${max}`;
  console.log(`ramp: +${step} bots every ${stepMs / 1000}s, ${workerCount} workers, mode=${mode}, budget ${TICK_MS.toFixed(1)} ms`);

  try {
    while (players < max) {
      const add = Math.min(step, max - players);
      const rooms: string[] = [];
      for (let i = 0; i < Math.ceil(add / MAX_PLAYERS_PER_ROOM); i++) rooms.push(await createRoom(httpBase, mode));
      // Spread rooms over workers.
      const perWorker = new Map<number, string[]>();
      for (const r of rooms) {
        const list = perWorker.get(w % workerCount) ?? [];
        list.push(r);
        perWorker.set(w++ % workerCount, list);
      }
      await Promise.all(
        [...perWorker].map(([i, roomIds]) =>
          workers[i]?.request({ cmd: "spawn", wsUrl: wsUrlFor(httpBase), roomIds, perRoom: MAX_PLAYERS_PER_ROOM, mode, seedBase: players + i * 10_000 }),
        ),
      );
      players += rooms.length * MAX_PLAYERS_PER_ROOM;

      // Let the step settle, then measure over the last 5 s (the /stats window).
      await new Promise((r) => setTimeout(r, Math.max(0, stepMs - 5000)));
      const cpu0 = await serverCpuSeconds();
      const ws0 = await Promise.all(workers.map((x) => x.request<WorkerStats>({ cmd: "stats" })));
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 5000));
      const cpu1 = await serverCpuSeconds();
      const ws1 = await Promise.all(workers.map((x) => x.request<WorkerStats>({ cmd: "stats" })));
      const secs = (performance.now() - t0) / 1000;
      const stats = (await (await fetch(`${httpBase}/stats`)).json()) as ServerStats;

      const snaps = ws1.reduce((n, s) => n + s.snaps, 0) - ws0.reduce((n, s) => n + s.snaps, 0);
      const connected = ws1.reduce((n, s) => n + s.connected, 0);
      const maxWorkerCpu = Math.max(...ws1.map((s, i) => (s.cpuMs - (ws0[i]?.cpuMs ?? 0)) / (secs * 10)));
      const row: Row = {
        players: stats.players,
        ticksPerSec: stats.ticksPerSec,
        tickP50Ms: stats.tickP50Ms,
        tickP99Ms: stats.tickP99Ms,
        tickMaxMs: stats.tickMaxMs,
        serverCpuPct: +(((cpu1 - cpu0) / secs) * 100).toFixed(1),
        serverKBOutPerSec: +(stats.bytesOutPerSec / 1024).toFixed(1),
        kbPerPlayerPerSec: +(stats.bytesOutPerSec / 1024 / Math.max(1, stats.players)).toFixed(2),
        botSnapsPerSecPerBot: +(snaps / secs / Math.max(1, connected)).toFixed(1),
        maxWorkerCpuPct: +maxWorkerCpu.toFixed(0),
        hostLoad1m: +(loadavg()[0] ?? 0).toFixed(1),
      };
      rows.push(row);
      console.log(JSON.stringify(row));

      if (row.tickP99Ms > TICK_MS) {
        stopReason = `p99 tick time ${row.tickP99Ms} ms > ${TICK_MS.toFixed(1)} ms budget`;
        break;
      }
      if (row.ticksPerSec < 28.5) {
        stopReason = `server could not hold 30 Hz (${row.ticksPerSec} ticks/s)`;
        break;
      }
    }
  } finally {
    for (const x of workers) x.stop();
  }

  const lastOk = [...rows].reverse().find((r) => r.tickP99Ms <= TICK_MS && r.ticksPerSec >= 28.5);
  const hardware = `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB`;
  const result = { date: new Date().toISOString(), label: args.label, hardware, node: process.version, mode, step, stepSeconds: stepMs / 1000, workers: workerCount, stopReason, maxPlayersWithinBudget: lastOk?.players ?? 0, rows };
  console.log(`\nstop: ${stopReason}`);
  console.log(`players within budget: ${result.maxPlayersWithinBudget}\n`);
  console.log("| players | ticks/s | tick p50 ms | tick p99 ms | server CPU % | KB/s per player | bot snaps/s | host load |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.players} | ${r.ticksPerSec} | ${r.tickP50Ms} | ${r.tickP99Ms} | ${r.serverCpuPct} | ${r.kbPerPlayerPerSec} | ${r.botSnapsPerSecPerBot} | ${r.hostLoad1m} |`);
  }
  const out = args.out ?? fileURLToPath(new URL(`../results/ramp-${mode}.json`, import.meta.url));
  mkdirSync(fileURLToPath(new URL("../results/", import.meta.url)), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  setTimeout(() => process.exit(0), 1000);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

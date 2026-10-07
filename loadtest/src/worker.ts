/**
 * Bot worker process for the ramp test. Hosts many bots on one timer and
 * reports counters to the parent over IPC.
 */
import type { RoomMode } from "@tanks/shared";
import { Bot, runTicker } from "./bot.js";

export type WorkerCommand =
  | { cmd: "spawn"; wsUrl: string; roomIds: string[]; perRoom: number; mode: RoomMode; seedBase: number }
  | { cmd: "stats" }
  | { cmd: "stop" };

export interface WorkerStats {
  bots: number;
  connected: number;
  snaps: number;
  bytesIn: number;
  cpuMs: number;
}

const bots: Bot[] = [];
let stopTicker: (() => void) | null = null;

function reply(msg: unknown): void {
  process.send?.(msg);
}

process.on("message", (m: WorkerCommand) => {
  void (async () => {
    if (m.cmd === "spawn") {
      const fresh: Bot[] = [];
      let i = 0;
      for (const roomId of m.roomIds) {
        for (let k = 0; k < m.perRoom; k++) {
          fresh.push(new Bot({ wsUrl: m.wsUrl, roomId, mode: m.mode, name: `b${m.seedBase + i}`, seed: m.seedBase + i }));
          i++;
        }
      }
      // Connect in small batches so the server is not hit by a thundering herd.
      for (let j = 0; j < fresh.length; j += 25) await Promise.all(fresh.slice(j, j + 25).map((b) => b.connect()));
      bots.push(...fresh);
      stopTicker?.();
      stopTicker = runTicker(bots);
      reply({ ok: true, spawned: fresh.length });
    } else if (m.cmd === "stats") {
      const cpu = process.cpuUsage();
      const s: WorkerStats = {
        bots: bots.length,
        connected: bots.filter((b) => b.stats.connected).length,
        snaps: bots.reduce((n, b) => n + b.stats.snaps, 0),
        bytesIn: bots.reduce((n, b) => n + b.stats.bytesIn, 0),
        cpuMs: (cpu.user + cpu.system) / 1000,
      };
      reply(s);
    } else {
      stopTicker?.();
      for (const b of bots) b.leave();
      setTimeout(() => process.exit(0), 500);
    }
  })();
});

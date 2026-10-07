import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { MAX_CLIENT_MESSAGE_BYTES, TICK_MS } from "@tanks/shared";
import { attachGateway } from "./gateway.js";
import { createHttpHandler } from "./http.js";
import { jsonLogger, type Logger } from "./log.js";
import { FixedTimestepLoop } from "./loop.js";
import { Metrics, StatsWindow } from "./metrics.js";
import type { RejectReason } from "./room.js";
import { InMemoryRoomRegistry, type RoomRegistry } from "./roomRegistry.js";
import { RoomManager } from "./roomManager.js";

export interface AppOptions {
  port: number;
  host?: string;
  serverId?: string;
  registry?: RoomRegistry;
  log?: Logger;
  reconnectGraceMs?: number;
}

export interface App {
  port: number;
  http: Server;
  manager: RoomManager;
  loop: FixedTimestepLoop;
  metrics: Metrics;
  stats: StatsWindow;
  close(): Promise<void>;
}

/** Wire HTTP lobby + WebSocket gateway + tick loop into one process (the MVP topology). */
export async function startApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? jsonLogger;
  const metrics = new Metrics();
  const stats = new StatsWindow();

  // Rejection log line: first occurrence per (room, player, reason), then every 100th.
  const rejectCounts = new Map<string, number>();
  const onReject = (roomId: string, playerId: number, reason: RejectReason) => {
    metrics.recordReject(reason);
    const key = `${roomId}:${playerId}:${reason}`;
    const n = (rejectCounts.get(key) ?? 0) + 1;
    rejectCounts.set(key, n);
    if (n === 1 || n % 100 === 0) log("warn", "input rejected", { roomId, player_id: playerId, reason, count: n });
  };

  const manager = new RoomManager({
    registry: opts.registry ?? new InMemoryRoomRegistry(),
    serverId: opts.serverId ?? `local:${opts.port}`,
    ...(opts.reconnectGraceMs !== undefined ? { reconnectGraceMs: opts.reconnectGraceMs } : {}),
    events: {
      onReject,
      onShot: (hit, rewind) => {
        metrics.shots.inc({ result: hit ? "hit" : "miss" });
        metrics.rewindTicks.observe(rewind);
      },
      onReconnect: (ok) => metrics.reconnects.inc({ result: ok ? "ok" : "failed" }),
    },
  });

  const handler = createHttpHandler(manager, metrics, stats);
  const http = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => log("error", "http handler failed", { err: String(err) }));
  });
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const stopHeartbeat = attachGateway(wss, manager, log, {
    onSend: (kind, bytes) => {
      metrics.recordSend(kind, bytes);
      stats.recordSent(bytes);
    },
    onReceive: (bytes) => {
      metrics.bytesReceived.inc(bytes);
      stats.recordReceived(bytes);
    },
  });

  let overrunWarnings = 0;
  const loop = new FixedTimestepLoop(
    () => {
      manager.stepAll();
    },
    {
      tickMs: TICK_MS,
      onTickTiming: (ms) => {
        metrics.tickDuration.observe(ms / 1000);
        stats.recordTick(ms);
      },
      onOverrun: (dropped) => {
        metrics.tickOverruns.inc(dropped);
        stats.overruns += dropped;
        if (overrunWarnings++ % 100 === 0) log("warn", "tick overrun, dropped backlog", { dropped });
      },
    },
  );

  // Gauges are computed at scrape time.
  metrics.players.reset();
  const refreshGauges = () => {
    metrics.players.set({ state: "connected" }, manager.connectedCount);
    metrics.players.set({ state: "disconnected" }, manager.playerCount - manager.connectedCount);
    metrics.rooms.set(manager.roomCount);
  };
  const gaugeTimer = setInterval(refreshGauges, 1000);
  gaugeTimer.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve());
  });
  loop.start();
  const port = (http.address() as AddressInfo).port;
  log("info", "server listening", { port, tickMs: TICK_MS, serverId: manager.serverId });

  return {
    port,
    http,
    manager,
    loop,
    metrics,
    stats,
    async close() {
      loop.stop();
      stopHeartbeat();
      clearInterval(gaugeTimer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

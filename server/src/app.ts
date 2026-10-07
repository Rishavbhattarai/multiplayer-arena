import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { MAX_CLIENT_MESSAGE_BYTES, TICK_MS } from "@tanks/shared";
import { attachGateway } from "./gateway.js";
import { createHttpHandler } from "./http.js";
import { jsonLogger, type Logger } from "./log.js";
import { FixedTimestepLoop } from "./loop.js";
import { InMemoryRoomRegistry, type RoomRegistry } from "./roomRegistry.js";
import { RoomManager } from "./roomManager.js";

export interface AppOptions {
  port: number;
  host?: string;
  serverId?: string;
  registry?: RoomRegistry;
  log?: Logger;
}

export interface App {
  port: number;
  http: Server;
  manager: RoomManager;
  loop: FixedTimestepLoop;
  close(): Promise<void>;
}

/** Wire HTTP lobby + WebSocket gateway + tick loop into one process (the MVP topology). */
export async function startApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? jsonLogger;
  const manager = new RoomManager({
    registry: opts.registry ?? new InMemoryRoomRegistry(),
    serverId: opts.serverId ?? `local:${opts.port}`,
  });

  const handler = createHttpHandler(manager);
  const http = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => log("error", "http handler failed", { err: String(err) }));
  });
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const stopHeartbeat = attachGateway(wss, manager, log);

  let overrunWarnings = 0;
  const loop = new FixedTimestepLoop(() => manager.stepAll(), {
    tickMs: TICK_MS,
    onOverrun: (dropped) => {
      // Rate-limit the log line; Week 5 turns this into a Prometheus counter.
      if (overrunWarnings++ % 100 === 0) log("warn", "tick overrun, dropped backlog", { dropped });
    },
    // TODO(week5): onTickTiming -> prom-client histogram (tick duration p99 vs 33 ms budget).
  });

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
    async close() {
      loop.stop();
      stopHeartbeat();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

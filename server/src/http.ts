import type { IncomingMessage, ServerResponse } from "node:http";
import { isRoomMode, type CreateRoomRequest } from "@tanks/shared";
import type { Metrics, StatsWindow } from "./metrics.js";
import type { RoomManager } from "./roomManager.js";

const MAX_BODY_BYTES = 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/**
 * Lobby HTTP API.
 *   GET  /healthz          -> { ok, rooms, players, serverId }
 *   GET  /rooms            -> RoomInfo[]
 *   POST /rooms {mode?, delta?} -> 201 RoomInfo   (mode defaults to "authoritative")
 *   GET  /rooms/:id        -> RoomInfo | 404
 *   GET  /metrics          -> Prometheus text format
 *   GET  /stats            -> ServerStats (rolling window, for the load test)
 */
export function createHttpHandler(manager: RoomManager, metrics: Metrics, stats: StatsWindow) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The Vite dev server runs on another origin, so allow CORS for the lobby API.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "GET" && path === "/healthz") {
        send(res, 200, { ok: true, rooms: manager.roomCount, players: manager.playerCount, serverId: manager.serverId });
        return;
      }
      if (req.method === "GET" && path === "/metrics") {
        res.writeHead(200, { "content-type": metrics.registry.contentType });
        res.end(await metrics.registry.metrics());
        return;
      }
      if (req.method === "GET" && path === "/stats") {
        send(res, 200, stats.snapshot(manager.connectedCount, manager.roomCount));
        return;
      }
      if (path === "/rooms" && req.method === "GET") {
        send(res, 200, manager.list());
        return;
      }
      if (path === "/rooms" && req.method === "POST") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: "invalid JSON body" });
          return;
        }
        const reqBody = (body ?? {}) as CreateRoomRequest;
        const mode = reqBody.mode ?? "authoritative";
        if (!isRoomMode(mode)) {
          send(res, 400, { error: `unknown mode; expected "naive" or "authoritative"` });
          return;
        }
        if (reqBody.delta !== undefined && typeof reqBody.delta !== "boolean") {
          send(res, 400, { error: "delta must be a boolean" });
          return;
        }
        const room = await manager.createRoom(mode, reqBody.delta ?? true);
        send(res, 201, manager.info(room));
        return;
      }
      const m = /^\/rooms\/([A-Za-z0-9]{1,32})$/.exec(path);
      if (m?.[1] && req.method === "GET") {
        const room = manager.getRoom(m[1]);
        if (room) send(res, 200, manager.info(room));
        else send(res, 404, { error: "room not found" });
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: "internal error" });
      throw err;
    }
  };
}

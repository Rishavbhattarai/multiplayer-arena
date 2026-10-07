import { WebSocket, type RawData, type WebSocketServer } from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type ServerMessage,
} from "@tanks/shared";
import type { Logger } from "./log.js";
import type { Room, PlayerConnection } from "./room.js";
import type { RoomManager } from "./roomManager.js";

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

/**
 * WebSocket gateway: owns sockets, decodes frames, routes them to rooms and
 * runs transport-level heartbeats. Rooms never see a socket directly.
 *
 * Returns a function that stops the heartbeat timer.
 */
export function attachGateway(wss: WebSocketServer, manager: RoomManager, log: Logger): () => void {
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws, req) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    let session: { room: Room; playerId: number } | null = null;
    const conn: PlayerConnection = {
      send(msg: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
      },
    };
    const remote = req.socket.remoteAddress;

    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? null : decodeClientMessage(toText(data));
      if (!msg) {
        conn.send({ t: "error", code: "BAD_MESSAGE", message: "malformed or unknown message" });
        return;
      }

      switch (msg.t) {
        case "join": {
          if (session) {
            conn.send({ t: "error", code: "ALREADY_JOINED", message: "socket already joined a room" });
            return;
          }
          if (msg.v !== PROTOCOL_VERSION) {
            conn.send({
              t: "error",
              code: "VERSION_MISMATCH",
              message: `server speaks protocol v${PROTOCOL_VERSION}, client sent v${msg.v}`,
            });
            ws.close(1002, "version mismatch");
            return;
          }
          const room = manager.getRoom(msg.roomId);
          if (!room) {
            conn.send({ t: "error", code: "ROOM_NOT_FOUND", message: `no room ${msg.roomId}` });
            return;
          }
          const result = room.join(msg.name, conn);
          if (!result.ok) {
            conn.send({ t: "error", code: result.code, message: result.message });
            return;
          }
          session = { room, playerId: result.player.id };
          log("info", "player joined", { roomId: room.id, playerId: result.player.id, remote });
          return;
        }
        case "ping":
          conn.send({ t: "pong", id: msg.id, ts: msg.ts, serverTick: session?.room.tick ?? 0 });
          return;
        // YOUR TURN (see YOUR_TURN.md, push 2/3): route "input" messages to the room too.
        case "state":
          if (!session) {
            conn.send({ t: "error", code: "NOT_JOINED", message: "send a join message first" });
            return;
          }
          session.room.handleMessage(session.playerId, msg);
          return;
      }
    });

    ws.on("close", () => {
      if (session && session.room.leave(session.playerId, Date.now())) {
        log("info", "player left", { roomId: session.room.id, playerId: session.playerId });
      }
      session = null;
    });

    ws.on("error", (err) => log("warn", "socket error", { err: err.message, remote }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return () => clearInterval(heartbeat);
}

import { isRoomMode, type RoomMode } from "@tanks/shared";
import type { LossModel, NetSimSettings } from "./netcode/netsim.js";

export interface ClientConfig {
  /** e.g. http://localhost:8080 */
  httpBase: string;
  /** e.g. ws://localhost:8080/ws */
  wsUrl: string;
  /** Mode used when this tab creates a room. Joining uses the room's own mode. */
  mode: RoomMode;
  roomId: string | null;
  netsim: NetSimSettings;
}

function num(params: URLSearchParams, key: string, min: number, max: number): number {
  const v = Number(params.get(key) ?? 0);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
}

/**
 * URL params:
 *   ?mode=naive | authoritative   mode for rooms created from this tab (default authoritative)
 *   ?room=ABC123                  join directly
 *   ?lag=150&jitter=20&loss=5&lossModel=tcp|drop   network simulator
 *   ?server=http://host:port      server override (else VITE_SERVER_URL, else this origin,
 *                                 which the Vite dev server and nginx proxy to the game server)
 */
export function readConfig(loc: Location = window.location): ClientConfig {
  const params = new URLSearchParams(loc.search);
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  const httpBase = (params.get("server") ?? (envUrl || loc.origin)).replace(/\/+$/, "");
  const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws`;
  const rawMode = params.get("mode") ?? "authoritative";
  const mode: RoomMode = rawMode === "final" ? "authoritative" : isRoomMode(rawMode) ? rawMode : "authoritative";
  const room = params.get("room");
  const lossModel: LossModel = params.get("lossModel") === "drop" ? "drop" : "tcp";
  return {
    httpBase,
    wsUrl,
    mode,
    roomId: room ? room.toUpperCase() : null,
    netsim: {
      latencyMs: num(params, "lag", 0, 2000),
      jitterMs: num(params, "jitter", 0, 1000),
      lossPct: num(params, "loss", 0, 50),
      lossModel,
    },
  };
}

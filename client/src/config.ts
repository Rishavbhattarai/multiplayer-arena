import { DEFAULT_SERVER_PORT, isRoomMode, type RoomMode } from "@tanks/shared";

export interface ClientConfig {
  /** e.g. http://localhost:8080 */
  httpBase: string;
  /** e.g. ws://localhost:8080/ws */
  wsUrl: string;
  mode: RoomMode;
  roomId: string | null;
}

/**
 * URL params:
 *   ?mode=naive          Week 1 baseline (default for now; kept for the split-screen demo)
 *   ?mode=authoritative  server-authoritative client (not built yet)
 *   ?room=ABC123         join directly
 *   ?server=http://host:port   override server (else VITE_SERVER_URL, else <this host>:8080)
 */
export function readConfig(loc: Location = window.location): ClientConfig {
  const params = new URLSearchParams(loc.search);
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  const httpBase = (
    params.get("server") ??
    envUrl ??
    `${loc.protocol}//${loc.hostname}:${DEFAULT_SERVER_PORT}`
  ).replace(/\/+$/, "");
  const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws`;
  const rawMode = params.get("mode") ?? "naive";
  // TODO(week3+): flip the default to "authoritative" once prediction lands; keep ?mode=naive working.
  const mode: RoomMode = rawMode === "final" ? "authoritative" : isRoomMode(rawMode) ? rawMode : "naive";
  const room = params.get("room");
  return { httpBase, wsUrl, mode, roomId: room ? room.toUpperCase() : null };
}

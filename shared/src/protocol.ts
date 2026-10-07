/**
 * WebSocket protocol, v1 (JSON text frames).
 *
 * Every message is an object with a string discriminator `t`. Types live here
 * so client, server and bots cannot drift apart. Decoders validate untrusted
 * input and return `null` instead of throwing, so the server never crashes on
 * a malformed frame.
 *
 * Week 5 stretch: a binary codec (MessagePack) can replace encode/decode
 * without touching call sites.
 */
import { MAX_NAME_LENGTH, ROOM_MODES, type RoomMode } from "./constants.js";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** First message on a new socket: join an existing room (created over HTTP). */
export interface JoinMessage {
  t: "join";
  v: number;
  roomId: string;
  name: string;
}

/**
 * NAIVE MODE ONLY (Week 1 baseline). The client simulates itself and reports
 * its own position. The server trusts it, which is exactly the cheating hole
 * the authoritative mode closes.
 */
export interface StateMessage {
  t: "state";
  seq: number;
  x: number;
  y: number;
  angle: number;
}

// YOUR TURN (see YOUR_TURN.md, push 2/3): define InputMessage here (inputs
// only, never positions), add it to ClientMessage and decodeClientMessage.

/** Application-level ping for RTT display (transport pings handle liveness). */
export interface PingMessage {
  t: "ping";
  id: number;
  ts: number;
}

export type ClientMessage = JoinMessage | StateMessage | PingMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  angle: number;
}

export interface WelcomeMessage {
  t: "welcome";
  v: number;
  playerId: number;
  roomId: string;
  mode: RoomMode;
  tick: number;
  tickRate: number;
  /** Where this player spawned. */
  spawn: { x: number; y: number; angle: number };
}

/**
 * Full-state snapshot, broadcast every tick.
 * Week 4: becomes a delta against the client's last acked snapshot.
 */
export interface SnapshotMessage {
  t: "snap";
  tick: number;
  /** Highest client seq the server has processed for the receiving player. */
  ackSeq: number;
  entities: EntitySnapshot[];
}

export interface PongMessage {
  t: "pong";
  id: number;
  ts: number;
  serverTick: number;
}

export const ERROR_CODES = [
  "BAD_MESSAGE",
  "VERSION_MISMATCH",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "NOT_JOINED",
  "ALREADY_JOINED",
  "WRONG_MODE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  t: "error";
  code: ErrorCode;
  message: string;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | PongMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// HTTP lobby API (JSON bodies)
// ---------------------------------------------------------------------------

export interface CreateRoomRequest {
  mode?: RoomMode;
}

export interface RoomInfo {
  roomId: string;
  mode: RoomMode;
  players: number;
  maxPlayers: number;
  serverId: string;
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}
function isString(v: unknown, maxLen: number): v is string {
  return typeof v === "string" && v.length <= maxLen;
}
export function isRoomMode(v: unknown): v is RoomMode {
  return typeof v === "string" && (ROOM_MODES as readonly string[]).includes(v);
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Validate an untrusted frame from a client. Returns a fresh object containing
 * only known fields (extra fields are dropped), or null if invalid.
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
  const m = parse(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "join":
      if (!isNonNegInt(m.v) || !isString(m.roomId, 32) || !isString(m.name, MAX_NAME_LENGTH)) return null;
      return { t: "join", v: m.v, roomId: m.roomId, name: m.name };
    case "state":
      if (!isNonNegInt(m.seq) || !isFiniteNum(m.x) || !isFiniteNum(m.y) || !isFiniteNum(m.angle)) return null;
      return { t: "state", seq: m.seq, x: m.x, y: m.y, angle: m.angle };
    case "ping":
      if (!isNonNegInt(m.id) || !isFiniteNum(m.ts)) return null;
      return { t: "ping", id: m.id, ts: m.ts };
    default:
      return null;
  }
}

function isEntity(v: unknown): v is EntitySnapshot {
  return (
    isObj(v) &&
    isNonNegInt(v.id) &&
    typeof v.name === "string" &&
    isFiniteNum(v.x) &&
    isFiniteNum(v.y) &&
    isFiniteNum(v.angle)
  );
}

/**
 * Decode a frame from the server. The server is trusted more than clients, but
 * a shape check still turns protocol bugs into clear errors instead of NaNs.
 */
export function decodeServerMessage(raw: string): ServerMessage | null {
  const m = parse(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "welcome": {
      const s = m.spawn;
      if (
        !isNonNegInt(m.v) ||
        !isNonNegInt(m.playerId) ||
        typeof m.roomId !== "string" ||
        !isRoomMode(m.mode) ||
        !isNonNegInt(m.tick) ||
        !isFiniteNum(m.tickRate) ||
        !isObj(s) ||
        !isFiniteNum(s.x) ||
        !isFiniteNum(s.y) ||
        !isFiniteNum(s.angle)
      )
        return null;
      return {
        t: "welcome",
        v: m.v,
        playerId: m.playerId,
        roomId: m.roomId,
        mode: m.mode,
        tick: m.tick,
        tickRate: m.tickRate,
        spawn: { x: s.x, y: s.y, angle: s.angle },
      };
    }
    case "snap":
      if (!isNonNegInt(m.tick) || !isNonNegInt(m.ackSeq) || !Array.isArray(m.entities)) return null;
      if (!m.entities.every(isEntity)) return null;
      return { t: "snap", tick: m.tick, ackSeq: m.ackSeq, entities: m.entities };
    case "pong":
      if (!isNonNegInt(m.id) || !isFiniteNum(m.ts) || !isNonNegInt(m.serverTick)) return null;
      return { t: "pong", id: m.id, ts: m.ts, serverTick: m.serverTick };
    case "error":
      if (typeof m.code !== "string" || !(ERROR_CODES as readonly string[]).includes(m.code)) return null;
      if (typeof m.message !== "string") return null;
      return { t: "error", code: m.code as ErrorCode, message: m.message };
    default:
      return null;
  }
}

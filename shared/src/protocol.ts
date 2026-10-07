/**
 * WebSocket protocol, v2 (JSON text frames).
 *
 * Every message is an object with a string discriminator `t`. Types live here
 * so client, server and bots cannot drift apart. Decoders validate untrusted
 * input and return `null` instead of throwing, so the server never crashes on
 * a malformed frame. See docs/adr/0005-encoding.md for why this is JSON.
 */
import { MAX_NAME_LENGTH, ROOM_MODES, type RoomMode } from "./constants.js";
import { ALL_KEYS_MASK } from "./input.js";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** First message on a new socket: join a room (created over HTTP), or resume a dropped tank. */
export interface JoinMessage {
  t: "join";
  v: number;
  roomId: string;
  name: string;
  /** Resume token from a previous `welcome`. Reattaches to the same tank within RECONNECT_GRACE_MS. */
  resume?: string;
}

/**
 * NAIVE MODE ONLY (Week 1 baseline). The client simulates itself and reports
 * its own position. The server trusts it, which is the cheating hole the
 * authoritative mode closes. Authoritative rooms reject it as `client_position`.
 */
export interface StateMessage {
  t: "state";
  seq: number;
  x: number;
  y: number;
  angle: number;
}

/**
 * AUTHORITATIVE MODE. One message per client tick. The client sends only what
 * the player pressed; the server runs stepTank. Never contains a position:
 * any `x`, `y` or `pos` field makes the decoder reject the frame.
 */
export interface InputMessage {
  t: "input";
  /** Strictly increasing per player. Echoed back as `ackSeq` once applied. */
  seq: number;
  /** Key bitmask (see `Key`). */
  keys: number;
  /** Turret aim, world angle in radians. */
  aim: number;
  /** Server tick (fractional) the player was looking at when sending. Used for lag compensation. */
  vt: number;
  /** Newest snapshot tick the client has fully reconstructed. Baseline for delta snapshots. */
  ack: number;
}

/** Application-level ping for RTT display (transport pings handle liveness). */
export interface PingMessage {
  t: "ping";
  id: number;
  ts: number;
}

/** Graceful exit: the tank is removed immediately instead of being kept for reconnect. */
export interface LeaveMessage {
  t: "leave";
}

export type ClientMessage = JoinMessage | StateMessage | InputMessage | PingMessage | LeaveMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  angle: number;
  /** Turret aim (radians). */
  aim: number;
  /** 0 = dead, waiting to respawn. */
  hp: number;
  /** Kills. */
  score: number;
  /** 1 while the player is disconnected and their tank is held for reconnect. */
  dc: 0 | 1;
}

/** A delta entity: `id` plus only the fields that changed since the baseline. */
export type EntityDelta = Pick<EntitySnapshot, "id"> & Partial<Omit<EntitySnapshot, "id">>;

/** A hitscan shot, for drawing tracers. Not part of delta state: sent once, in the tick it happened. */
export interface ShotEvent {
  k: "shot";
  /** Shooter id. */
  id: number;
  x: number;
  y: number;
  /** Direction (radians). */
  a: number;
  /** Tracer length: distance to the hit, or SHOT_RANGE on a miss. */
  len: number;
  /** Id of the tank hit, if any. */
  hit?: number;
  /** True if the hit destroyed the target. */
  kill?: boolean;
}

export type GameEvent = ShotEvent;

export interface WelcomeMessage {
  t: "welcome";
  v: number;
  playerId: number;
  roomId: string;
  mode: RoomMode;
  tick: number;
  tickRate: number;
  /** Where this player's tank is now (spawn point, or current position on resume). */
  spawn: { x: number; y: number; angle: number };
  /** Present this to `join.resume` to get the same tank back after a disconnect. */
  resumeToken: string;
  /** True when this welcome reattached an existing tank. */
  resumed: boolean;
  /** Last input/state seq the server processed. Clients continue from lastSeq + 1. */
  lastSeq: number;
  /** Whether this room sends delta snapshots. */
  delta: boolean;
}

/**
 * Snapshot, sent every tick. Without `base` it is full state. With `base` it
 * contains only entities that changed since snapshot `base` (which the client
 * acked), plus `gone` for entities that no longer exist.
 */
export interface SnapshotMessage {
  t: "snap";
  tick: number;
  base?: number;
  /** Highest client seq the server has processed for the receiving player. */
  ackSeq: number;
  entities: EntityDelta[];
  gone?: number[];
  ev?: GameEvent[];
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
  "RESUME_FAILED",
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
  /** Delta snapshots on/off (authoritative rooms only; default on). Used for bandwidth comparisons. */
  delta?: boolean;
}

export interface RoomInfo {
  roomId: string;
  mode: RoomMode;
  delta: boolean;
  players: number;
  maxPlayers: number;
  serverId: string;
}

/** GET /stats: rolling window used by the load test. */
export interface ServerStats {
  windowSec: number;
  ticksPerSec: number;
  tickP50Ms: number;
  tickP99Ms: number;
  tickMaxMs: number;
  players: number;
  rooms: number;
  bytesOutPerSec: number;
  bytesInPerSec: number;
  overruns: number;
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

/** Fields a client may never send in an input: positions are the server's job. */
const FORBIDDEN_INPUT_FIELDS = ["x", "y", "pos", "angle", "state"];

/**
 * Validate an untrusted frame from a client. Returns a fresh object containing
 * only known fields (extra fields are dropped), or null if invalid.
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
  const m = parse(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "join": {
      if (!isNonNegInt(m.v) || !isString(m.roomId, 32) || !isString(m.name, MAX_NAME_LENGTH)) return null;
      if (m.resume !== undefined && !isString(m.resume, 64)) return null;
      const out: JoinMessage = { t: "join", v: m.v, roomId: m.roomId, name: m.name };
      if (typeof m.resume === "string") out.resume = m.resume;
      return out;
    }
    case "state":
      if (!isNonNegInt(m.seq) || !isFiniteNum(m.x) || !isFiniteNum(m.y) || !isFiniteNum(m.angle)) return null;
      return { t: "state", seq: m.seq, x: m.x, y: m.y, angle: m.angle };
    case "input":
      if (FORBIDDEN_INPUT_FIELDS.some((f) => f in m)) return null;
      if (
        !isNonNegInt(m.seq) ||
        !isNonNegInt(m.keys) ||
        ((m.keys as number) & ~ALL_KEYS_MASK) !== 0 ||
        !isFiniteNum(m.aim) ||
        !isFiniteNum(m.vt) ||
        (m.vt as number) < 0 ||
        !isNonNegInt(m.ack)
      )
        return null;
      return { t: "input", seq: m.seq, keys: m.keys, aim: m.aim, vt: m.vt, ack: m.ack };
    case "ping":
      if (!isNonNegInt(m.id) || !isFiniteNum(m.ts)) return null;
      return { t: "ping", id: m.id, ts: m.ts };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}

const NUM_FIELDS = ["x", "y", "angle", "aim"] as const;
const INT_FIELDS = ["hp", "score"] as const;

function isEntityDelta(v: unknown): v is EntityDelta {
  if (!isObj(v) || !isNonNegInt(v.id)) return false;
  if (v.name !== undefined && typeof v.name !== "string") return false;
  for (const f of NUM_FIELDS) if (v[f] !== undefined && !isFiniteNum(v[f])) return false;
  for (const f of INT_FIELDS) if (v[f] !== undefined && !isNonNegInt(v[f])) return false;
  if (v.dc !== undefined && v.dc !== 0 && v.dc !== 1) return false;
  return true;
}

function isShotEvent(v: unknown): v is ShotEvent {
  return (
    isObj(v) &&
    v.k === "shot" &&
    isNonNegInt(v.id) &&
    isFiniteNum(v.x) &&
    isFiniteNum(v.y) &&
    isFiniteNum(v.a) &&
    isFiniteNum(v.len) &&
    (v.hit === undefined || isNonNegInt(v.hit)) &&
    (v.kill === undefined || typeof v.kill === "boolean")
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
        !isFiniteNum(s.angle) ||
        typeof m.resumeToken !== "string" ||
        typeof m.resumed !== "boolean" ||
        !isNonNegInt(m.lastSeq) ||
        typeof m.delta !== "boolean"
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
        resumeToken: m.resumeToken,
        resumed: m.resumed,
        lastSeq: m.lastSeq,
        delta: m.delta,
      };
    }
    case "snap": {
      if (!isNonNegInt(m.tick) || !isNonNegInt(m.ackSeq) || !Array.isArray(m.entities)) return null;
      if (m.base !== undefined && !isNonNegInt(m.base)) return null;
      if (!m.entities.every(isEntityDelta)) return null;
      if (m.gone !== undefined && !(Array.isArray(m.gone) && m.gone.every(isNonNegInt))) return null;
      if (m.ev !== undefined && !(Array.isArray(m.ev) && m.ev.every(isShotEvent))) return null;
      const out: SnapshotMessage = { t: "snap", tick: m.tick, ackSeq: m.ackSeq, entities: m.entities };
      if (m.base !== undefined) out.base = m.base;
      if (m.gone !== undefined) out.gone = m.gone as number[];
      if (m.ev !== undefined) out.ev = m.ev as GameEvent[];
      return out;
    }
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

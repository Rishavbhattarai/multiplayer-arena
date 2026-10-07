import { randomBytes } from "node:crypto";
import {
  FIRE_COOLDOWN_SLACK_TICKS,
  FIRE_COOLDOWN_TICKS,
  INPUT_BURST,
  Key,
  MAX_INPUT_QUEUE,
  MAX_PLAYERS_PER_ROOM,
  MAX_REWIND_TICKS,
  MAX_SEQ_JUMP,
  MOVE_KEYS_MASK,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  RESPAWN_TICKS,
  SHOT_RANGE,
  TANK_MAX_HP,
  TANK_RADIUS,
  TICK_DT,
  TICK_RATE,
  clamp,
  diffEntities,
  encode,
  normalizeAngle,
  quantize,
  raycastCircle,
  spawnPoint,
  stepTank,
  type EntitySnapshot,
  type ErrorCode,
  type GameEvent,
  type InputMessage,
  type RoomMode,
  type ServerMessage,
  type ShotEvent,
  type StateMessage,
  type TankState,
} from "@tanks/shared";
import { StateHistory } from "./history.js";

export type SendKind = "snap_full" | "snap_delta" | "other";

/** Transport-agnostic handle to one connected client, so rooms are testable without sockets. */
export interface PlayerConnection {
  /** Send an already-encoded frame. */
  sendRaw(data: string, kind: SendKind): void;
}

export function sendMsg(conn: PlayerConnection, msg: ServerMessage): void {
  conn.sendRaw(encode(msg), "other");
}

export const REJECT_REASONS = [
  "client_position",
  "seq_replay",
  "seq_jump",
  "rate_limit",
  "fire_cooldown",
  "malformed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Hooks the room reports through (wired to Prometheus + logs in app.ts). */
export interface RoomEvents {
  onReject?(roomId: string, playerId: number, reason: RejectReason): void;
  onShot?(hit: boolean, rewindTicks: number): void;
  onReconnect?(ok: boolean): void;
}

interface QueuedInput {
  seq: number;
  keys: number;
  aim: number;
  vt: number;
}

export interface Player {
  readonly id: number;
  readonly name: string;
  /** Spawn slot, 0..MAX_PLAYERS_PER_ROOM-1. */
  readonly slot: number;
  readonly token: string;
  /** null while disconnected (tank held for RECONNECT_GRACE_MS). */
  conn: PlayerConnection | null;
  disconnectedAt: number | null;
  state: TankState;
  aim: number;
  hp: number;
  score: number;
  /** Tick at which a dead tank respawns. */
  respawnAt: number | null;
  /** Highest seq processed (applied); echoed back as `ackSeq` in snapshots. */
  lastSeq: number;
  /** Highest seq accepted into the queue (for replay/jump checks). */
  lastReceivedSeq: number;
  inputQueue: QueuedInput[];
  /** Token-bucket credit: inputs that may be applied this tick. */
  credit: number;
  lastFireSeq: number;
  lastFireTick: number;
  /** Newest snapshot tick the client acked (delta baseline), or null to force a full snapshot. */
  snapAck: number | null;
}

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode; message: string };

export interface RoomOptions {
  /** Delta snapshots (authoritative rooms only). Default true. */
  delta?: boolean;
  events?: RoomEvents;
  reconnectGraceMs?: number;
}

export class Room {
  private readonly players = new Map<number, Player>();
  private nextPlayerId = 1;
  private readonly history = new StateHistory();
  private events: GameEvent[] = [];
  private readonly hooks: RoomEvents;
  private readonly graceMs: number;
  readonly delta: boolean;
  /** Server tick counter for this room; advanced only by `step()`. */
  tick = 0;
  /** Timestamp (ms) when the room became empty, or null while occupied. */
  emptySince: number | null;

  constructor(
    readonly id: string,
    readonly mode: RoomMode,
    createdAt: number,
    opts: RoomOptions = {},
  ) {
    this.emptySince = createdAt;
    this.delta = mode === "authoritative" && (opts.delta ?? true);
    this.hooks = opts.events ?? {};
    this.graceMs = opts.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  getPlayer(id: number): Player | undefined {
    return this.players.get(id);
  }

  join(rawName: string, conn: PlayerConnection): JoinResult {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, code: "ROOM_FULL", message: `Room ${this.id} is full (${MAX_PLAYERS_PER_ROOM} players)` };
    }
    const slot = this.freeSlot();
    const id = this.nextPlayerId++;
    const name = rawName.trim() || `tank-${id}`;
    const player: Player = {
      id,
      name,
      slot,
      token: randomBytes(16).toString("base64url"),
      conn,
      disconnectedAt: null,
      state: spawnPoint(slot),
      aim: spawnPoint(slot).angle,
      hp: TANK_MAX_HP,
      score: 0,
      respawnAt: null,
      lastSeq: 0,
      lastReceivedSeq: 0,
      inputQueue: [],
      credit: INPUT_BURST,
      lastFireSeq: -Infinity,
      lastFireTick: -Infinity,
      snapAck: null,
    };
    this.players.set(id, player);
    this.emptySince = null;
    this.sendWelcome(player, false);
    return { ok: true, player };
  }

  /** Reattach a dropped player by resume token. The tank keeps its position, hp and score. */
  resume(token: string, conn: PlayerConnection): JoinResult {
    for (const p of this.players.values()) {
      if (p.token !== token) continue;
      p.conn = conn; // also takes over from a half-open old socket
      p.disconnectedAt = null;
      p.inputQueue.length = 0;
      p.snapAck = null; // client may have lost its snapshot history (page reload): send full state next
      this.hooks.onReconnect?.(true);
      this.sendWelcome(p, true);
      return { ok: true, player: p };
    }
    this.hooks.onReconnect?.(false);
    return { ok: false, code: "RESUME_FAILED", message: "resume token unknown or expired" };
  }

  /**
   * Socket closed. The tank is held for the reconnect grace period. `conn`
   * must be the connection that closed, so a stale socket closing after a
   * resume does not detach the new one.
   */
  disconnect(playerId: number, conn: PlayerConnection, now: number): boolean {
    const p = this.players.get(playerId);
    if (!p || p.conn !== conn) return false;
    p.conn = null;
    p.disconnectedAt = now;
    p.inputQueue.length = 0;
    return true;
  }

  /** Remove a player immediately (graceful leave, or reconnect window expired). */
  remove(playerId: number, now: number): boolean {
    const removed = this.players.delete(playerId);
    if (removed && this.players.size === 0) this.emptySince = now;
    return removed;
  }

  /** Handle a gameplay message from a joined player. */
  handleMessage(playerId: number, msg: StateMessage | InputMessage): void {
    const p = this.players.get(playerId);
    if (!p?.conn) return;

    if (msg.t === "state") {
      if (this.mode !== "naive") {
        this.reject(p, "client_position");
        sendMsg(p.conn, { t: "error", code: "WRONG_MODE", message: "clients may not set positions in authoritative rooms" });
        return;
      }
      // NAIVE MODE: trust the client completely. No speed or bounds checks, so
      // a modified client can teleport. This is intentional: it is the "before"
      // half of the naive-vs-authoritative demo.
      p.state = { x: msg.x, y: msg.y, angle: msg.angle };
      p.lastSeq = Math.max(p.lastSeq, msg.seq);
      return;
    }

    if (this.mode !== "authoritative") {
      sendMsg(p.conn, { t: "error", code: "WRONG_MODE", message: "inputs are only accepted in authoritative rooms" });
      return;
    }

    // Delta baseline ack is useful even if the input itself gets rejected.
    if (msg.ack <= this.tick && (p.snapAck === null || msg.ack > p.snapAck)) p.snapAck = msg.ack;

    // --- validation (anti-cheat) ---
    if (msg.seq <= p.lastReceivedSeq) return this.reject(p, "seq_replay");
    if (msg.seq > p.lastReceivedSeq + MAX_SEQ_JUMP) return this.reject(p, "seq_jump");
    p.lastReceivedSeq = msg.seq;
    if (p.inputQueue.length >= MAX_INPUT_QUEUE) return this.reject(p, "rate_limit");

    p.inputQueue.push({ seq: msg.seq, keys: msg.keys, aim: msg.aim, vt: msg.vt });
  }

  /** Report a validation failure from outside the room (e.g. a frame the decoder rejected). */
  reportMalformed(playerId: number): void {
    const p = this.players.get(playerId);
    if (p) this.reject(p, "malformed");
  }

  /**
   * Advance the room by exactly one fixed tick (TICK_DT seconds) and broadcast
   * snapshots. Called by the server's FixedTimestepLoop at TICK_RATE Hz.
   */
  step(now: number): void {
    this.tick++;
    this.events = [];

    if (this.mode === "authoritative") {
      for (const p of this.players.values()) {
        if (p.respawnAt !== null && this.tick >= p.respawnAt) {
          p.state = spawnPoint(p.slot);
          p.hp = TANK_MAX_HP;
          p.respawnAt = null;
        }
        // Token bucket: +1 credit per tick (capped), 1 credit per applied input.
        p.credit = Math.min(p.credit + 1, INPUT_BURST);
        while (p.credit >= 1 && p.inputQueue.length > 0) {
          const input = p.inputQueue.shift() as QueuedInput;
          p.credit--;
          this.applyInput(p, input);
        }
      }
    }

    for (const p of [...this.players.values()]) {
      if (p.disconnectedAt !== null && now - p.disconnectedAt >= this.graceMs) this.remove(p.id, now);
    }

    const frame = this.history.record(this.tick, this.snapshotEntities());
    this.broadcast(frame.entities);
  }

  private applyInput(p: Player, input: QueuedInput): void {
    p.lastSeq = input.seq;
    p.aim = quantize(normalizeAngle(input.aim));
    if (p.hp <= 0) return;
    // The SAME function the client uses for prediction, so replays match exactly.
    p.state = stepTank(p.state, input.keys & MOVE_KEYS_MASK, TICK_DT);

    if ((input.keys & Key.Fire) === 0) return;
    if (
      input.seq - p.lastFireSeq < FIRE_COOLDOWN_TICKS ||
      this.tick - p.lastFireTick < FIRE_COOLDOWN_TICKS - FIRE_COOLDOWN_SLACK_TICKS
    ) {
      this.reject(p, "fire_cooldown");
      return;
    }
    p.lastFireSeq = input.seq;
    p.lastFireTick = this.tick;
    this.fire(p, input.vt);
  }

  /**
   * Lag-compensated hitscan. Targets are rewound to where the shooter saw them
   * (`vt`, the client's interpolated render tick), clamped to MAX_REWIND_TICKS.
   * The shooter's own position is the current authoritative one.
   */
  private fire(p: Player, vt: number): void {
    const latest = this.history.latestTick;
    const viewTick = clamp(vt, Math.max(0, latest - MAX_REWIND_TICKS), Math.max(0, latest));
    const ox = p.state.x;
    const oy = p.state.y;
    let best: { target: Player; dist: number } | null = null;
    for (const t of this.players.values()) {
      if (t === p || t.hp <= 0 || !t.conn) continue;
      const pos = this.history.positionAt(t.id, viewTick) ?? t.state;
      const d = raycastCircle(ox, oy, p.aim, SHOT_RANGE, pos.x, pos.y, TANK_RADIUS);
      if (d !== null && (!best || d < best.dist)) best = { target: t, dist: d };
    }
    const shot: ShotEvent = { k: "shot", id: p.id, x: ox, y: oy, a: p.aim, len: quantize(best?.dist ?? SHOT_RANGE) };
    if (best) {
      const t = best.target;
      t.hp--;
      shot.hit = t.id;
      if (t.hp <= 0) {
        t.hp = 0;
        t.respawnAt = this.tick + RESPAWN_TICKS;
        p.score++;
        shot.kill = true;
      }
    }
    this.events.push(shot);
    this.hooks.onShot?.(best !== null, latest - viewTick);
  }

  private reject(p: Player, reason: RejectReason): void {
    this.hooks.onReject?.(this.id, p.id, reason);
  }

  snapshotEntities(): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const p of this.players.values()) {
      out.push({
        id: p.id,
        name: p.name,
        x: p.state.x,
        y: p.state.y,
        angle: p.state.angle,
        aim: p.aim,
        hp: p.hp,
        score: p.score,
        dc: p.conn ? 0 : 1,
      });
    }
    return out;
  }

  /**
   * Send each connected player either a full snapshot or a delta against the
   * snapshot they last acked. The entity/event JSON is encoded once per
   * baseline and spliced into each player's message (only ackSeq differs).
   */
  private broadcast(entities: EntitySnapshot[]): void {
    if (this.connectedCount === 0) return;
    const ev = this.events.length > 0 ? `,"ev":${JSON.stringify(this.events)}` : "";
    const cache = new Map<number, string>();
    let fullBody: string | null = null;

    for (const p of this.players.values()) {
      if (!p.conn) continue;
      const base =
        this.delta && p.snapAck !== null && p.snapAck < this.tick ? this.history.get(p.snapAck) : undefined;
      if (base) {
        let body = cache.get(base.tick);
        if (body === undefined) {
          const d = diffEntities(base.byId, entities);
          body = `"entities":${JSON.stringify(d.entities)}${d.gone.length ? `,"gone":${JSON.stringify(d.gone)}` : ""}${ev}}`;
          cache.set(base.tick, body);
        }
        p.conn.sendRaw(`{"t":"snap","tick":${this.tick},"base":${base.tick},"ackSeq":${p.lastSeq},${body}`, "snap_delta");
      } else {
        fullBody ??= `"entities":${JSON.stringify(entities)}${ev}}`;
        p.conn.sendRaw(`{"t":"snap","tick":${this.tick},"ackSeq":${p.lastSeq},${fullBody}`, "snap_full");
      }
    }
  }

  private sendWelcome(p: Player, resumed: boolean): void {
    if (!p.conn) return;
    sendMsg(p.conn, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: p.id,
      roomId: this.id,
      mode: this.mode,
      tick: this.tick,
      tickRate: TICK_RATE,
      spawn: { ...p.state },
      resumeToken: p.token,
      resumed,
      lastSeq: p.lastSeq,
      delta: this.delta,
    });
  }

  private freeSlot(): number {
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.slot);
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) if (!used.has(i)) return i;
    return 0; // unreachable while join() enforces capacity
  }
}

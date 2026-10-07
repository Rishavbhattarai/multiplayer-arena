import {
  MAX_PLAYERS_PER_ROOM,
  PROTOCOL_VERSION,
  TICK_RATE,
  spawnPoint,
  type EntitySnapshot,
  type ErrorCode,
  type RoomMode,
  type ServerMessage,
  type StateMessage,
  type TankState,
} from "@tanks/shared";

/** Transport-agnostic handle to one connected client, so rooms are testable without sockets. */
export interface PlayerConnection {
  send(msg: ServerMessage): void;
}

export interface Player {
  readonly id: number;
  readonly name: string;
  /** Spawn slot, 0..MAX_PLAYERS_PER_ROOM-1. */
  readonly slot: number;
  readonly conn: PlayerConnection;
  /** Current state as the server knows it. */
  state: TankState;
  /** Highest client seq processed; echoed back as `ackSeq` in snapshots. */
  lastSeq: number;
  // YOUR TURN (see YOUR_TURN.md, push 2/3): add a per-player input queue here.
}

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode; message: string };

export class Room {
  private readonly players = new Map<number, Player>();
  private nextPlayerId = 1;
  /** Server tick counter for this room; advanced only by `step()`. */
  tick = 0;
  /** Timestamp (ms) when the room became empty, or null while occupied. */
  emptySince: number | null;

  constructor(
    readonly id: string,
    readonly mode: RoomMode,
    createdAt: number,
  ) {
    this.emptySince = createdAt;
  }

  get playerCount(): number {
    return this.players.size;
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
    const player: Player = { id, name, slot, conn, state: spawnPoint(slot), lastSeq: 0 };
    this.players.set(id, player);
    this.emptySince = null;

    conn.send({
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: id,
      roomId: this.id,
      mode: this.mode,
      tick: this.tick,
      tickRate: TICK_RATE,
      spawn: { ...player.state },
    });
    return { ok: true, player };
  }

  /** Remove a player. Returns true if they were in the room. */
  leave(playerId: number, now: number): boolean {
    const removed = this.players.delete(playerId);
    if (removed && this.players.size === 0) this.emptySince = now;
    // TODO(week4, reconnect): instead of deleting immediately, park the player
    // with a reconnect token for 30 s so they can resume with state intact.
    return removed;
  }

  /** Handle a gameplay message from a joined player. */
  handleMessage(playerId: number, msg: StateMessage): void {
    const p = this.players.get(playerId);
    if (!p) return;

    if (msg.t === "state") {
      if (this.mode !== "naive") {
        p.conn.send({ t: "error", code: "WRONG_MODE", message: "position updates are only accepted in naive rooms" });
        return;
      }
      // NAIVE MODE: trust the client completely. No speed or bounds checks, so
      // a modified client can teleport. This is intentional: it is the "before"
      // half of the naive-vs-final demo.
      p.state = { x: msg.x, y: msg.y, angle: msg.angle };
      p.lastSeq = Math.max(p.lastSeq, msg.seq);
    }
    // YOUR TURN (see YOUR_TURN.md, push 2/3): handle "input" messages in
    // authoritative rooms by queueing them on the player (don't apply here;
    // the tick applies them). Naive rooms should keep rejecting inputs.
  }

  /**
   * Advance the room by exactly one fixed tick (TICK_DT seconds) and broadcast
   * a snapshot. Called by the server's FixedTimestepLoop at TICK_RATE Hz.
   */
  step(): void {
    this.tick++;

    if (this.mode === "authoritative") {
      for (const _p of this.players.values()) {
        // YOUR TURN (see YOUR_TURN.md, push 2/3): apply queued inputs here.
        //   For each input (oldest first): p.state = stepTank(p.state, keys, TICK_DT)
        //   using the SHARED movement function, then p.lastSeq = input.seq so the
        //   snapshot's ackSeq tells the client what was processed.
        //
        // YOUR TURN (see YOUR_TURN.md, push 3/3): validate before applying.
        //   At most one input per player per tick, seq must not go backwards or
        //   jump absurdly, fire cooldowns; log/count each rejection (player_id, reason).
      }
    }

    // TODO(week4): lag compensation needs a short history of past states here
    // (ring buffer of { tick, entities }) to rewind hits to the shooter's view.

    this.broadcastSnapshot();
  }

  snapshotEntities(): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const p of this.players.values()) {
      out.push({ id: p.id, name: p.name, x: p.state.x, y: p.state.y, angle: p.state.angle });
    }
    return out;
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return;
    // TODO(week4): delta snapshots (only what changed since each client's last ack).
    const entities = this.snapshotEntities();
    for (const p of this.players.values()) {
      p.conn.send({ t: "snap", tick: this.tick, ackSeq: p.lastSeq, entities });
    }
  }

  private freeSlot(): number {
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.slot);
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) if (!used.has(i)) return i;
    return 0; // unreachable while join() enforces capacity
  }
}

/**
 * Headless bot client. Speaks the same protocol and uses the same movement
 * code as the browser. One instance = one player.
 */
import { WebSocket } from "ws";
import {
  FIRE_COOLDOWN_TICKS,
  Key,
  PROTOCOL_VERSION,
  SnapshotStore,
  TICK_DT,
  TICK_MS,
  decodeServerMessage,
  encode,
  stepTank,
  type ClientMessage,
  type EntitySnapshot,
  type RoomMode,
  type TankState,
} from "@tanks/shared";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BotStats {
  name: string;
  playerId: number | null;
  connected: boolean;
  snaps: number;
  deltaSnaps: number;
  fullSnaps: number;
  missingBase: number;
  bytesIn: number;
  bytesOut: number;
  sent: number;
  othersSeen: number;
  shots: number;
  hits: number;
  reconnects: number;
  reconnectFailures: number;
  /** After a resume, was our tank exactly where it was before the drop? */
  resumeStateIntact: boolean | null;
  errors: string[];
}

export interface BotOptions {
  wsUrl: string;
  roomId: string;
  mode: RoomMode;
  name: string;
  seed: number;
}

/**
 * Behaviour: every ~0.5-1.5 s pick a new action: idle (30%), drive forward,
 * drive and turn, or reverse. About once a second, aim at a random other tank
 * and fire. Aim only changes when firing, like a player lining up a shot.
 */
export class Bot {
  private ws: WebSocket | null = null;
  private readonly store = new SnapshotStore();
  private world = new Map<number, EntitySnapshot>();
  private readonly rand: () => number;
  private state: TankState | null = null;
  private seq = 0;
  private keys = 0;
  private keysUntil = 0;
  private aim = 0;
  private lastFireSeq = -Infinity;
  private token: string | null = null;
  private latestTick = 0;
  private readonly others = new Set<number>();
  private beforeDrop: { x: number; y: number } | null = null;
  private stopped = false;
  private paused = false;
  readonly stats: BotStats;

  constructor(private readonly opts: BotOptions) {
    this.rand = mulberry32(opts.seed);
    this.stats = {
      name: opts.name,
      playerId: null,
      connected: false,
      snaps: 0,
      deltaSnaps: 0,
      fullSnaps: 0,
      missingBase: 0,
      bytesIn: 0,
      bytesOut: 0,
      sent: 0,
      othersSeen: 0,
      shots: 0,
      hits: 0,
      reconnects: 0,
      reconnectFailures: 0,
      resumeStateIntact: null,
      errors: [],
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.on("open", () => {
        this.send({
          t: "join",
          v: PROTOCOL_VERSION,
          roomId: this.opts.roomId,
          name: this.opts.name,
          ...(this.token ? { resume: this.token } : {}),
        });
      });
      ws.on("message", (data) => {
        const text = data.toString();
        this.stats.bytesIn += text.length;
        const msg = decodeServerMessage(text);
        if (!msg) {
          this.stats.errors.push("undecodable message");
          return;
        }
        if (msg.t === "welcome") {
          if (msg.resumed) {
            this.stats.reconnects++;
            if (this.beforeDrop) {
              this.stats.resumeStateIntact =
                msg.spawn.x === this.beforeDrop.x && msg.spawn.y === this.beforeDrop.y && msg.playerId === this.stats.playerId;
            }
          }
          this.stats.playerId = msg.playerId;
          this.stats.connected = true;
          this.token = msg.resumeToken;
          this.state = { ...msg.spawn };
          this.seq = Math.max(this.seq, msg.lastSeq);
          this.store.clear();
          done();
        } else if (msg.t === "snap") {
          this.stats.snaps++;
          if (msg.base === undefined) this.stats.fullSnaps++;
          else this.stats.deltaSnaps++;
          const w = this.store.apply(msg);
          if (!w) {
            this.stats.missingBase = this.store.missingBase;
            return;
          }
          this.world = w;
          this.latestTick = msg.tick;
          for (const id of w.keys()) if (id !== this.stats.playerId) this.others.add(id);
          this.stats.othersSeen = this.others.size;
          const me = this.stats.playerId === null ? undefined : w.get(this.stats.playerId);
          // Authoritative: track the server's position (bots do not predict).
          if (me && this.opts.mode === "authoritative") this.state = { x: me.x, y: me.y, angle: me.angle };
          for (const ev of msg.ev ?? []) {
            if (ev.id === this.stats.playerId && ev.hit !== undefined) this.stats.hits++;
          }
        } else if (msg.t === "error") {
          if (msg.code === "RESUME_FAILED") this.stats.reconnectFailures++;
          this.stats.errors.push(`${msg.code}: ${msg.message}`);
          done();
        }
      });
      ws.on("error", (err) => {
        this.stats.errors.push(err.message);
        done();
      });
      ws.on("close", () => {
        this.stats.connected = false;
        done();
      });
    });
  }

  private send(m: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = encode(m);
    this.stats.bytesOut += data.length;
    this.stats.sent++;
    this.ws.send(data);
  }

  /** One client tick (call at TICK_RATE). */
  tick(now: number): void {
    if (this.stopped || this.paused || !this.state || !this.stats.connected) return;
    if (now >= this.keysUntil) {
      const r = this.rand();
      this.keys =
        r < 0.3 ? 0 : r < 0.6 ? Key.Up : r < 0.85 ? Key.Up | (this.rand() < 0.5 ? Key.Left : Key.Right) : Key.Down;
      this.keysUntil = now + 500 + this.rand() * 1000;
    }
    const seq = ++this.seq;
    if (this.opts.mode === "naive") {
      this.state = stepTank(this.state, this.keys, TICK_DT);
      this.send({ t: "state", seq, x: this.state.x, y: this.state.y, angle: this.state.angle });
      return;
    }
    let keys = this.keys;
    if (seq - this.lastFireSeq >= FIRE_COOLDOWN_TICKS * 2 && this.rand() < 0.1) {
      const targets = [...this.world.values()].filter((e) => e.id !== this.stats.playerId && e.hp > 0);
      const t = targets[Math.floor(this.rand() * targets.length)];
      if (t) {
        this.aim = Math.atan2(t.y - this.state.y, t.x - this.state.x);
        keys |= Key.Fire;
        this.lastFireSeq = seq;
        this.stats.shots++;
      }
    }
    // Bots render "now" rather than interpolating, so view tick = newest snapshot.
    this.send({ t: "input", seq, keys, aim: this.aim, vt: this.latestTick, ack: this.store.latestTick });
  }

  /**
   * Abruptly close the socket (no leave), wait, then resume with the token.
   * Inputs pause first so the last snapshot shows exactly the position the
   * server holds, which lets us check the tank came back unchanged.
   */
  async dropAndResume(offlineMs = 500): Promise<void> {
    this.paused = true;
    await new Promise((r) => setTimeout(r, 250));
    const me = this.stats.playerId === null ? undefined : this.world.get(this.stats.playerId);
    this.beforeDrop = me ? { x: me.x, y: me.y } : null;
    this.ws?.terminate();
    this.stats.connected = false;
    await new Promise((r) => setTimeout(r, offlineMs));
    await this.connect();
    this.paused = false;
  }

  leave(): void {
    this.stopped = true;
    this.send({ t: "leave" });
    setTimeout(() => this.ws?.close(), 20);
  }

  close(): void {
    this.stopped = true;
    this.ws?.terminate();
  }
}

/** Drive many bots from one interval (one timer per process, not per bot). */
export function runTicker(bots: readonly Bot[]): () => void {
  const timer = setInterval(() => {
    const now = performance.now();
    for (const b of bots) b.tick(now);
  }, TICK_MS);
  return () => clearInterval(timer);
}

export async function createRoom(httpBase: string, mode: RoomMode, delta = true): Promise<string> {
  const res = await fetch(`${httpBase}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, delta }),
  });
  if (!res.ok) throw new Error(`create room failed: HTTP ${res.status}`);
  return ((await res.json()) as { roomId: string }).roomId;
}

export function wsUrlFor(httpBase: string): string {
  return `${httpBase.replace(/^http/, "ws")}/ws`;
}

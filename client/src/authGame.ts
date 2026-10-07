import {
  FIRE_COOLDOWN_TICKS,
  Key,
  MOVE_KEYS_MASK,
  SHOT_RANGE,
  SnapshotStore,
  TICK_MS,
  type EntitySnapshot,
  type ServerMessage,
  type WelcomeMessage,
} from "@tanks/shared";
import type { Game, HudItem } from "./game.js";
import type { Keyboard, Mouse } from "./keyboard.js";
import type { Connection } from "./net.js";
import { Interpolator } from "./netcode/interpolation.js";
import { Predictor } from "./netcode/prediction.js";
import { RateMeter } from "./netcode/rate.js";
import type { Renderer, Tracer } from "./render.js";

/** Corrections larger than this (respawn, server teleport) snap instead of being smoothed. */
const SNAP_THRESHOLD = 80;
/** Visual correction smoothing time constant. */
const SMOOTH_MS = 100;

/**
 * AUTHORITATIVE CLIENT (Weeks 2-4).
 *
 * - Sends only inputs (key bitmask + aim + seq) at 30 Hz. Never positions.
 * - Predicts its own tank with the shared stepTank and reconciles against
 *   each snapshot's ackSeq (replaying unacknowledged inputs).
 * - Draws other tanks INTERP_DELAY_MS in the past, interpolated.
 * - Tells the server which tick it was looking at (`vt`) so hits can be
 *   lag-compensated, and which snapshot it has (`ack`) for delta encoding.
 */
export class AuthoritativeGame implements Game {
  private conn: Connection | null = null;
  private welcome: WelcomeMessage;
  private readonly store = new SnapshotStore();
  private readonly interp = new Interpolator();
  private readonly predictor: Predictor;
  private seq: number;
  private lastFireSeq = -Infinity;
  private world = new Map<number, EntitySnapshot>();
  private self: EntitySnapshot | null = null;
  private tracers: Tracer[] = [];
  private smooth = { x: 0, y: 0 };
  private accumulator = 0;
  private lastFrame: number | null = null;
  private rafId = 0;
  private pingTimer = 0;
  private pingId = 0;
  private rttMs: number | null = null;
  private banner: string | null = null;
  // stats
  private snaps = 0;
  private deltaSnaps = 0;
  private corrections: { at: number; err: number }[] = [];
  private lastCorrection = 0;
  private readonly snapRate = new RateMeter();
  private readonly downRate = new RateMeter();
  private readonly upRate = new RateMeter();

  constructor(
    welcome: WelcomeMessage,
    private readonly keyboard: Keyboard,
    private readonly mouse: Mouse,
    private readonly renderer: Renderer,
    private readonly onHud: (items: HudItem[]) => void,
    private readonly netsimLabel: () => string,
  ) {
    this.welcome = welcome;
    this.predictor = new Predictor(welcome.spawn);
    this.seq = welcome.lastSeq;
  }

  attach(conn: Connection, welcome: WelcomeMessage): void {
    this.conn = conn;
    this.welcome = welcome;
    this.seq = Math.max(this.seq, welcome.lastSeq);
    this.predictor.reset(welcome.spawn);
    this.store.clear(); // server sends a full snapshot after (re)join
    this.interp.reset();
    conn.onMessage((m) => this.onMessage(m));
  }

  detach(): void {
    this.conn = null;
  }

  setBanner(text: string | null): void {
    this.banner = text;
  }

  start(): void {
    this.pingTimer = window.setInterval(() => {
      this.conn?.send({ t: "ping", id: ++this.pingId, ts: performance.now() });
    }, 1000);
    const frame = (now: number) => {
      this.frame(now);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    clearInterval(this.pingTimer);
  }

  private get alive(): boolean {
    return (this.self?.hp ?? 1) > 0;
  }

  private onMessage(msg: ServerMessage): void {
    const now = performance.now();
    switch (msg.t) {
      case "snap": {
        const world = this.store.apply(msg);
        if (!world) break;
        this.snaps++;
        if (msg.base !== undefined) this.deltaSnaps++;
        this.world = world;
        this.interp.push(msg.tick, world, now);
        const me = world.get(this.welcome.playerId);
        if (me) {
          this.self = me;
          const before = { ...this.predictor.state };
          const err = this.predictor.reconcile(me, msg.ackSeq, me.hp > 0);
          this.lastCorrection = err;
          if (err > 0.01) {
            this.corrections.push({ at: now, err });
            if (err < SNAP_THRESHOLD) {
              this.smooth.x += before.x - this.predictor.state.x;
              this.smooth.y += before.y - this.predictor.state.y;
            } else {
              this.smooth = { x: 0, y: 0 };
            }
          }
        }
        for (const ev of msg.ev ?? []) {
          if (ev.id === this.welcome.playerId && !ev.hit) continue; // own misses already drawn locally
          this.tracers.push({ x: ev.x, y: ev.y, a: ev.a, len: ev.len, bornAt: now, hit: ev.hit !== undefined });
        }
        break;
      }
      case "pong":
        this.rttMs = now - msg.ts;
        break;
      case "error":
        console.warn("server error", msg.code, msg.message);
        break;
      case "welcome":
        break;
    }
  }

  private frame(now: number): void {
    if (this.lastFrame === null) this.lastFrame = now;
    const dt = Math.min(now - this.lastFrame, 250);
    this.accumulator += dt;
    this.lastFrame = now;

    const p = this.predictor.state;
    const aim = this.mouse.aimFrom(p.x, p.y, p.angle);

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      if (!this.conn) continue; // disconnected: don't build up unsendable inputs
      let keys = this.keyboard.keys;
      const seq = ++this.seq;
      if (keys & Key.Fire) {
        if (this.alive && seq - this.lastFireSeq >= FIRE_COOLDOWN_TICKS) {
          this.lastFireSeq = seq;
          const s = this.predictor.state;
          this.tracers.push({ x: s.x, y: s.y, a: aim, len: SHOT_RANGE, bornAt: now, hit: false });
        } else {
          keys &= ~Key.Fire; // client-side cooldown so honest clients never trip the server check
        }
      }
      this.predictor.applyLocal(seq, keys & MOVE_KEYS_MASK, this.alive);
      this.conn.send({ t: "input", seq, keys, aim, vt: this.interp.renderTick(now), ack: this.store.latestTick });
    }

    // Decay visual correction offset.
    const k = Math.exp(-dt / SMOOTH_MS);
    this.smooth.x *= k;
    this.smooth.y *= k;

    const remote = this.interp.sample(now);
    const id = this.welcome.playerId;
    const me = this.self;
    const tanks = [...remote.values()]
      .filter((e) => e.id !== id)
      .map((e) => ({ ...e, dc: e.dc === 1, self: false }));
    const s = this.predictor.state;
    tanks.push({
      id,
      name: me?.name ?? "",
      x: s.x + this.smooth.x,
      y: s.y + this.smooth.y,
      angle: s.angle,
      aim,
      hp: me?.hp ?? 3,
      score: me?.score ?? 0,
      dc: false,
      self: true,
    });
    this.tracers = this.tracers.filter((t) => now - t.bornAt < 300);

    this.renderer.draw({
      now,
      tanks,
      tracers: this.tracers,
      serverGhost: me ? { x: me.x, y: me.y, angle: me.angle } : undefined,
      banner: this.banner ?? (me && me.hp <= 0 ? "Destroyed. Respawning..." : undefined),
    });

    this.corrections = this.corrections.filter((c) => c.at > now - 5000);
    const maxCorr = this.corrections.reduce((m, c) => Math.max(m, c.err), 0);
    this.onHud([
      ["mode", "authoritative"],
      ["players", String(this.world.size)],
      ["rtt", this.rttMs === null ? "-" : `${this.rttMs.toFixed(0)} ms`],
      ["snaps/s", this.snapRate.sample(now, this.snaps).toFixed(0)],
      ["delta", this.snaps ? `${Math.round((this.deltaSnaps / this.snaps) * 100)}%` : "-"],
      ["down", `${(this.downRate.sample(now, this.conn?.bytesIn ?? 0) / 1024).toFixed(1)} KB/s`],
      ["up", `${(this.upRate.sample(now, this.conn?.bytesOut ?? 0) / 1024).toFixed(1)} KB/s`],
      ["unacked", String(this.predictor.pendingCount)],
      ["correction 5s max", `${maxCorr.toFixed(1)} px`],
      ["interp buffer", `${this.interp.bufferMs(now).toFixed(0)} ms`],
      ["netsim", this.netsimLabel()],
    ]);
  }

  debug(): Record<string, unknown> {
    const now = performance.now();
    return {
      mode: "authoritative",
      playerId: this.welcome.playerId,
      seq: this.seq,
      snaps: this.snaps,
      deltaSnaps: this.deltaSnaps,
      latestTick: this.store.latestTick,
      pending: this.predictor.pendingCount,
      predicted: { ...this.predictor.state },
      server: this.self ? { x: this.self.x, y: this.self.y, hp: this.self.hp, score: this.self.score } : null,
      lastCorrection: this.lastCorrection,
      maxCorrection5s: this.corrections.filter((c) => c.at > now - 5000).reduce((m, c) => Math.max(m, c.err), 0),
      correctionsOver1px5s: this.corrections.filter((c) => c.at > now - 5000 && c.err > 1).length,
      interpBufferMs: this.interp.bufferMs(now),
      extrapolatedFrames: this.interp.extrapolated,
      starvedFrames: this.interp.starved,
      rttMs: this.rttMs,
      remote: [...this.interp.sample(now).values()]
        .filter((e) => e.id !== this.welcome.playerId)
        .map((e) => ({ id: e.id, x: e.x, y: e.y })),
    };
  }
}

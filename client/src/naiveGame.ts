import {
  SnapshotStore,
  TICK_DT,
  TICK_MS,
  TANK_MAX_HP,
  stepTank,
  type EntitySnapshot,
  type ServerMessage,
  type TankState,
  type WelcomeMessage,
} from "@tanks/shared";
import type { Game, HudItem } from "./game.js";
import type { Keyboard } from "./keyboard.js";
import type { Connection } from "./net.js";
import { RateMeter } from "./netcode/rate.js";
import type { Renderer } from "./render.js";

/**
 * NAIVE CLIENT (Week 1 baseline, kept reachable via naive rooms for the demo).
 *
 * - Moves its own tank locally at a fixed 30 Hz step.
 * - Sends its resulting position to the server every tick ("state" message).
 * - Draws other tanks exactly where the latest snapshot says: no
 *   interpolation, so under latency/jitter they stutter and teleport.
 */
export class NaiveGame implements Game {
  private conn: Connection | null = null;
  private welcome: WelcomeMessage;
  private local: TankState;
  private seq: number;
  private others = new Map<number, EntitySnapshot>();
  private selfName = "";
  private readonly store = new SnapshotStore();
  private accumulator = 0;
  private lastFrame: number | null = null;
  private serverTick = 0;
  private rttMs: number | null = null;
  private pingId = 0;
  private snaps = 0;
  private readonly snapRate = new RateMeter();
  private readonly downRate = new RateMeter();
  private rafId = 0;
  private pingTimer = 0;
  private banner: string | null = null;

  constructor(
    welcome: WelcomeMessage,
    private readonly keyboard: Keyboard,
    private readonly renderer: Renderer,
    private readonly onHud: (items: HudItem[]) => void,
  ) {
    this.welcome = welcome;
    this.local = { ...welcome.spawn };
    this.seq = welcome.lastSeq;
  }

  attach(conn: Connection, welcome: WelcomeMessage): void {
    this.conn = conn;
    this.welcome = welcome;
    this.seq = Math.max(this.seq, welcome.lastSeq);
    if (!welcome.resumed) this.local = { ...welcome.spawn };
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

  debug(): Record<string, unknown> {
    return {
      mode: "naive",
      playerId: this.welcome.playerId,
      serverTick: this.serverTick,
      snaps: this.snaps,
      local: this.local,
      remote: [...this.others.values()].map((e) => ({ id: e.id, x: e.x, y: e.y })),
    };
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "snap": {
        const world = this.store.apply(msg);
        if (!world) break;
        this.serverTick = msg.tick;
        this.snaps++;
        this.others.clear();
        for (const e of world.values()) {
          if (e.id === this.welcome.playerId) this.selfName = e.name;
          else this.others.set(e.id, e);
        }
        break;
      }
      case "pong":
        this.rttMs = performance.now() - msg.ts;
        break;
      case "error":
        console.warn("server error", msg.code, msg.message);
        break;
      case "welcome":
        break;
    }
  }

  /** rAF render loop, decoupled from the fixed 30 Hz simulation step. */
  private frame(now: number): void {
    if (this.lastFrame === null) this.lastFrame = now;
    this.accumulator += Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;

    while (this.accumulator >= TICK_MS) {
      this.local = stepTank(this.local, this.keyboard.keys, TICK_DT);
      this.conn?.send({ t: "state", seq: ++this.seq, x: this.local.x, y: this.local.y, angle: this.local.angle });
      this.accumulator -= TICK_MS;
    }

    const id = this.welcome.playerId;
    this.renderer.draw({
      now,
      tracers: [],
      banner: this.banner ?? undefined,
      tanks: [
        { id, name: this.selfName, ...this.local, aim: this.local.angle, hp: TANK_MAX_HP, score: 0, dc: false, self: true },
        ...[...this.others.values()].map((e) => ({ ...e, aim: e.angle, dc: e.dc === 1, self: false })),
      ],
    });

    this.onHud([
      ["mode", "naive"],
      ["players", String(this.others.size + 1)],
      ["rtt", this.rttMs === null ? "-" : `${this.rttMs.toFixed(0)} ms`],
      ["tick", String(this.serverTick)],
      ["snaps/s", this.snapRate.sample(now, this.snaps).toFixed(0)],
      ["down", `${(this.downRate.sample(now, this.conn?.bytesIn ?? 0) / 1024).toFixed(1)} KB/s`],
    ]);
  }
}

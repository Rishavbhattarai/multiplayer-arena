import {
  TICK_DT,
  TICK_MS,
  stepTank,
  type EntitySnapshot,
  type ServerMessage,
  type TankState,
  type WelcomeMessage,
} from "@tanks/shared";
import type { Keyboard } from "./keyboard.js";
import type { Connection } from "./net.js";
import type { Renderer } from "./render.js";

export interface HudStats {
  roomId: string;
  mode: string;
  players: number;
  rttMs: number | null;
  serverTick: number;
  snapsPerSec: number;
  kbInPerSec: number;
}

/**
 * NAIVE CLIENT (Week 1 baseline, kept reachable via ?mode=naive for the demo).
 *
 * - Moves its own tank locally with the shared stepTank at a fixed 30 Hz step.
 * - Sends its resulting position to the server every tick ("state" message).
 * - Draws other tanks exactly where the latest snapshot says: no
 *   interpolation, so under latency/jitter they stutter and teleport.
 *
 * The final client (Week 2-4) replaces "state" with "input" messages, adds
 * prediction + reconciliation for the local tank and interpolation for others.
 */
export class NaiveGame {
  private local: TankState;
  private seq = 0;
  private others = new Map<number, EntitySnapshot>();
  private selfName = "";
  private accumulator = 0;
  private lastFrame: number | null = null;
  private serverTick: number;
  private rttMs: number | null = null;
  private pingId = 0;
  private snapTimes: number[] = [];
  private bytesWindow: { t: number; bytes: number }[] = [];
  private rafId = 0;
  private pingTimer = 0;

  constructor(
    private readonly net: Connection,
    private readonly welcome: WelcomeMessage,
    private readonly keyboard: Keyboard,
    private readonly renderer: Renderer,
    private readonly onHud: (s: HudStats) => void,
  ) {
    this.local = { ...welcome.spawn };
    this.serverTick = welcome.tick;
    net.onMessage((m) => this.onMessage(m));
  }

  start(): void {
    this.pingTimer = window.setInterval(() => {
      this.net.send({ t: "ping", id: ++this.pingId, ts: performance.now() });
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

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "snap": {
        this.serverTick = msg.tick;
        this.others.clear();
        for (const e of msg.entities) {
          if (e.id === this.welcome.playerId) this.selfName = e.name;
          else this.others.set(e.id, e);
        }
        const now = performance.now();
        this.snapTimes.push(now);
        this.bytesWindow.push({ t: now, bytes: this.net.bytesIn });
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
    // Clamp so a backgrounded tab doesn't fast-forward hundreds of ticks on return.
    this.accumulator += Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;

    while (this.accumulator >= TICK_MS) {
      this.local = stepTank(this.local, this.keyboard.keys, TICK_DT);
      // YOUR TURN (see YOUR_TURN.md, push 2/3): the authoritative client sends an
      // input message (seq + keys + aim) here instead, and the server moves the tank.
      this.net.send({ t: "state", seq: ++this.seq, x: this.local.x, y: this.local.y, angle: this.local.angle });
      this.accumulator -= TICK_MS;
    }

    const tanks = [
      { id: this.welcome.playerId, name: this.selfName, ...this.local, self: true },
      ...[...this.others.values()].map((e) => ({ ...e, self: false })),
    ];
    this.renderer.draw(tanks);
    this.updateHud(now);
  }

  private updateHud(now: number): void {
    const cutoff = now - 1000;
    while (this.snapTimes.length && (this.snapTimes[0] ?? 0) < cutoff) this.snapTimes.shift();
    while (this.bytesWindow.length > 1 && (this.bytesWindow[0]?.t ?? 0) < cutoff) this.bytesWindow.shift();
    const first = this.bytesWindow[0];
    const kbIn = first ? (this.net.bytesIn - first.bytes) / 1024 : 0;
    this.onHud({
      roomId: this.welcome.roomId,
      mode: this.welcome.mode,
      players: this.others.size + 1,
      rttMs: this.rttMs,
      serverTick: this.serverTick,
      snapsPerSec: this.snapTimes.length,
      kbInPerSec: kbIn,
    });
  }
}

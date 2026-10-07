import { INTERP_DELAY_MS, MAX_EXTRAPOLATE_MS, TICK_MS, lerp, lerpAngle, type EntitySnapshot } from "@tanks/shared";

interface Frame {
  tick: number;
  entities: Map<number, EntitySnapshot>;
}

/**
 * Entity interpolation for remote tanks.
 *
 * Remote tanks are drawn INTERP_DELAY_MS in the past, between the two
 * snapshots that bracket that moment, so their motion is smooth even though
 * snapshots arrive in bursts. The server clock is estimated from snapshot
 * arrival times: offset = tick*TICK_MS - arrivalTime, using the largest offset
 * seen recently (the least-delayed packet), eased toward its target so the
 * render clock never jumps.
 */
export class Interpolator {
  private frames: Frame[] = [];
  private samples: { at: number; offset: number }[] = [];
  private offset: number | null = null;
  /** Frames rendered past the newest snapshot (buffer ran dry), extrapolated. */
  extrapolated = 0;
  /** Frames past the extrapolation cap: remote tanks held still. */
  starved = 0;

  constructor(
    private readonly delayMs = INTERP_DELAY_MS,
    private readonly windowMs = 1000,
  ) {}

  push(tick: number, entities: Map<number, EntitySnapshot>, now: number): void {
    const last = this.frames.at(-1);
    if (last && tick <= last.tick) return;
    this.frames.push({ tick, entities });
    if (this.frames.length > 90) this.frames.shift();

    this.samples.push({ at: now, offset: tick * TICK_MS - now });
    while (this.samples.length > 0 && (this.samples[0]?.at ?? 0) < now - this.windowMs) this.samples.shift();
    const target = Math.max(...this.samples.map((s) => s.offset));
    if (this.offset === null || Math.abs(target - this.offset) > 500) this.offset = target;
    else this.offset += (target - this.offset) * 0.1;
  }

  /** Estimated current server tick (fractional). */
  serverTick(now: number): number {
    return this.offset === null ? 0 : (now + this.offset) / TICK_MS;
  }

  /** The (fractional) tick being rendered for remote entities. Sent to the server as `vt`. */
  renderTick(now: number): number {
    return Math.max(0, this.serverTick(now) - this.delayMs / TICK_MS);
  }

  /** How far (ms) the newest snapshot is ahead of the render time. Negative = starving. */
  bufferMs(now: number): number {
    const newest = this.frames.at(-1);
    return newest ? (newest.tick - this.renderTick(now)) * TICK_MS : 0;
  }

  sample(now: number): Map<number, EntitySnapshot> {
    const out = new Map<number, EntitySnapshot>();
    if (this.frames.length === 0) return out;
    const rt = this.renderTick(now);
    let a: Frame | undefined;
    let b: Frame | undefined;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i] as Frame;
      if (f.tick <= rt) {
        a = f;
        b = this.frames[i + 1];
        break;
      }
    }
    if (!a) {
      // Render time is older than everything buffered: show the oldest frame.
      return new Map((this.frames[0] as Frame).entities);
    }
    if (!b) return this.extrapolate(rt);
    const t = (rt - a.tick) / (b.tick - a.tick);
    for (const [id, eb] of b.entities) {
      const ea = a.entities.get(id);
      if (!ea || ea.hp === 0 || eb.hp === 0) {
        out.set(id, t < 0.5 && ea ? ea : eb); // spawn/death/respawn: no sliding across the map
        continue;
      }
      out.set(id, {
        ...eb,
        x: lerp(ea.x, eb.x, t),
        y: lerp(ea.y, eb.y, t),
        angle: lerpAngle(ea.angle, eb.angle, t),
        aim: lerpAngle(ea.aim, eb.aim, t),
      });
    }
    return out;
  }

  /**
   * Past the newest snapshot (e.g. a TCP retransmission stall): continue each
   * tank along its last velocity for up to MAX_EXTRAPOLATE_MS, then hold.
   * When the late snapshots arrive, interpolation resumes from real data.
   */
  private extrapolate(rt: number): Map<number, EntitySnapshot> {
    const newest = this.frames.at(-1) as Frame;
    const prev = this.frames.at(-2);
    const maxTicks = MAX_EXTRAPOLATE_MS / TICK_MS;
    const ahead = rt - newest.tick;
    if (ahead > maxTicks) this.starved++;
    else this.extrapolated++;
    if (!prev) return new Map(newest.entities);
    const k = Math.min(ahead, maxTicks) / (newest.tick - prev.tick);
    const out = new Map<number, EntitySnapshot>();
    for (const [id, e] of newest.entities) {
      const p = prev.entities.get(id);
      if (!p || e.hp === 0 || p.hp === 0) {
        out.set(id, e);
        continue;
      }
      out.set(id, { ...e, x: e.x + (e.x - p.x) * k, y: e.y + (e.y - p.y) * k });
    }
    return out;
  }

  reset(): void {
    this.frames = [];
    this.samples = [];
    this.offset = null;
  }
}

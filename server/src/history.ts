import { HISTORY_TICKS, lerp, type EntitySnapshot } from "@tanks/shared";

export interface HistoryFrame {
  tick: number;
  /** Entity state at the end of `tick` (exactly what snapshot `tick` showed). */
  entities: EntitySnapshot[];
  byId: Map<number, EntitySnapshot>;
}

/**
 * Ring buffer of recent world states. Serves two features:
 * - delta snapshots: the baseline a client acked is looked up here;
 * - lag compensation: hits are judged against where targets were at the
 *   shooter's view tick (interpolated between two frames).
 */
export class StateHistory {
  private readonly frames = new Map<number, HistoryFrame>();
  latestTick = -1;

  constructor(private readonly keep = HISTORY_TICKS) {}

  record(tick: number, entities: EntitySnapshot[]): HistoryFrame {
    const frame: HistoryFrame = { tick, entities, byId: new Map(entities.map((e) => [e.id, e])) };
    this.frames.set(tick, frame);
    this.latestTick = tick;
    this.frames.delete(tick - this.keep);
    return frame;
  }

  get(tick: number): HistoryFrame | undefined {
    return this.frames.get(tick);
  }

  get oldestTick(): number {
    return Math.max(0, this.latestTick - this.keep + 1);
  }

  /**
   * Position of entity `id` at fractional tick `t`, interpolated the same way
   * the client renders remote tanks. Returns undefined if unknown at that time.
   */
  positionAt(id: number, t: number): { x: number; y: number } | undefined {
    const t0 = Math.floor(t);
    const a = this.frames.get(t0)?.byId.get(id);
    const b = this.frames.get(t0 + 1)?.byId.get(id);
    if (a && b) {
      const f = t - t0;
      return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
    }
    const only = a ?? b;
    return only ? { x: only.x, y: only.y } : undefined;
  }
}

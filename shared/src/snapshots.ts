/**
 * Delta snapshot helpers shared by the server (diff) and clients/bots (apply).
 *
 * The server diffs the current entity list against the snapshot the client
 * last acknowledged. The client keeps a short history of reconstructed
 * snapshots so it can apply a delta against whichever baseline the server
 * picked. If the baseline is missing, the delta is skipped and not acked, so
 * the server keeps using an older baseline or falls back to a full snapshot.
 */
import { HISTORY_TICKS } from "./constants.js";
import type { EntityDelta, EntitySnapshot, SnapshotMessage } from "./protocol.js";

const FIELDS = ["name", "x", "y", "angle", "aim", "hp", "score", "dc"] as const;

/** Entities that changed between `base` and `current`, plus ids that disappeared. */
export function diffEntities(
  base: ReadonlyMap<number, EntitySnapshot>,
  current: readonly EntitySnapshot[],
): { entities: EntityDelta[]; gone: number[] } {
  const entities: EntityDelta[] = [];
  const seen = new Set<number>();
  for (const e of current) {
    seen.add(e.id);
    const b = base.get(e.id);
    if (!b) {
      entities.push(e);
      continue;
    }
    let d: EntityDelta | null = null;
    for (const f of FIELDS) {
      if (e[f] !== b[f]) {
        d ??= { id: e.id };
        (d as Record<string, unknown>)[f] = e[f];
      }
    }
    if (d) entities.push(d);
  }
  const gone: number[] = [];
  for (const id of base.keys()) if (!seen.has(id)) gone.push(id);
  return { entities, gone };
}

function isComplete(e: EntityDelta): e is EntitySnapshot {
  return FIELDS.every((f) => e[f] !== undefined);
}

/** Client-side store of reconstructed snapshots, keyed by tick. */
export class SnapshotStore {
  private readonly byTick = new Map<number, Map<number, EntitySnapshot>>();
  /** Newest tick fully reconstructed (0 = none). Sent back as `input.ack`. */
  latestTick = 0;
  /** Count of deltas that could not be applied because their baseline was missing. */
  missingBase = 0;

  constructor(private readonly keep = HISTORY_TICKS) {}

  /**
   * Reconstruct full state from a snapshot message. Returns the full entity
   * map for `msg.tick`, or null if the delta's baseline is unknown or the
   * snapshot is older than one we already have.
   */
  apply(msg: SnapshotMessage): Map<number, EntitySnapshot> | null {
    if (msg.tick <= this.latestTick && this.byTick.has(msg.tick)) return null;
    let next: Map<number, EntitySnapshot>;
    if (msg.base === undefined) {
      next = new Map();
      for (const e of msg.entities) if (isComplete(e)) next.set(e.id, { ...e });
    } else {
      const base = this.byTick.get(msg.base);
      if (!base) {
        this.missingBase++;
        return null;
      }
      next = new Map(base);
      for (const id of msg.gone ?? []) next.delete(id);
      for (const d of msg.entities) {
        const prev = next.get(d.id);
        const merged = { ...prev, ...d };
        if (isComplete(merged)) next.set(d.id, merged);
      }
    }
    this.byTick.set(msg.tick, next);
    if (msg.tick > this.latestTick) this.latestTick = msg.tick;
    for (const t of this.byTick.keys()) if (t <= this.latestTick - this.keep) this.byTick.delete(t);
    return next;
  }

  get(tick: number): Map<number, EntitySnapshot> | undefined {
    return this.byTick.get(tick);
  }

  clear(): void {
    this.byTick.clear();
    this.latestTick = 0;
  }
}

import { describe, expect, it } from "vitest";
import { SnapshotStore, diffEntities, type EntitySnapshot, type SnapshotMessage } from "../src/index.js";

const e = (id: number, x: number, extra: Partial<EntitySnapshot> = {}): EntitySnapshot => ({
  id,
  name: `p${id}`,
  x,
  y: 0,
  angle: 0,
  aim: 0,
  hp: 3,
  score: 0,
  dc: 0,
  ...extra,
});

describe("diffEntities", () => {
  it("emits only changed fields, new entities in full, and removed ids", () => {
    const base = new Map([e(1, 10), e(2, 20), e(3, 30)].map((x) => [x.id, x]));
    const cur = [e(1, 10), e(2, 25, { hp: 2 }), e(4, 40)];
    const d = diffEntities(base, cur);
    expect(d.entities).toEqual([{ id: 2, x: 25, hp: 2 }, e(4, 40)]);
    expect(d.gone).toEqual([3]);
  });
});

describe("SnapshotStore", () => {
  const full: SnapshotMessage = { t: "snap", tick: 10, ackSeq: 0, entities: [e(1, 10), e(2, 20)] };

  it("reconstructs state from a full snapshot followed by deltas", () => {
    const s = new SnapshotStore();
    s.apply(full);
    const w = s.apply({ t: "snap", tick: 11, base: 10, ackSeq: 0, entities: [{ id: 1, x: 11 }], gone: [2] });
    expect(w && [...w.values()]).toEqual([e(1, 11)]);
    expect(s.latestTick).toBe(11);
  });

  it("applies a delta against an older baseline", () => {
    const s = new SnapshotStore();
    s.apply(full);
    s.apply({ t: "snap", tick: 11, base: 10, ackSeq: 0, entities: [{ id: 1, x: 11 }] });
    const w = s.apply({ t: "snap", tick: 12, base: 10, ackSeq: 0, entities: [{ id: 1, x: 12 }] });
    expect(w?.get(1)?.x).toBe(12);
    expect(w?.get(2)?.x).toBe(20);
  });

  it("refuses a delta whose baseline it never saw (and does not ack it)", () => {
    const s = new SnapshotStore();
    s.apply(full);
    expect(s.apply({ t: "snap", tick: 12, base: 11, ackSeq: 0, entities: [] })).toBeNull();
    expect(s.latestTick).toBe(10);
    expect(s.missingBase).toBe(1);
  });

  it("evicts old ticks", () => {
    const s = new SnapshotStore(4);
    s.apply(full);
    for (let t = 11; t <= 20; t++) s.apply({ t: "snap", tick: t, base: t - 1, ackSeq: 0, entities: [] });
    expect(s.get(10)).toBeUndefined();
    expect(s.get(20)).toBeDefined();
  });
});

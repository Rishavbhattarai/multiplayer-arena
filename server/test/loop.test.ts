import { describe, expect, it } from "vitest";
import { TICK_MS } from "@tanks/shared";
import { FixedTimestepLoop } from "../src/loop.js";

describe("FixedTimestepLoop", () => {
  it("runs exactly one tick per elapsed tick interval, carrying the remainder", () => {
    const ticks: number[] = [];
    const loop = new FixedTimestepLoop((t) => ticks.push(t), { tickMs: TICK_MS, now: () => 0 });
    loop.advance(0);
    expect(loop.advance(TICK_MS * 0.5)).toBe(0);
    expect(loop.advance(TICK_MS * 1.2)).toBe(1);
    expect(loop.advance(TICK_MS * 3.1)).toBe(2);
    expect(ticks).toEqual([1, 2, 3]);
  });

  it("averages to TICK_RATE ticks per second under jittery timers", () => {
    let count = 0;
    const loop = new FixedTimestepLoop(() => count++, { tickMs: TICK_MS, now: () => 0 });
    let t = 0;
    loop.advance(t);
    const jitter = [5, 40, 33, 20, 47, 33, 31, 35, 16, 50];
    while (t < 10_000) {
      t += jitter[count % jitter.length] ?? 33;
      loop.advance(t);
    }
    expect(count).toBeGreaterThanOrEqual(299);
    expect(count).toBeLessThanOrEqual(301);
  });

  it("caps catch-up after a stall and reports dropped ticks", () => {
    let dropped = 0;
    let count = 0;
    const loop = new FixedTimestepLoop(() => count++, {
      tickMs: 10,
      maxCatchUpTicks: 3,
      now: () => 0,
      onOverrun: (d) => (dropped += d),
    });
    loop.advance(0);
    expect(loop.advance(100)).toBe(3);
    expect(dropped).toBe(7);
  });
});

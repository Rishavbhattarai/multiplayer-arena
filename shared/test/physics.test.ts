import { describe, expect, it } from "vitest";
import {
  ARENA_WIDTH,
  Key,
  TANK_RADIUS,
  TANK_SPEED,
  TICK_DT,
  simulate,
  spawnPoint,
  stepTank,
  type TankState,
} from "../src/index.js";

/** Small deterministic PRNG (mulberry32) so the "random" input script is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInputs(seed: number, ticks: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let keys = 0;
  for (let i = 0; i < ticks; i++) {
    if (i % 15 === 0) keys = Math.floor(r() * 16); // change direction twice a second
    out.push(keys);
  }
  return out;
}

const start: TankState = { x: 600, y: 400, angle: 0 };

describe("deterministic movement", () => {
  it("same inputs produce the same state (10k ticks)", () => {
    const inputs = randomInputs(1234, 10_000);
    const a = simulate(start, inputs, TICK_DT);
    const b = simulate(start, inputs, TICK_DT);
    expect(a).toEqual(b);
  });

  it("is step-by-step identical, not just at the end", () => {
    const inputs = randomInputs(99, 600);
    let a = start;
    let b = { ...start };
    for (const k of inputs) {
      a = stepTank(a, k, TICK_DT);
      b = stepTank(b, k, TICK_DT);
      expect(a).toEqual(b);
    }
  });

  it("different inputs diverge", () => {
    const a = simulate(start, randomInputs(1, 300), TICK_DT);
    const b = simulate(start, randomInputs(2, 300), TICK_DT);
    expect(a).not.toEqual(b);
  });

  it("does not mutate the input state", () => {
    const s = { ...start };
    stepTank(s, Key.Up | Key.Left, TICK_DT);
    expect(s).toEqual(start);
  });

  it("moves forward at TANK_SPEED along its heading", () => {
    const after1s = simulate(start, Array<number>(30).fill(Key.Up), TICK_DT);
    expect(after1s.x).toBeCloseTo(start.x + TANK_SPEED, 2);
    expect(after1s.y).toBeCloseTo(start.y, 6);
  });

  it("idle input does not move", () => {
    expect(stepTank(start, 0, TICK_DT)).toEqual(start);
  });

  it("is clamped inside the arena", () => {
    const far = simulate(start, Array<number>(600).fill(Key.Up), TICK_DT);
    expect(far.x).toBe(ARENA_WIDTH - TANK_RADIUS);
  });

  it("keeps angle normalized to [-PI, PI)", () => {
    const spun = simulate(start, Array<number>(1000).fill(Key.Right), TICK_DT);
    expect(spun.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(spun.angle).toBeLessThan(Math.PI);
  });

  it("spawn points are deterministic and distinct per slot", () => {
    const pts = Array.from({ length: 8 }, (_, i) => spawnPoint(i));
    expect(pts).toEqual(Array.from({ length: 8 }, (_, i) => spawnPoint(i)));
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(8);
  });
});

describe("geometry helpers", () => {
  it("raycastCircle hits a circle in front and misses one behind or out of range", async () => {
    const { raycastCircle } = await import("../src/index.js");
    expect(raycastCircle(0, 0, 0, 100, 50, 0, 10)).toBeCloseTo(40);
    expect(raycastCircle(0, 0, Math.PI, 100, 50, 0, 10)).toBeNull();
    expect(raycastCircle(0, 0, 0, 30, 50, 0, 10)).toBeNull();
    expect(raycastCircle(0, 0, 0, 100, 50, 11, 10)).toBeNull();
  });

  it("lerpAngle takes the short way around", async () => {
    const { lerpAngle } = await import("../src/index.js");
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(-Math.PI, 5);
  });
});

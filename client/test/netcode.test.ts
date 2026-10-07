import { describe, expect, it } from "vitest";
import { Key, TICK_DT, TICK_MS, simulate, stepTank, type EntitySnapshot } from "@tanks/shared";
import { Interpolator } from "../src/netcode/interpolation.js";
import { NetSimChannel, OrderedDelivery, type NetSimSettings } from "../src/netcode/netsim.js";
import { Predictor } from "../src/netcode/prediction.js";

const ent = (id: number, x: number, y = 0): EntitySnapshot => ({
  id,
  name: "",
  x,
  y,
  angle: 0,
  aim: 0,
  hp: 3,
  score: 0,
  dc: 0,
});

describe("Predictor (prediction + reconciliation)", () => {
  const start = { x: 100, y: 100, angle: 0 };

  it("moves immediately, then a matching server ack causes zero correction", () => {
    const p = new Predictor(start);
    const keys = [Key.Up, Key.Up, Key.Up | Key.Left, Key.Up];
    keys.forEach((k, i) => p.applyLocal(i + 1, k, true));
    const predicted = { ...p.state };
    // Server processed only the first 2 inputs so far.
    const server = simulate(start, keys.slice(0, 2), TICK_DT);
    expect(p.reconcile(server, 2, true)).toBe(0);
    expect(p.state).toEqual(predicted);
    expect(p.pendingCount).toBe(2);
  });

  it("snaps to the server and replays pending inputs when the server disagrees", () => {
    const p = new Predictor(start);
    p.applyLocal(1, Key.Up, true);
    p.applyLocal(2, Key.Up, true);
    // Server says input 1 put us somewhere else (e.g. we were blocked / corrected).
    const corrected = { x: 50, y: 50, angle: 0 };
    const err = p.reconcile(corrected, 1, true);
    expect(err).toBeGreaterThan(0);
    expect(p.state).toEqual(stepTank(corrected, Key.Up, TICK_DT));
  });

  it("does not move while dead", () => {
    const p = new Predictor(start);
    p.applyLocal(1, Key.Up, false);
    expect(p.state).toEqual(start);
  });
});

describe("Interpolator", () => {
  function feed(interp: Interpolator, ticks: number, arrive: (tick: number) => number) {
    for (let t = 1; t <= ticks; t++) interp.push(t, new Map([[1, ent(1, t * 10)]]), arrive(t));
  }

  it("renders INTERP_DELAY_MS behind the estimated server time, between two snapshots", () => {
    const interp = new Interpolator(100);
    feed(interp, 30, (t) => t * TICK_MS + 50); // constant 50 ms one-way delay
    const now = 30 * TICK_MS + 50;
    expect(interp.serverTick(now)).toBeCloseTo(30, 5);
    expect(interp.renderTick(now)).toBeCloseTo(27, 5);
    expect(interp.sample(now).get(1)?.x).toBeCloseTo(270, 5);
    // Halfway between ticks.
    expect(interp.sample(now + TICK_MS / 2).get(1)?.x).toBeCloseTo(275, 5);
  });

  it("stays smooth under jitter (uses the least-delayed packet for the clock)", () => {
    const interp = new Interpolator(100);
    const jitter = [0, 30, 10, 45, 5, 20, 40, 0, 15, 35];
    feed(interp, 60, (t) => t * TICK_MS + 50 + (jitter[t % jitter.length] ?? 0));
    const now = 60 * TICK_MS + 50;
    const xs = [0, 5, 10, 15, 20].map((dt) => interp.sample(now + dt).get(1)?.x ?? 0);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] ?? 0);
    expect(interp.starved).toBe(0);
  });

  it("extrapolates along the last velocity when the buffer runs dry, then holds at the cap", () => {
    const interp = new Interpolator(100);
    feed(interp, 10, (t) => t * TICK_MS); // x = 10 * tick, newest tick 10 (x = 100)
    // Render tick 12 (2 ticks past newest): extrapolated to x = 120.
    expect(interp.sample(10 * TICK_MS + 100 + 2 * TICK_MS).get(1)?.x).toBeCloseTo(120, 5);
    expect(interp.extrapolated).toBe(1);
    // Far past the cap (200 ms = 6 ticks): held at x = 160.
    expect(interp.sample(10 * TICK_MS + 100 + 30 * TICK_MS).get(1)?.x).toBeCloseTo(160, 5);
    expect(interp.starved).toBe(1);
  });
});

describe("NetSimChannel", () => {
  const settings = (s: Partial<NetSimSettings>): (() => NetSimSettings) => () => ({
    latencyMs: 0,
    jitterMs: 0,
    lossPct: 0,
    lossModel: "tcp",
    ...s,
  });

  it("adds half the RTT one way", () => {
    const ch = new NetSimChannel(settings({ latencyMs: 150 }), () => 0.99);
    expect(ch.schedule(1000)).toBe(1075);
  });

  it("tcp loss delays the lost message by an RTO and blocks everything behind it", () => {
    let i = 0;
    const rolls = [0, 0.0, 0, 0.99, 0, 0.99]; // jitter, loss roll per message
    const ch = new NetSimChannel(settings({ latencyMs: 100, lossPct: 5 }), () => rolls[i++] ?? 0.99);
    const first = ch.schedule(0); // lost -> retransmitted
    const second = ch.schedule(10); // not lost, but must wait behind the first
    expect(first).toBe(50 + 200);
    expect(second).toBe(first);
  });

  it("drop loss discards the message", () => {
    const ch = new NetSimChannel(settings({ lossPct: 100, lossModel: "drop" }));
    expect(ch.schedule(0)).toBeNull();
    expect(ch.lost).toBe(1);
  });
});

describe("OrderedDelivery", () => {
  it("never lets a message that is already due overtake an earlier one still waiting", async () => {
    let now = 0;
    const q = new OrderedDelivery(() => now);
    const got: number[] = [];
    q.push(10, () => got.push(1)); // waiting on a timer
    now = 20; // timer is late (event loop busy)...
    q.push(15, () => got.push(2)); // ...this one is due already, but must not jump the queue
    expect(got).toEqual([1, 2]);
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([1, 2]);
  });
});

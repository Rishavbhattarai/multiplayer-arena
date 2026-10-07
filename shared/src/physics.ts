import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  MAX_PLAYERS_PER_ROOM,
  STATE_PRECISION,
  TANK_RADIUS,
  TANK_SPEED,
  TANK_TURN_SPEED,
} from "./constants.js";
import { Key, isDown } from "./input.js";

/** Movement state of one tank. Pure data: safe to copy, compare and serialize. */
export interface TankState {
  x: number;
  y: number;
  /** Hull heading in radians, normalized to [-PI, PI). 0 points along +x. */
  angle: number;
}

const SCALE = 10 ** STATE_PRECISION;

export function quantize(n: number): number {
  // `+ 0` turns -0 into 0 so deep-equality checks are stable.
  return Math.round(n * SCALE) / SCALE + 0;
}

export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  return r - Math.PI;
}

export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/**
 * Advance one tank by `dt` seconds given a key bitmask.
 *
 * Pure and deterministic: the same (state, keys, dt) always returns the same
 * result. The client uses it to move itself; Week 2+ the server will use the
 * exact same function to apply inputs, and Week 3 the client will replay
 * unacknowledged inputs through it during reconciliation.
 */
export function stepTank(state: TankState, keys: number, dt: number): TankState {
  let turn = 0;
  if (isDown(keys, Key.Left)) turn -= 1;
  if (isDown(keys, Key.Right)) turn += 1;

  let thrust = 0;
  if (isDown(keys, Key.Up)) thrust += 1;
  if (isDown(keys, Key.Down)) thrust -= 1;

  const angle = normalizeAngle(state.angle + turn * TANK_TURN_SPEED * dt);
  const dist = thrust * TANK_SPEED * dt;
  const x = clamp(state.x + Math.cos(angle) * dist, TANK_RADIUS, ARENA_WIDTH - TANK_RADIUS);
  const y = clamp(state.y + Math.sin(angle) * dist, TANK_RADIUS, ARENA_HEIGHT - TANK_RADIUS);

  return { x: quantize(x), y: quantize(y), angle: quantize(angle) };
}

/** Run a sequence of per-tick inputs from an initial state. Used by tests and replays. */
export function simulate(initial: TankState, inputs: readonly number[], dt: number): TankState {
  let s = initial;
  for (const keys of inputs) s = stepTank(s, keys, dt);
  return s;
}

/** Deterministic spawn point for a room slot (0..MAX_PLAYERS_PER_ROOM-1). */
export function spawnPoint(slot: number): TankState {
  const i = ((slot % MAX_PLAYERS_PER_ROOM) + MAX_PLAYERS_PER_ROOM) % MAX_PLAYERS_PER_ROOM;
  const cols = 4;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = (ARENA_WIDTH / (cols + 1)) * (col + 1);
  const y = row === 0 ? ARENA_HEIGHT * 0.25 : ARENA_HEIGHT * 0.75;
  // Top row faces down, bottom row faces up.
  const angle = row === 0 ? Math.PI / 2 : -Math.PI / 2;
  return { x: quantize(x), y: quantize(y), angle: quantize(angle) };
}

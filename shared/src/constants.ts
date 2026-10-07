/**
 * Shared constants. Client, server and bots all import from here so the
 * simulation runs with identical numbers everywhere.
 */

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 2;

/** Authoritative simulation rate. See docs/adr/0002-tick-rate.md. */
export const TICK_RATE = 30;
/** Milliseconds per tick (~33.3 ms). This is the server's per-tick CPU budget. */
export const TICK_MS = 1000 / TICK_RATE;
/** Seconds per tick, used as the fixed `dt` for movement. */
export const TICK_DT = 1 / TICK_RATE;

/** Arena size in world units (1 unit = 1 CSS pixel at zoom 1). */
export const ARENA_WIDTH = 1200;
export const ARENA_HEIGHT = 800;

export const TANK_RADIUS = 18;
/** Forward/backward speed, world units per second. */
export const TANK_SPEED = 180;
/** Hull rotation speed, radians per second. */
export const TANK_TURN_SPEED = Math.PI;

/**
 * Positions/angles are rounded to this many decimal places after every step.
 * Keeps state compact on the wire and protects against tiny floating-point
 * drift between JS engines when client and server both run the same code.
 */
export const STATE_PRECISION = 3;

// --- Combat --------------------------------------------------------------

export const TANK_MAX_HP = 3;
/** Minimum input-seq gap between two shots (15 ticks = 2 shots/s). */
export const FIRE_COOLDOWN_TICKS = 15;
/**
 * Server-tick tolerance on the cooldown: inputs can arrive bunched (TCP, jitter)
 * and be applied up to INPUT_BURST-1 ticks "early", so the tick gap may be a
 * little shorter than the seq gap. Worst case for a cheater: one shot per
 * (FIRE_COOLDOWN_TICKS - FIRE_COOLDOWN_SLACK_TICKS) ticks.
 */
export const FIRE_COOLDOWN_SLACK_TICKS = 3;
/** Hitscan range in world units. */
export const SHOT_RANGE = 700;
export const RESPAWN_TICKS = 60;

// --- Netcode -------------------------------------------------------------

/** Remote tanks are drawn this far in the past. See docs/adr/0003-interpolation-delay.md. */
export const INTERP_DELAY_MS = 100;
/** When the interpolation buffer runs dry, remote tanks are extrapolated for at most this long, then held. */
export const MAX_EXTRAPOLATE_MS = 200;
/** Lag compensation never rewinds further than this. See docs/adr/0004-rewind-window.md. */
export const MAX_REWIND_MS = 300;
export const MAX_REWIND_TICKS = Math.ceil(MAX_REWIND_MS / TICK_MS);
/** Server keeps this many past ticks of state (delta baselines + lag compensation). */
export const HISTORY_TICKS = 64;

/**
 * Input rate limiting (token bucket): a player earns one input credit per tick,
 * up to INPUT_BURST, and each applied input spends one. Long-run movement can
 * therefore never exceed one stepTank per tick, i.e. TANK_SPEED. The burst
 * of 10 ticks (333 ms) lets an honest client catch up after a TCP
 * retransmission stall (~230 ms at 150 ms RTT) instead of carrying the
 * backlog as permanent extra latency. The cost: a cheater who stays idle can
 * bank up to 10 ticks of movement and spend it in one tick (60 units), but
 * never more than TANK_SPEED on average.
 */
export const INPUT_BURST = 10;
/** Inputs buffered per player; extra inputs are rejected as `rate_limit`. */
export const MAX_INPUT_QUEUE = 15;
/** An input seq more than this far ahead of the last one is rejected. */
export const MAX_SEQ_JUMP = 300;

export const MAX_PLAYERS_PER_ROOM = 8;
export const MAX_NAME_LENGTH = 16;
/** Max bytes accepted for one WebSocket message from a client. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

export const DEFAULT_SERVER_PORT = 8080;
/** Transport-level ping interval used to detect dead sockets. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** How long an empty room is kept before it is deleted. */
export const EMPTY_ROOM_TTL_MS = 30_000;
/** A dropped player can resume with the same tank for this long. */
export const RECONNECT_GRACE_MS = 30_000;

/** Room modes. `naive` is the Week 1 baseline kept for the split-screen demo. */
export const ROOM_MODES = ["naive", "authoritative"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

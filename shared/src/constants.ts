/**
 * Shared constants. Client, server and bots all import from here so the
 * simulation runs with identical numbers everywhere.
 */

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Authoritative simulation rate. See docs/adr (tick-rate ADR is a Week 2+ candidate). */
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

export const MAX_PLAYERS_PER_ROOM = 8;
export const MAX_NAME_LENGTH = 16;
/** Max bytes accepted for one WebSocket message from a client. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

export const DEFAULT_SERVER_PORT = 8080;
/** Transport-level ping interval used to detect dead sockets. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** How long an empty room is kept before it is deleted. */
export const EMPTY_ROOM_TTL_MS = 30_000;

/** Room modes. `naive` is the Week 1 baseline kept for the split-screen demo. */
export const ROOM_MODES = ["naive", "authoritative"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

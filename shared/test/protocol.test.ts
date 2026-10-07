import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "../src/index.js";

describe("protocol: client messages", () => {
  const valid: ClientMessage[] = [
    { t: "join", v: PROTOCOL_VERSION, roomId: "ABC123", name: "alice" },
    { t: "join", v: PROTOCOL_VERSION, roomId: "ABC123", name: "alice", resume: "tok_123" },
    { t: "state", seq: 7, x: 10.5, y: 20, angle: -1.25 },
    { t: "input", seq: 1, keys: 0b11011, aim: 0.5, vt: 99.25, ack: 98 },
    { t: "ping", id: 3, ts: 1234.5 },
    { t: "leave" },
  ];

  it.each(valid)("round-trips $t", (msg) => {
    expect(decodeClientMessage(encode(msg))).toEqual(msg);
  });

  it("drops unknown extra fields", () => {
    const raw = JSON.stringify({ t: "ping", id: 1, ts: 2, evil: true });
    expect(decodeClientMessage(raw)).toEqual({ t: "ping", id: 1, ts: 2 });
  });

  const input = { t: "input", seq: 1, keys: 1, aim: 0, vt: 0, ack: 0 };
  it.each([
    ["not json", "{nope"],
    ["array", "[]"],
    ["null", "null"],
    ["unknown type", JSON.stringify({ t: "teleport", x: 1 })],
    ["missing field", JSON.stringify({ t: "state", seq: 1, x: 1, y: 2 })],
    ["NaN smuggled as string", JSON.stringify({ t: "state", seq: 1, x: "NaN", y: 2, angle: 0 })],
    ["negative seq", JSON.stringify({ t: "state", seq: -1, x: 1, y: 2, angle: 0 })],
    ["fractional seq", JSON.stringify({ t: "ping", id: 1.5, ts: 0 })],
    ["unknown key bits", JSON.stringify({ ...input, keys: 1 << 10 })],
    ["negative view tick", JSON.stringify({ ...input, vt: -1 })],
    ["input carrying a position (pos)", JSON.stringify({ ...input, pos: { x: 1, y: 1 } })],
    ["input carrying a position (x/y)", JSON.stringify({ ...input, x: 1, y: 1 })],
    ["name too long", JSON.stringify({ t: "join", v: 1, roomId: "A", name: "x".repeat(64) })],
    ["resume token wrong type", JSON.stringify({ t: "join", v: 1, roomId: "A", name: "a", resume: 5 })],
  ])("rejects %s", (_label, raw) => {
    expect(decodeClientMessage(raw)).toBeNull();
  });
});

describe("protocol: server messages", () => {
  const ent = { id: 1, name: "a", x: 1, y: 2, angle: 0, aim: 1, hp: 3, score: 0, dc: 0 as const };
  const valid: ServerMessage[] = [
    {
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: 1,
      roomId: "ABC123",
      mode: "authoritative",
      tick: 42,
      tickRate: 30,
      spawn: { x: 1, y: 2, angle: 3 },
      resumeToken: "tok",
      resumed: false,
      lastSeq: 0,
      delta: true,
    },
    { t: "snap", tick: 5, ackSeq: 4, entities: [ent] },
    { t: "snap", tick: 6, base: 5, ackSeq: 5, entities: [{ id: 1, x: 3 }], gone: [2] },
    { t: "snap", tick: 7, ackSeq: 0, entities: [], ev: [{ k: "shot", id: 1, x: 1, y: 2, a: 0, len: 700 }] },
    { t: "snap", tick: 8, ackSeq: 0, entities: [], ev: [{ k: "shot", id: 1, x: 1, y: 2, a: 0, len: 40, hit: 2, kill: true }] },
    { t: "pong", id: 1, ts: 100, serverTick: 9 },
    { t: "error", code: "RESUME_FAILED", message: "expired" },
  ];

  it.each(valid)("round-trips $t", (msg) => {
    expect(decodeServerMessage(encode(msg))).toEqual(msg);
  });

  it.each([
    ["malformed entity", { t: "snap", tick: 1, ackSeq: 0, entities: [{ x: 1 }] }],
    ["bad dc flag", { t: "snap", tick: 1, ackSeq: 0, entities: [{ id: 1, dc: 2 }] }],
    ["bad event", { t: "snap", tick: 1, ackSeq: 0, entities: [], ev: [{ k: "boom" }] }],
    ["unknown error code", { t: "error", code: "WAT", message: "" }],
  ])("rejects %s", (_l, m) => {
    expect(decodeServerMessage(JSON.stringify(m))).toBeNull();
  });
});

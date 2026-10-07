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
    { t: "state", seq: 7, x: 10.5, y: 20, angle: -1.25 },
    { t: "ping", id: 3, ts: 1234.5 },
  ];

  it.each(valid)("round-trips $t", (msg) => {
    expect(decodeClientMessage(encode(msg))).toEqual(msg);
  });

  it("drops unknown extra fields", () => {
    const raw = JSON.stringify({ t: "ping", id: 1, ts: 2, evil: true });
    expect(decodeClientMessage(raw)).toEqual({ t: "ping", id: 1, ts: 2 });
  });

  it.each([
    ["not json", "{nope"],
    ["array", "[]"],
    ["null", "null"],
    ["unknown type", JSON.stringify({ t: "teleport", x: 1 })],
    ["missing field", JSON.stringify({ t: "state", seq: 1, x: 1, y: 2 })],
    ["NaN smuggled as string", JSON.stringify({ t: "state", seq: 1, x: "NaN", y: 2, angle: 0 })],
    ["negative seq", JSON.stringify({ t: "state", seq: -1, x: 1, y: 2, angle: 0 })],
    ["fractional seq", JSON.stringify({ t: "ping", id: 1.5, ts: 0 })],
    ["input (not part of protocol v1 yet)", JSON.stringify({ t: "input", seq: 1, keys: 1, aim: 0 })],
    ["name too long", JSON.stringify({ t: "join", v: 1, roomId: "A", name: "x".repeat(64) })],
  ])("rejects %s", (_label, raw) => {
    expect(decodeClientMessage(raw)).toBeNull();
  });
});

describe("protocol: server messages", () => {
  const valid: ServerMessage[] = [
    {
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: 1,
      roomId: "ABC123",
      mode: "naive",
      tick: 42,
      tickRate: 30,
      spawn: { x: 1, y: 2, angle: 3 },
    },
    { t: "snap", tick: 5, ackSeq: 4, entities: [{ id: 1, name: "a", x: 1, y: 2, angle: 0 }] },
    { t: "snap", tick: 6, ackSeq: 0, entities: [] },
    { t: "pong", id: 1, ts: 100, serverTick: 9 },
    { t: "error", code: "ROOM_FULL", message: "full" },
  ];

  it.each(valid)("round-trips $t", (msg) => {
    expect(decodeServerMessage(encode(msg))).toEqual(msg);
  });

  it("rejects a snapshot with a malformed entity", () => {
    const raw = JSON.stringify({ t: "snap", tick: 1, ackSeq: 0, entities: [{ id: 1, x: 1 }] });
    expect(decodeServerMessage(raw)).toBeNull();
  });

  it("rejects an unknown error code", () => {
    expect(decodeServerMessage(JSON.stringify({ t: "error", code: "WAT", message: "" }))).toBeNull();
  });
});

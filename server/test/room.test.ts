import { describe, expect, it } from "vitest";
import { MAX_PLAYERS_PER_ROOM, spawnPoint } from "@tanks/shared";
import { Room } from "../src/room.js";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryRoomRegistry } from "../src/roomRegistry.js";
import { FakeConn, joinOk } from "./helpers.js";

describe("Room join/leave", () => {
  it("welcomes a joining player with id, room, mode, spawn and a resume token", () => {
    const room = new Room("ROOM01", "naive", 0);
    const { player, conn } = joinOk(room, "alice");
    expect(room.playerCount).toBe(1);
    const w = conn.last("welcome");
    expect(w).toMatchObject({ playerId: player.id, roomId: "ROOM01", mode: "naive", spawn: spawnPoint(0), resumed: false });
    expect(w?.resumeToken.length).toBeGreaterThan(10);
    expect(room.emptySince).toBeNull();
  });

  it("assigns unique ids and distinct spawn slots", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a").player;
    const b = joinOk(room, "b").player;
    expect(a.id).not.toBe(b.id);
    expect(a.slot).not.toBe(b.slot);
  });

  it("defaults a blank name", () => {
    expect(joinOk(new Room("R", "naive", 0), "   ").player.name).toMatch(/^tank-\d+$/);
  });

  it("rejects joins beyond capacity", () => {
    const room = new Room("R", "naive", 0);
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) joinOk(room, `p${i}`);
    expect(room.join("late", new FakeConn())).toMatchObject({ ok: false, code: "ROOM_FULL" });
  });

  it("remove frees the slot and marks the room empty", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a").player;
    const b = joinOk(room, "b").player;
    expect(room.remove(a.id, 100)).toBe(true);
    expect(room.remove(a.id, 100)).toBe(false);
    const c = joinOk(room, "c").player;
    expect(c.slot).toBe(a.slot);
    room.remove(b.id, 200);
    room.remove(c.id, 300);
    expect(room.emptySince).toBe(300);
  });

  it("removed players no longer appear in snapshots", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.remove(a.player.id, 1);
    room.step(1);
    expect(b.conn.last("snap")?.entities.map((e) => e.id)).toEqual([b.player.id]);
  });
});

describe("Room naive mode", () => {
  it("broadcasts a full snapshot with every player to every player on each step", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.step(0);
    for (const { conn } of [a, b]) {
      const snap = conn.last("snap");
      expect(snap?.tick).toBe(1);
      expect(snap?.base).toBeUndefined();
      expect(snap?.entities).toHaveLength(2);
    }
  });

  it("applies client-reported positions verbatim and acks the seq (the naive trust model)", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.handleMessage(a.player.id, { t: "state", seq: 5, x: 123, y: 456, angle: 1 });
    room.step(0);
    expect(a.conn.last("snap")?.ackSeq).toBe(5);
    expect(b.conn.world.get(a.player.id)).toMatchObject({ x: 123, y: 456, angle: 1 });
  });

  it("rejects inputs in naive rooms", () => {
    const room = new Room("N", "naive", 0);
    const n = joinOk(room, "a");
    room.handleMessage(n.player.id, { t: "input", seq: 1, keys: 1, aim: 0, vt: 0, ack: 0 });
    expect(n.conn.last("error")?.code).toBe("WRONG_MODE");
  });
});

describe("RoomManager", () => {
  it("creates rooms, registers them and reaps them after the empty TTL", async () => {
    let now = 0;
    const registry = new InMemoryRoomRegistry();
    const mgr = new RoomManager({ registry, serverId: "s1", now: () => now, emptyRoomTtlMs: 1000 });
    const room = await mgr.createRoom("naive");
    expect(room.id).toMatch(/^[A-Z2-9]{6}$/);
    expect(await registry.lookup(room.id)).toBe("s1");
    expect(mgr.getRoom(room.id.toLowerCase())).toBe(room);

    const { player } = joinOk(room, "a");
    now = 5000;
    mgr.stepAll();
    expect(mgr.getRoom(room.id)).toBe(room);

    room.remove(player.id, now);
    now += 999;
    mgr.stepAll();
    expect(mgr.getRoom(room.id)).toBe(room);
    now += 1;
    mgr.stepAll();
    expect(mgr.getRoom(room.id)).toBeUndefined();
    expect(await registry.lookup(room.id)).toBeUndefined();
  });

  it("naive rooms never use deltas; authoritative rooms honour the delta flag", async () => {
    const mgr = new RoomManager({ registry: new InMemoryRoomRegistry(), serverId: "s" });
    expect((await mgr.createRoom("naive", true)).delta).toBe(false);
    expect((await mgr.createRoom("authoritative")).delta).toBe(true);
    expect((await mgr.createRoom("authoritative", false)).delta).toBe(false);
  });
});

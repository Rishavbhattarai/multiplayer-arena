import { describe, expect, it } from "vitest";
import { MAX_PLAYERS_PER_ROOM, spawnPoint, type ServerMessage, type SnapshotMessage } from "@tanks/shared";
import { Room, type PlayerConnection } from "../src/room.js";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryRoomRegistry } from "../src/roomRegistry.js";

class FakeConn implements PlayerConnection {
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t).at(-1);
  }
}

function joinOk(room: Room, name: string, conn = new FakeConn()) {
  const r = room.join(name, conn);
  if (!r.ok) throw new Error(`join failed: ${r.code}`);
  return { player: r.player, conn };
}

describe("Room join/leave", () => {
  it("welcomes a joining player with id, room, mode and spawn", () => {
    const room = new Room("ROOM01", "naive", 0);
    const { player, conn } = joinOk(room, "alice");
    expect(room.playerCount).toBe(1);
    expect(conn.last("welcome")).toMatchObject({
      t: "welcome",
      playerId: player.id,
      roomId: "ROOM01",
      mode: "naive",
      spawn: spawnPoint(0),
    });
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
    const room = new Room("R", "naive", 0);
    expect(joinOk(room, "   ").player.name).toMatch(/^tank-\d+$/);
  });

  it("rejects joins beyond capacity", () => {
    const room = new Room("R", "naive", 0);
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) joinOk(room, `p${i}`);
    const r = room.join("late", new FakeConn());
    expect(r).toMatchObject({ ok: false, code: "ROOM_FULL" });
    expect(room.playerCount).toBe(MAX_PLAYERS_PER_ROOM);
  });

  it("leave removes the player, frees the slot and marks the room empty", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a").player;
    const b = joinOk(room, "b").player;
    expect(room.leave(a.id, 100)).toBe(true);
    expect(room.leave(a.id, 100)).toBe(false);
    expect(room.emptySince).toBeNull();
    const c = joinOk(room, "c").player;
    expect(c.slot).toBe(a.slot); // reused slot
    room.leave(b.id, 200);
    room.leave(c.id, 300);
    expect(room.playerCount).toBe(0);
    expect(room.emptySince).toBe(300);
  });

  it("left players no longer appear in snapshots", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.leave(a.player.id, 1);
    room.step();
    const snap = b.conn.last("snap") as SnapshotMessage;
    expect(snap.entities.map((e) => e.id)).toEqual([b.player.id]);
  });
});

describe("Room tick + naive mode", () => {
  it("broadcasts a snapshot with every player to every player on each step", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.step();
    for (const { conn } of [a, b]) {
      const snap = conn.last("snap");
      expect(snap?.tick).toBe(1);
      expect(snap?.entities).toHaveLength(2);
    }
  });

  it("applies client-reported positions verbatim and acks the seq (the naive trust model)", () => {
    const room = new Room("R", "naive", 0);
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.handleMessage(a.player.id, { t: "state", seq: 5, x: 123, y: 456, angle: 1 });
    room.step();
    expect(a.conn.last("snap")?.ackSeq).toBe(5);
    expect(b.conn.last("snap")?.entities.find((e) => e.id === a.player.id)).toMatchObject({ x: 123, y: 456, angle: 1 });
  });

  it("rejects client-reported positions in authoritative rooms", () => {
    const auth = new Room("A", "authoritative", 0);
    const p = joinOk(auth, "a");
    auth.handleMessage(p.player.id, { t: "state", seq: 1, x: 9999, y: 9999, angle: 0 });
    expect(p.conn.last("error")?.code).toBe("WRONG_MODE");
    expect(p.player.state).toEqual(spawnPoint(0));
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
    expect(mgr.getRoom(room.id)).toBe(room); // occupied rooms are kept

    room.leave(player.id, now);
    now += 999;
    mgr.stepAll();
    expect(mgr.getRoom(room.id)).toBe(room);
    now += 1;
    mgr.stepAll();
    expect(mgr.getRoom(room.id)).toBeUndefined();
    expect(await registry.lookup(room.id)).toBeUndefined();
  });
});

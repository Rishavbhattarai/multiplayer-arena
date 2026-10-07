import { describe, expect, it } from "vitest";
import {
  FIRE_COOLDOWN_TICKS,
  INPUT_BURST,
  Key,
  MAX_INPUT_QUEUE,
  MAX_REWIND_TICKS,
  MAX_SEQ_JUMP,
  TANK_MAX_HP,
  TANK_SPEED,
  TICK_DT,
  simulate,
  spawnPoint,
  stepTank,
} from "@tanks/shared";
import { Room } from "../src/room.js";
import { input, joinOk, rejectRecorder } from "./helpers.js";

function authRoom(extra: ConstructorParameters<typeof Room>[3] = {}) {
  const rec = rejectRecorder();
  const room = new Room("A", "authoritative", 0, { events: rec.events, ...extra });
  return { room, rejects: rec.rejects };
}

describe("authoritative movement", () => {
  it("applies inputs with the shared stepTank and acks the seq", () => {
    const { room } = authRoom();
    const { player, conn } = joinOk(room, "a");
    const keys = [Key.Up, Key.Up | Key.Left, Key.Up, Key.Right, 0];
    keys.forEach((k, i) => {
      room.handleMessage(player.id, input(i + 1, k));
      room.step(0);
    });
    expect(player.state).toEqual(simulate(spawnPoint(player.slot), keys, TICK_DT));
    expect(conn.last("snap")?.ackSeq).toBe(5);
  });

  it("matches client prediction exactly: replaying unacked inputs on the acked state gives the predicted state", () => {
    const { room } = authRoom();
    const { player, conn } = joinOk(room, "a");
    const keys = [Key.Up, Key.Up, Key.Left | Key.Up, Key.Up, Key.Right, Key.Down];
    let predicted = spawnPoint(player.slot);
    keys.forEach((k, i) => {
      predicted = stepTank(predicted, k, TICK_DT);
      room.handleMessage(player.id, input(i + 1, k));
      if (i < 3) room.step(0); // server only processed the first 3 so far
    });
    const ackSeq = conn.last("snap")?.ackSeq ?? 0;
    const server = conn.world.get(player.id);
    if (!server) throw new Error("no self entity");
    const replayed = simulate({ x: server.x, y: server.y, angle: server.angle }, keys.slice(ackSeq), TICK_DT);
    expect(replayed).toEqual(predicted);
  });
});

describe("server validation (anti-cheat)", () => {
  it("rejects client-sent positions in authoritative rooms", () => {
    const { room, rejects } = authRoom();
    const { player, conn } = joinOk(room, "a");
    room.handleMessage(player.id, { t: "state", seq: 1, x: 9999, y: 9999, angle: 0 });
    room.step(0);
    expect(rejects).toEqual(["client_position"]);
    expect(conn.last("error")?.code).toBe("WRONG_MODE");
    expect(player.state).toEqual(spawnPoint(0));
  });

  it("rejects replayed and backwards seqs", () => {
    const { room, rejects } = authRoom();
    const { player } = joinOk(room, "a");
    room.handleMessage(player.id, input(5, Key.Up));
    room.handleMessage(player.id, input(5, Key.Up));
    room.handleMessage(player.id, input(3, Key.Up));
    expect(rejects).toEqual(["seq_replay", "seq_replay"]);
    expect(player.inputQueue).toHaveLength(1);
  });

  it("rejects absurd seq jumps", () => {
    const { room, rejects } = authRoom();
    const { player } = joinOk(room, "a");
    room.handleMessage(player.id, input(MAX_SEQ_JUMP + 1, Key.Up));
    expect(rejects).toEqual(["seq_jump"]);
  });

  it("caps movement at one input per tick in the long run (input flooding = no speed hack)", () => {
    const { room, rejects } = authRoom();
    const { player } = joinOk(room, "a");
    const start = { ...player.state };
    // A cheater sends 10 inputs per tick for 30 ticks (1 second).
    let seq = 0;
    for (let t = 0; t < 30; t++) {
      for (let i = 0; i < 10; i++) room.handleMessage(player.id, input(++seq, Key.Up));
      room.step(0);
    }
    const dist = Math.hypot(player.state.x - start.x, player.state.y - start.y);
    // At most 30 ticks + the initial burst worth of movement.
    expect(dist).toBeLessThanOrEqual(TANK_SPEED * TICK_DT * (30 + INPUT_BURST) + 1e-6);
    expect(rejects.filter((r) => r === "rate_limit").length).toBeGreaterThan(200);
  });

  it("keeps at most MAX_INPUT_QUEUE inputs buffered", () => {
    const { room, rejects } = authRoom();
    const { player } = joinOk(room, "a");
    for (let i = 1; i <= MAX_INPUT_QUEUE + 3; i++) room.handleMessage(player.id, input(i, 0));
    expect(player.inputQueue).toHaveLength(MAX_INPUT_QUEUE);
    expect(rejects).toEqual(["rate_limit", "rate_limit", "rate_limit"]);
  });

  it("lets an honest client catch up after a burst (jitter) without rejections", () => {
    const { room, rejects } = authRoom();
    const { player } = joinOk(room, "a");
    room.step(0);
    room.step(0);
    room.step(0); // nothing arrived for 3 ticks...
    for (let i = 1; i <= 4; i++) room.handleMessage(player.id, input(i, Key.Up)); // ...then 4 at once
    room.step(0);
    expect(player.lastSeq).toBe(4);
    expect(rejects).toEqual([]);
  });

  it("enforces the fire cooldown", () => {
    const { room, rejects } = authRoom();
    const { player, conn } = joinOk(room, "a");
    for (let i = 1; i <= 30; i++) {
      room.handleMessage(player.id, input(i, Key.Fire));
      room.step(0);
    }
    const shots = conn.snaps().flatMap((s) => s.ev ?? []).filter((e) => e.id === player.id);
    expect(shots).toHaveLength(Math.ceil(30 / FIRE_COOLDOWN_TICKS));
    expect(rejects.filter((r) => r === "fire_cooldown")).toHaveLength(30 - shots.length);
  });
});

describe("combat + lag compensation", () => {
  /** Shooter at slot 0 (top row), target at slot 1; aim straight at the target. */
  function duel() {
    const { room, rejects } = authRoom({ delta: false });
    const s = joinOk(room, "shooter");
    const t = joinOk(room, "target");
    return { room, rejects, s, t };
  }

  it("a shot aimed at a stationary tank hits and reduces hp", () => {
    const { room, s, t } = duel();
    room.step(0);
    const aim = Math.atan2(t.player.state.y - s.player.state.y, t.player.state.x - s.player.state.x);
    room.handleMessage(s.player.id, input(1, Key.Fire, { aim, vt: room.tick }));
    room.step(0);
    expect(t.player.hp).toBe(TANK_MAX_HP - 1);
    expect(s.conn.last("snap")?.ev?.[0]).toMatchObject({ k: "shot", id: s.player.id, hit: t.player.id });
  });

  /**
   * Target (slot 1, facing down) drives down for 9 ticks. The shooter "saw" it
   * at the tick after its first move and aims there. Returns the shot event.
   */
  function shootAtSeenPosition(viewTick: "seen" | "now" | "ancient") {
    const rewinds: number[] = [];
    const room = new Room("A", "authoritative", 0, { delta: false, events: { onShot: (_h, r) => rewinds.push(r) } });
    const s = joinOk(room, "shooter");
    const t = joinOk(room, "target");
    room.step(0);
    let seenTick = 0;
    let seen = { ...t.player.state };
    for (let i = 1; i <= 9; i++) {
      room.handleMessage(t.player.id, input(i, Key.Up));
      room.step(0);
      if (i === 1) {
        seenTick = room.tick;
        seen = { ...t.player.state };
      }
    }
    const moved = Math.hypot(t.player.state.x - seen.x, t.player.state.y - seen.y);
    const aim = Math.atan2(seen.y - s.player.state.y, seen.x - s.player.state.x);
    const vt = viewTick === "seen" ? seenTick : viewTick === "now" ? room.tick : 0;
    room.handleMessage(s.player.id, input(1, Key.Fire, { aim, vt }));
    room.step(0);
    return { shot: s.conn.last("snap")?.ev?.[0], moved, targetId: t.player.id, rewinds };
  }

  it("judges hits where the shooter saw the target (rewound), not where it is now", () => {
    const rewound = shootAtSeenPosition("seen");
    expect(rewound.moved).toBeGreaterThan(2 * 18); // target moved more than a tank diameter
    expect(rewound.shot?.hit).toBe(rewound.targetId);
    expect(rewound.rewinds[0]).toBe(8);

    const noRewind = shootAtSeenPosition("now");
    expect(noRewind.shot?.hit).toBeUndefined();
  });

  it("clamps the rewind to MAX_REWIND_TICKS", () => {
    const r = shootAtSeenPosition("ancient");
    expect(r.rewinds[0]).toBe(MAX_REWIND_TICKS);
  });

  it("kills after TANK_MAX_HP hits, scores the shooter and respawns the target", () => {
    const { room, s, t } = duel();
    room.step(0);
    const aim = Math.atan2(t.player.state.y - s.player.state.y, t.player.state.x - s.player.state.x);
    let seq = 0;
    for (let shot = 0; shot < TANK_MAX_HP; shot++) {
      room.handleMessage(s.player.id, input(++seq, Key.Fire, { aim, vt: room.tick }));
      room.step(0);
      for (let i = 0; i < FIRE_COOLDOWN_TICKS; i++) {
        room.handleMessage(s.player.id, input(++seq, 0, { aim, vt: room.tick }));
        room.step(0);
      }
    }
    expect(s.player.score).toBe(1);
    expect(t.player.respawnAt).not.toBeNull();
    for (let i = 0; i < 70; i++) room.step(0);
    expect(t.player.hp).toBe(TANK_MAX_HP);
    expect(t.player.state).toEqual(spawnPoint(t.player.slot));
  });
});

describe("delta snapshots", () => {
  it("sends a full snapshot first, then deltas against the acked tick that reconstruct the same state", () => {
    const { room } = authRoom();
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.step(0);
    expect(a.conn.kinds.at(-1)).toBe("snap_full");

    let seq = 0;
    for (let i = 0; i < 20; i++) {
      seq++;
      room.handleMessage(a.player.id, input(seq, Key.Up, { ack: a.conn.store.latestTick }));
      room.handleMessage(b.player.id, input(seq, 0, { ack: b.conn.store.latestTick }));
      room.step(0);
    }
    expect(a.conn.kinds.at(-1)).toBe("snap_delta");
    // Reconstructed state equals the server's truth.
    const truth = new Map(room.snapshotEntities().map((e) => [e.id, e]));
    expect(a.conn.world).toEqual(truth);
    expect(b.conn.world).toEqual(truth);
    // The idle tank (b) is not in a's deltas; the moving tank sends only position fields.
    const last = a.conn.last("snap");
    expect(last?.entities.map((e) => e.id)).toEqual([a.player.id]);
    for (const k of Object.keys(last?.entities[0] ?? {})) expect(["id", "x", "y"]).toContain(k);
  });

  it("is smaller on the wire than full snapshots", () => {
    const run = (delta: boolean) => {
      const { room } = authRoom({ delta });
      const players = Array.from({ length: 8 }, (_, i) => joinOk(room, `p${i}`));
      let seq = 0;
      for (let t = 0; t < 90; t++) {
        seq++;
        players.forEach((p, i) =>
          room.handleMessage(p.player.id, input(seq, i % 2 === 0 ? Key.Up | Key.Left : 0, { ack: p.conn.store.latestTick })),
        );
        room.step(0);
      }
      return players.reduce((n, p) => n + p.conn.bytes, 0);
    };
    expect(run(true)).toBeLessThan(run(false) * 0.6);
  });

  it("removed players are listed in `gone`", () => {
    const { room } = authRoom();
    const a = joinOk(room, "a");
    const b = joinOk(room, "b");
    room.step(0);
    room.handleMessage(a.player.id, input(1, 0, { ack: a.conn.store.latestTick }));
    room.remove(b.player.id, 0);
    room.step(0);
    expect(a.conn.last("snap")?.gone).toEqual([b.player.id]);
    expect([...a.conn.world.keys()]).toEqual([a.player.id]);
  });
});

describe("reconnect", () => {
  it("holds a dropped tank and resumes it with state intact", () => {
    const { room } = authRoom();
    const { player, conn } = joinOk(room, "a");
    for (let i = 1; i <= 10; i++) {
      room.handleMessage(player.id, input(i, Key.Up));
      room.step(0);
    }
    const before = { ...player.state };
    const token = conn.last("welcome")?.resumeToken ?? "";
    room.disconnect(player.id, conn, 1000);
    room.step(5000);
    expect(room.snapshotEntities()[0]).toMatchObject({ dc: 1, x: before.x, y: before.y });

    const conn2 = new (conn.constructor as new () => typeof conn)();
    const r = room.resume(token, conn2);
    expect(r.ok).toBe(true);
    const w = conn2.last("welcome");
    expect(w).toMatchObject({ resumed: true, playerId: player.id, lastSeq: 10, spawn: before });
    room.step(6000);
    expect(conn2.kinds.at(-1)).toBe("snap_full"); // fresh baseline after resume
    expect(conn2.world.get(player.id)).toMatchObject({ dc: 0, x: before.x, y: before.y });
  });

  it("drops the tank after the grace period and rejects late resumes", () => {
    const { room } = authRoom({ reconnectGraceMs: 30_000 });
    const { player, conn } = joinOk(room, "a");
    const token = conn.last("welcome")?.resumeToken ?? "";
    room.disconnect(player.id, conn, 0);
    room.step(29_999);
    expect(room.playerCount).toBe(1);
    room.step(30_000);
    expect(room.playerCount).toBe(0);
    expect(room.resume(token, conn)).toMatchObject({ ok: false, code: "RESUME_FAILED" });
  });

  it("a stale socket closing after a resume does not detach the new connection", () => {
    const { room } = authRoom();
    const { player, conn } = joinOk(room, "a");
    const token = conn.last("welcome")?.resumeToken ?? "";
    const conn2 = new (conn.constructor as new () => typeof conn)();
    room.resume(token, conn2);
    expect(room.disconnect(player.id, conn, 0)).toBe(false);
    expect(player.conn).toBe(conn2);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  Key,
  PROTOCOL_VERSION,
  SnapshotStore,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type EntitySnapshot,
  type RoomInfo,
  type ServerMessage,
  type ServerStats,
} from "@tanks/shared";
import { startApp, type App } from "../src/app.js";
import { silentLogger } from "../src/log.js";

/** Tiny test client that buffers decoded server messages and reconstructs snapshots. */
class TestClient {
  readonly msgs: ServerMessage[] = [];
  readonly store = new SnapshotStore();
  world = new Map<number, EntitySnapshot>();
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = decodeServerMessage(d.toString());
      if (!m) return;
      this.msgs.push(m);
      if (m.t === "snap") {
        const w = this.store.apply(m);
        if (w) this.world = w;
      }
    });
  }
  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    return new TestClient(ws);
  }
  send(m: ClientMessage): void {
    this.ws.send(encode(m));
  }
  async waitFor<T extends ServerMessage["t"]>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    for (;;) {
      const hit = this.msgs.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && pred(m as never));
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  close(): Promise<void> {
    return new Promise((res) => {
      this.ws.once("close", () => res());
      this.ws.close();
    });
  }
}

describe("server end-to-end (HTTP lobby + WebSocket + tick loop)", () => {
  let app: App;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    app = await startApp({ port: 0, host: "127.0.0.1", log: silentLogger });
    base = `http://127.0.0.1:${app.port}`;
    wsUrl = `ws://127.0.0.1:${app.port}/ws`;
  });
  afterAll(async () => {
    await app.close();
  });

  async function createRoom(body: object): Promise<RoomInfo> {
    const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomInfo;
  }

  it("naive room: two clients see each other's reported positions", async () => {
    const room = await createRoom({ mode: "naive" });
    expect(room).toMatchObject({ mode: "naive", delta: false });
    const a = await TestClient.connect(wsUrl);
    const b = await TestClient.connect(wsUrl);
    a.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "a" });
    b.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "b" });
    const wa = await a.waitFor("welcome");
    await b.waitFor("welcome");
    a.send({ t: "state", seq: 1, x: 321, y: 123, angle: 0.5 });
    await b.until(() => b.world.get(wa.playerId)?.x === 321);
    expect(b.world.size).toBe(2);
    a.send({ t: "leave" });
    await b.until(() => b.world.size === 1);
    await b.close();
  });

  it("authoritative room: inputs move the tank on the server, deltas flow, positions are rejected", async () => {
    const room = await createRoom({ mode: "authoritative" });
    const a = await TestClient.connect(wsUrl);
    const b = await TestClient.connect(wsUrl);
    a.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "a" });
    b.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "b" });
    const wa = await a.waitFor("welcome");
    await b.waitFor("welcome");
    await a.until(() => a.store.latestTick > 0);

    for (let seq = 1; seq <= 10; seq++) {
      a.send({ t: "input", seq, keys: Key.Up, aim: 0, vt: a.store.latestTick, ack: a.store.latestTick });
      await new Promise((r) => setTimeout(r, 34));
    }
    await b.until(() => (b.world.get(wa.playerId)?.y ?? 0) > wa.spawn.y + 50);
    await a.waitFor("snap", (s) => s.ackSeq === 10);
    expect(a.msgs.some((m) => m.t === "snap" && m.base !== undefined)).toBe(true);

    a.send({ t: "state", seq: 11, x: 5, y: 5, angle: 0 });
    expect((await a.waitFor("error")).code).toBe("WRONG_MODE");
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/tanks_input_rejections_total\{reason="client_position"\} 1/);

    const stats = (await (await fetch(`${base}/stats`)).json()) as ServerStats;
    expect(stats.ticksPerSec).toBeGreaterThan(20);
    await a.close();
    await b.close();
  });

  it("reconnect: a dropped client resumes the same tank with its token", async () => {
    const room = await createRoom({ mode: "authoritative" });
    const a = await TestClient.connect(wsUrl);
    a.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "a" });
    const w1 = await a.waitFor("welcome");
    a.send({ t: "input", seq: 1, keys: Key.Up, aim: 0, vt: 0, ack: 0 });
    await a.waitFor("snap", (s) => s.ackSeq === 1);
    a.ws.terminate(); // abrupt drop, no "leave"

    const info = (await (await fetch(`${base}/rooms/${room.roomId}`)).json()) as RoomInfo;
    expect(info.players).toBe(1); // tank held

    const a2 = await TestClient.connect(wsUrl);
    a2.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "a", resume: w1.resumeToken });
    const w2 = await a2.waitFor("welcome");
    expect(w2).toMatchObject({ resumed: true, playerId: w1.playerId, lastSeq: 1 });
    expect(w2.spawn.y).toBeGreaterThan(w1.spawn.y);

    const bad = await TestClient.connect(wsUrl);
    bad.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "x", resume: "nope" });
    expect((await bad.waitFor("error")).code).toBe("RESUME_FAILED");
    await a2.close();
    await bad.close();
  });

  it("returns protocol errors for unknown rooms, garbage frames and position-carrying inputs", async () => {
    const c = await TestClient.connect(wsUrl);
    c.send({ t: "join", v: PROTOCOL_VERSION, roomId: "NOPE42", name: "x" });
    expect((await c.waitFor("error")).code).toBe("ROOM_NOT_FOUND");
    c.ws.send("{garbage");
    await c.waitFor("error", (e) => e.code === "BAD_MESSAGE");
    c.ws.send(JSON.stringify({ t: "input", seq: 1, keys: 1, aim: 0, vt: 0, ack: 0, pos: { x: 1, y: 1 } }));
    await c.until(() => c.msgs.filter((m) => m.t === "error" && m.code === "BAD_MESSAGE").length === 2);
    c.send({ t: "state", seq: 1, x: 1, y: 1, angle: 0 });
    await c.waitFor("error", (e) => e.code === "NOT_JOINED");
    await c.close();
  });

  it("rejects an unknown room mode or a bad delta flag", async () => {
    expect((await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ mode: "godmode" }) })).status).toBe(400);
    expect((await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ delta: "yes" }) })).status).toBe(400);
  });
});

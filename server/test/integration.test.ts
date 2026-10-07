import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type RoomInfo,
  type ServerMessage,
} from "@tanks/shared";
import { startApp, type App } from "../src/app.js";
import { silentLogger } from "../src/log.js";

/** Tiny test client that buffers decoded server messages. */
class TestClient {
  readonly msgs: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = decodeServerMessage(d.toString());
      if (m) this.msgs.push(m);
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
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const start = Date.now();
    for (;;) {
      const hit = this.msgs.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && pred(m as never));
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 10));
    }
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

  it("creates a room over HTTP and two clients see each other move", async () => {
    const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ mode: "naive" }) });
    expect(res.status).toBe(201);
    const room = (await res.json()) as RoomInfo;
    expect(room.mode).toBe("naive");

    const a = await TestClient.connect(wsUrl);
    const b = await TestClient.connect(wsUrl);
    a.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "a" });
    b.send({ t: "join", v: PROTOCOL_VERSION, roomId: room.roomId, name: "b" });
    const wa = await a.waitFor("welcome");
    await b.waitFor("welcome");

    a.send({ t: "state", seq: 1, x: 321, y: 123, angle: 0.5 });
    const snap = await b.waitFor("snap", (s) => s.entities.some((e) => e.id === wa.playerId && e.x === 321));
    expect(snap.entities).toHaveLength(2);

    const info = (await (await fetch(`${base}/rooms/${room.roomId}`)).json()) as RoomInfo;
    expect(info.players).toBe(2);

    a.ws.close();
    await b.waitFor("snap", (s) => s.entities.length === 1);
    b.ws.close();
  });

  it("returns protocol errors for unknown rooms and garbage frames", async () => {
    const c = await TestClient.connect(wsUrl);
    c.send({ t: "join", v: PROTOCOL_VERSION, roomId: "NOPE42", name: "x" });
    expect((await c.waitFor("error")).code).toBe("ROOM_NOT_FOUND");
    c.ws.send("{garbage");
    await c.waitFor("error", (e) => e.code === "BAD_MESSAGE");
    c.send({ t: "state", seq: 1, x: 1, y: 1, angle: 0 });
    await c.waitFor("error", (e) => e.code === "NOT_JOINED");
    c.ws.close();
  });

  it("rejects an unknown room mode", async () => {
    const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ mode: "godmode" }) });
    expect(res.status).toBe(400);
  });
});

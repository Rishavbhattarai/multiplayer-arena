import { PROTOCOL_VERSION, RECONNECT_GRACE_MS, type WelcomeMessage } from "@tanks/shared";
import type { Game } from "./game.js";
import { Connection } from "./net.js";
import type { NetSimSettings } from "./netcode/netsim.js";

export class JoinError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Open a socket and join (or resume). Resolves with the connection and the welcome. */
export async function connectAndJoin(
  wsUrl: string,
  roomId: string,
  name: string,
  resume: string | null,
  sim: () => NetSimSettings,
): Promise<{ conn: Connection; welcome: WelcomeMessage }> {
  const conn = await Connection.open(wsUrl, sim);
  try {
    const welcome = await new Promise<WelcomeMessage>((resolve, reject) => {
      conn.onMessage((m) => {
        if (m.t === "welcome") resolve(m);
        else if (m.t === "error") reject(new JoinError(m.code, `${m.code}: ${m.message}`));
      });
      conn.onClose(() => reject(new JoinError("CLOSED", "connection closed")));
      conn.send({ t: "join", v: PROTOCOL_VERSION, roomId, name, ...(resume ? { resume } : {}) });
    });
    return { conn, welcome };
  } catch (err) {
    conn.close();
    throw err;
  }
}

const tokenKey = (roomId: string) => `tanks.resume.${roomId}`;

export function loadToken(roomId: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(roomId));
  } catch {
    return null;
  }
}

export function saveToken(roomId: string, token: string | null): void {
  try {
    if (token) sessionStorage.setItem(tokenKey(roomId), token);
    else sessionStorage.removeItem(tokenKey(roomId));
  } catch {
    /* storage unavailable: reconnect still works within this page */
  }
}

/**
 * Keeps a game connected. If the socket drops, it retries with the resume
 * token (backoff 0.5 s .. 4 s) until RECONNECT_GRACE_MS runs out.
 */
export class Session {
  private conn: Connection | null = null;
  private token: string;
  private leaving = false;
  reconnects = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly roomId: string,
    private readonly name: string,
    private readonly sim: () => NetSimSettings,
    private readonly game: Game,
    first: { conn: Connection; welcome: WelcomeMessage },
    private readonly onFatal: (msg: string) => void,
  ) {
    this.token = first.welcome.resumeToken;
    saveToken(roomId, this.token);
    this.bind(first.conn, first.welcome);
  }

  private bind(conn: Connection, welcome: WelcomeMessage): void {
    this.conn = conn;
    this.token = welcome.resumeToken;
    this.game.attach(conn, welcome);
    this.game.setBanner(null);
    conn.onClose(() => {
      if (this.leaving || conn !== this.conn) return;
      this.game.detach();
      void this.reconnect();
    });
  }

  /** Simulate a network drop (used by the "drop connection" button and tests). */
  dropConnection(): void {
    this.conn?.close();
    this.conn = null;
    this.game.detach();
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const deadline = performance.now() + RECONNECT_GRACE_MS;
    let delay = 500;
    while (!this.leaving && performance.now() < deadline) {
      const left = Math.ceil((deadline - performance.now()) / 1000);
      this.game.setBanner(`Connection lost. Reconnecting... (${left}s left)`);
      await new Promise((r) => setTimeout(r, delay));
      try {
        const r = await connectAndJoin(this.wsUrl, this.roomId, this.name, this.token, this.sim);
        this.reconnects++;
        this.bind(r.conn, r.welcome);
        return;
      } catch (err) {
        if (err instanceof JoinError && (err.code === "RESUME_FAILED" || err.code === "ROOM_NOT_FOUND")) {
          saveToken(this.roomId, null);
          this.game.setBanner("Your tank expired. Reload to join again.");
          this.onFatal(err.message);
          return;
        }
        delay = Math.min(delay * 2, 4000);
      }
    }
    if (!this.leaving) {
      saveToken(this.roomId, null);
      this.game.setBanner("Could not reconnect within 30 s. Reload to join again.");
    }
  }

  leave(): void {
    this.leaving = true;
    saveToken(this.roomId, null);
    this.conn?.send({ t: "leave" });
    setTimeout(() => this.conn?.close(), 50);
  }
}

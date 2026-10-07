import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from "@tanks/shared";

/**
 * Thin wrapper over the browser WebSocket using the shared codec.
 *
 * TODO(week3): the network simulator (added latency, jitter, packet loss)
 * belongs here: delay/drop frames in send() and in the message handler.
 */
export class Connection {
  private handlers: ((msg: ServerMessage) => void)[] = [];
  private closeHandlers: ((ev: CloseEvent) => void)[] = [];
  bytesIn = 0;
  bytesOut = 0;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      this.bytesIn += ev.data.length;
      const msg = decodeServerMessage(ev.data);
      if (!msg) {
        console.warn("dropping malformed server message", ev.data);
        return;
      }
      for (const h of this.handlers) h(msg);
    });
    ws.addEventListener("close", (ev) => {
      for (const h of this.closeHandlers) h(ev);
    });
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Connection(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  onMessage(h: (msg: ServerMessage) => void): void {
    this.handlers.push(h);
  }

  onClose(h: (ev: CloseEvent) => void): void {
    this.closeHandlers.push(h);
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const data = encode(msg);
    this.bytesOut += data.length;
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from "@tanks/shared";
import { NetSimChannel, OrderedDelivery, type NetSimSettings } from "./netcode/netsim.js";

/**
 * Thin wrapper over the browser WebSocket using the shared codec. Every
 * message in both directions passes through the network simulator.
 */
export class Connection {
  private handlers: ((msg: ServerMessage) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private readonly up: NetSimChannel;
  private readonly down: NetSimChannel;
  private readonly upQueue = new OrderedDelivery();
  private readonly downQueue = new OrderedDelivery();
  /** Real bytes on the socket (before simulated loss/delay). */
  bytesIn = 0;
  bytesOut = 0;
  closedByUs = false;

  private constructor(
    private readonly ws: WebSocket,
    sim: () => NetSimSettings,
  ) {
    this.up = new NetSimChannel(sim);
    this.down = new NetSimChannel(sim);
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      const data = ev.data;
      this.bytesIn += data.length;
      this.deliver(this.down, this.downQueue, () => {
        const msg = decodeServerMessage(data);
        if (!msg) {
          console.warn("dropping malformed server message", data);
          return;
        }
        for (const h of this.handlers) h(msg);
      });
    });
    ws.addEventListener("close", () => {
      for (const h of this.closeHandlers) h();
    });
  }

  static open(url: string, sim: () => NetSimSettings): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Connection(ws, sim)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  private deliver(ch: NetSimChannel, q: OrderedDelivery, fn: () => void): void {
    const at = ch.schedule(performance.now());
    if (at === null) return; // simulated drop
    q.push(at, fn);
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  onMessage(h: (msg: ServerMessage) => void): void {
    this.handlers.push(h);
  }

  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }

  send(msg: ClientMessage): void {
    const data = encode(msg);
    this.deliver(this.up, this.upQueue, () => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.bytesOut += data.length;
      this.ws.send(data);
    });
  }

  close(): void {
    this.closedByUs = true;
    this.handlers = [];
    this.ws.close();
  }
}

/**
 * In-client network simulator: added latency, jitter and packet loss, applied
 * to every message in both directions.
 *
 * WebSockets run over TCP, so a lost packet is not skipped: it is
 * retransmitted after a timeout and everything behind it waits (head-of-line
 * blocking). The default `tcp` loss model simulates exactly that. The `drop`
 * model discards the message instead, which is what UDP/WebRTC would do; it
 * exists for comparison only (see docs/adr/0001).
 */
export type LossModel = "tcp" | "drop";

export interface NetSimSettings {
  /** Added round-trip time in ms (split evenly between the two directions). */
  latencyMs: number;
  /** Extra random one-way delay, uniform in [0, jitterMs]. */
  jitterMs: number;
  /** Percent of messages lost (0-100). */
  lossPct: number;
  lossModel: LossModel;
}

/** Linux's minimum retransmission timeout. */
export const MIN_RTO_MS = 200;

export function isActive(s: NetSimSettings): boolean {
  return s.latencyMs > 0 || s.jitterMs > 0 || s.lossPct > 0;
}

/** One direction of a simulated link. Delivery is in order, like TCP. */
export class NetSimChannel {
  private lastDeliverAt = 0;
  lost = 0;
  delivered = 0;

  constructor(
    private readonly settings: () => NetSimSettings,
    private readonly rand: () => number = Math.random,
  ) {}

  /** Time (ms) at which a message sent at `now` is delivered, or null if dropped. */
  schedule(now: number): number | null {
    const s = this.settings();
    if (!isActive(s)) {
      this.lastDeliverAt = Math.max(this.lastDeliverAt, now);
      this.delivered++;
      return Math.max(now, this.lastDeliverAt);
    }
    let delay = s.latencyMs / 2 + this.rand() * s.jitterMs;
    if (this.rand() * 100 < s.lossPct) {
      this.lost++;
      if (s.lossModel === "drop") return null;
      // Retransmission after an RTO (>= 200 ms), then another one-way trip.
      const rto = Math.max(MIN_RTO_MS, s.latencyMs + 4 * s.jitterMs);
      delay += rto;
    }
    // In-order delivery: nothing overtakes a delayed message (head-of-line blocking).
    const at = Math.max(now + delay, this.lastDeliverAt);
    this.lastDeliverAt = at;
    this.delivered++;
    return at;
  }
}

/**
 * Delivers callbacks in FIFO order at their scheduled times. One timer per
 * link, so a message whose time has already passed can never overtake an
 * earlier one that is still waiting (separate setTimeouts per message could).
 */
export class OrderedDelivery {
  private queue: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  push(at: number, fn: () => void): void {
    this.queue.push({ at, fn });
    this.pump();
  }

  private pump(): void {
    const now = this.now();
    while (this.queue.length > 0 && (this.queue[0]?.at ?? Infinity) <= now) this.queue.shift()?.fn();
    const head = this.queue[0];
    if (head && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, head.at - now);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { TICK_MS, type ServerStats } from "@tanks/shared";
import type { RejectReason, SendKind } from "./room.js";

/** Prometheus metrics (GET /metrics). Names are prefixed `tanks_`. */
export class Metrics {
  readonly registry = new Registry();

  readonly tickDuration = new Histogram({
    name: "tanks_tick_duration_seconds",
    help: "CPU time of one server tick (all rooms). Budget is 1/30 s.",
    buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.025, 0.033, 0.05, 0.1],
    registers: [this.registry],
  });
  readonly tickOverruns = new Counter({
    name: "tanks_tick_overruns_total",
    help: "Ticks dropped because the loop fell behind",
    registers: [this.registry],
  });
  readonly bytesSent = new Counter({
    name: "tanks_ws_bytes_sent_total",
    help: "WebSocket payload bytes sent, by message kind",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });
  readonly messagesSent = new Counter({
    name: "tanks_ws_messages_sent_total",
    help: "WebSocket messages sent, by kind",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });
  readonly bytesReceived = new Counter({
    name: "tanks_ws_bytes_received_total",
    help: "WebSocket payload bytes received",
    registers: [this.registry],
  });
  readonly inputRejections = new Counter({
    name: "tanks_input_rejections_total",
    help: "Client messages rejected by server validation, by reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly shots = new Counter({
    name: "tanks_shots_total",
    help: "Shots fired, by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  readonly rewindTicks = new Histogram({
    name: "tanks_lag_comp_rewind_ticks",
    help: "How far back (ticks) hits were judged",
    buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    registers: [this.registry],
  });
  readonly reconnects = new Counter({
    name: "tanks_reconnects_total",
    help: "Resume attempts, by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  readonly players = new Gauge({
    name: "tanks_players",
    help: "Players in rooms, by connection state",
    labelNames: ["state"] as const,
    registers: [this.registry],
  });
  readonly rooms = new Gauge({ name: "tanks_rooms", help: "Open rooms", registers: [this.registry] });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "tanks_" });
    for (const r of ["client_position", "seq_replay", "seq_jump", "rate_limit", "fire_cooldown", "malformed"]) {
      this.inputRejections.inc({ reason: r }, 0);
    }
  }

  recordSend(kind: SendKind, bytes: number): void {
    this.bytesSent.inc({ kind }, bytes);
    this.messagesSent.inc({ kind });
  }

  recordReject(reason: RejectReason): void {
    this.inputRejections.inc({ reason });
  }
}

/**
 * Rolling-window stats for the load test (GET /stats). Exact percentiles over
 * the last `windowSec` seconds, which a Prometheus histogram can only estimate.
 */
export class StatsWindow {
  private ticks: { at: number; ms: number }[] = [];
  private sent: { at: number; bytes: number }[] = [];
  private recv: { at: number; bytes: number }[] = [];
  overruns = 0;
  private readonly startedAt: number;

  constructor(
    private readonly windowSec = 5,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
  }

  recordTick(ms: number): void {
    this.ticks.push({ at: this.now(), ms });
  }
  recordSent(bytes: number): void {
    this.sent.push({ at: this.now(), bytes });
  }
  recordReceived(bytes: number): void {
    this.recv.push({ at: this.now(), bytes });
  }

  private prune(): void {
    const cutoff = this.now() - this.windowSec * 1000;
    const keep = <T extends { at: number }>(a: T[]) => {
      let i = 0;
      while (i < a.length && (a[i]?.at ?? 0) < cutoff) i++;
      return i > 0 ? a.slice(i) : a;
    };
    this.ticks = keep(this.ticks);
    this.sent = keep(this.sent);
    this.recv = keep(this.recv);
  }

  snapshot(players: number, rooms: number): ServerStats {
    this.prune();
    const sorted = this.ticks.map((t) => t.ms).sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0) : 0);
    const sum = (a: { bytes: number }[]) => a.reduce((n, x) => n + x.bytes, 0);
    const r = (n: number) => Math.round(n * 1000) / 1000;
    const span = Math.max(0.001, Math.min(this.windowSec, (this.now() - this.startedAt) / 1000));
    return {
      windowSec: r(span),
      ticksPerSec: r(this.ticks.length / span),
      tickP50Ms: r(pct(0.5)),
      tickP99Ms: r(pct(0.99)),
      tickMaxMs: r(sorted.at(-1) ?? 0),
      players,
      rooms,
      bytesOutPerSec: Math.round(sum(this.sent) / span),
      bytesInPerSec: Math.round(sum(this.recv) / span),
      overruns: this.overruns,
    };
  }
}

export const TICK_BUDGET_MS = TICK_MS;

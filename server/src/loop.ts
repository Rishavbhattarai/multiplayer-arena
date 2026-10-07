/**
 * Fixed-timestep loop with an accumulator ("Fix Your Timestep").
 *
 * The simulation always advances in whole ticks of `tickMs`, regardless of
 * timer jitter. If the process stalls, it catches up by running several ticks
 * back to back, up to `maxCatchUpTicks`, then drops the backlog rather than
 * spiralling.
 */
export interface LoopOptions {
  tickMs: number;
  maxCatchUpTicks?: number;
  now?: () => number;
  /** Called with the measured CPU time of each tick (ms). Hook for prom-client later. */
  onTickTiming?: (durationMs: number, tick: number) => void;
  /** Called when backlog was dropped because the server could not keep up. */
  onOverrun?: (droppedTicks: number) => void;
}

export class FixedTimestepLoop {
  private readonly tickMs: number;
  private readonly maxCatchUp: number;
  private readonly now: () => number;
  private accumulator = 0;
  private last: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Number of ticks executed so far. */
  tick = 0;

  constructor(
    private readonly onTick: (tick: number) => void,
    private readonly opts: LoopOptions,
  ) {
    this.tickMs = opts.tickMs;
    this.maxCatchUp = opts.maxCatchUpTicks ?? 5;
    this.now = opts.now ?? (() => performance.now());
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.last = null;
  }

  /**
   * Advance simulated time to `now` and run every tick that is due.
   * Returns the number of ticks run. Public so tests can drive it with a fake clock.
   */
  advance(now: number): number {
    if (this.last === null) this.last = now;
    this.accumulator += now - this.last;
    this.last = now;

    let ran = 0;
    while (this.accumulator >= this.tickMs && ran < this.maxCatchUp) {
      const t0 = this.now();
      this.tick++;
      this.onTick(this.tick);
      this.opts.onTickTiming?.(this.now() - t0, this.tick);
      this.accumulator -= this.tickMs;
      ran++;
    }
    if (this.accumulator >= this.tickMs) {
      const dropped = Math.floor(this.accumulator / this.tickMs);
      this.accumulator -= dropped * this.tickMs;
      this.opts.onOverrun?.(dropped);
    }
    return ran;
  }

  private schedule(): void {
    const delay = Math.max(0, this.tickMs - this.accumulator);
    this.timer = setTimeout(() => {
      this.advance(this.now());
      if (this.timer) this.schedule();
    }, delay);
  }
}

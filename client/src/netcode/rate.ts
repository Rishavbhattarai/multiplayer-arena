/** Rolling per-second rate of a monotonically increasing counter. */
export class RateMeter {
  private points: { t: number; v: number }[] = [];

  constructor(private readonly windowMs = 1000) {}

  sample(now: number, value: number): number {
    this.points.push({ t: now, v: value });
    while (this.points.length > 2 && (this.points[1]?.t ?? 0) <= now - this.windowMs) this.points.shift();
    const first = this.points[0];
    if (!first || now - first.t <= 0) return 0;
    return ((value - first.v) * 1000) / (now - first.t);
  }
}

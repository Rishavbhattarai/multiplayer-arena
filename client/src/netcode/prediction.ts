import { TICK_DT, stepTank, type TankState } from "@tanks/shared";

interface PendingInput {
  seq: number;
  keys: number;
}

/**
 * Client-side prediction with server reconciliation.
 *
 * The local tank moves immediately using the same stepTank the server runs.
 * Every input is kept until the server acknowledges it (`ackSeq`). When a
 * snapshot arrives, the authoritative state replaces ours and every input the
 * server has not processed yet is replayed on top of it. If client and server
 * agree (the normal case), the replayed result equals what we already showed,
 * so the correction is zero.
 */
export class Predictor {
  state: TankState;
  private pending: PendingInput[] = [];

  constructor(initial: TankState) {
    this.state = { ...initial };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Apply one local input (one tick). Dead tanks do not move but inputs are still tracked. */
  applyLocal(seq: number, keys: number, alive: boolean): TankState {
    this.pending.push({ seq, keys });
    if (alive) this.state = stepTank(this.state, keys, TICK_DT);
    return this.state;
  }

  /**
   * Rebase on the server's state for `ackSeq` and replay the rest.
   * Returns how far (world units) the prediction was off.
   */
  reconcile(server: TankState, ackSeq: number, alive: boolean): number {
    while (this.pending.length > 0 && (this.pending[0]?.seq ?? Infinity) <= ackSeq) this.pending.shift();
    let s: TankState = { x: server.x, y: server.y, angle: server.angle };
    if (alive) for (const p of this.pending) s = stepTank(s, p.keys, TICK_DT);
    const err = Math.hypot(s.x - this.state.x, s.y - this.state.y);
    this.state = s;
    return err;
  }

  /** Hard reset (e.g. after a reconnect). */
  reset(state: TankState): void {
    this.state = { ...state };
    this.pending = [];
  }
}

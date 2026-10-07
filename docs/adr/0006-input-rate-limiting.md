# ADR 0006: Input validation: token bucket with a 10-tick burst

- Status: Accepted
- Date: 2026-10-07

## Context

With input-only clients, the remaining speed hack is to send inputs faster than one per tick: each input runs `stepTank` once, so 10 inputs per tick would mean 10x speed. Honest inputs do not arrive one per tick either. Jitter and especially TCP retransmission stalls deliver them in bursts.

## Options

1. Apply exactly one input per tick, queue the rest: a stall leaves a permanent backlog, which adds latency that never drains.
2. Apply everything that arrives: no speed limit.
3. Token bucket: one credit per tick, capped at N; each applied input spends one.

## Decision

Option 3 with `INPUT_BURST = 10` and `MAX_INPUT_QUEUE = 15`.

## Why 10

The first version used a burst of 4 and a queue of 8. In a browser session at 150 ms RTT, 20 ms jitter and 5% loss, it rejected honest inputs as `rate_limit` and the player's tank was corrected by up to 60 units. (That session also had 314 `seq_replay` rejections, caused by the client's network simulator reordering messages; that bug was fixed separately.) A retransmission stall at that RTT is about 230 ms, 7 ticks of inputs. A 10-tick bucket absorbs it. After both fixes, the same conditions gave 0 rejections of any kind for the honest player, and 0 prediction corrections over 15 s of driving and firing.

## Consequences

- Long-run speed is still capped at `TANK_SPEED`. The cheat bot sends 10 inputs per tick for 6 s; its path length stayed under the legitimate maximum (759 vs 1,194 units) and 1,568 inputs were rejected as `rate_limit`.
- A cheater who stays idle can bank 10 ticks and spend them in one tick: a 60-unit jump (the cheat bot's fastest observed step was 57 units). That is bounded and no faster on average.
- Fire cooldown uses both seq gap (15) and server-tick gap (12, with 3 ticks of slack for bunched inputs), so banking credits cannot raise the fire rate above 2.5 shots/s.

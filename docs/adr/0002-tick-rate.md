# ADR 0002: Tick rate: 30 Hz

- Status: Accepted
- Date: 2026-10-07

## Context

The server simulates and broadcasts once per tick. A higher rate lowers input-to-update delay and makes snapshots finer, but costs CPU and bandwidth per player linearly. Browser clients render at 60 Hz or more regardless, through interpolation.

## Options

| Rate | Tick interval | Effect |
|---|---|---|
| 20 Hz | 50 ms | Two thirds of the 30 Hz cost. Adds up to 17 ms of extra delay per hop versus 30 Hz and needs a longer interpolation buffer (two intervals = 100 ms minimum). |
| 30 Hz | 33.3 ms | Middle ground. 100 ms interpolation delay holds three snapshot intervals. |
| 60 Hz | 16.7 ms | Twice the 30 Hz cost and a 16.7 ms CPU budget per tick. Common for shooters with dedicated servers, unnecessary for slow tanks (180 units/s). |

## Decision

30 Hz (`TICK_RATE` in `shared/src/constants.ts`). Tanks move 6 units per tick at 30 Hz, a fraction of their 36-unit width, so finer ticks add little to hit accuracy.

## Consequences

- Measured on an Apple M4 (native Node 24): 1,680 players within the 33.3 ms p99 budget; profiling shows sending snapshots, not simulation, dominates tick time (see the README). Per-player cost is roughly per-message, so 60 Hz would roughly halve capacity and 20 Hz would raise it.
- Downstream bandwidth scales with tick rate: 6.6 KB/s per player with delta snapshots at 30 Hz.
- Changing the constant changes client prediction, interpolation and cooldowns together, because they are all expressed in ticks.

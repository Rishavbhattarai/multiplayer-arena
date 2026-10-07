# ADR 0004: Lag-compensation rewind window: 300 ms

- Status: Accepted
- Date: 2026-10-07

## Context

The shooter aims at a remote tank drawn about 100 ms in the past, and their shot reaches the server one-way latency later. Without compensation, a shot that was on target on screen misses on the server. The server therefore rewinds targets to the tick the shooter was viewing (`vt` in each input) before raycasting. The longer the allowed rewind, the more latency is compensated, and the more often a target gets hit after they believed they were safe ("shot around a corner").

## Options

1. No rewind: fair to the target, unplayable for anyone with latency.
2. Unlimited rewind (trust `vt`): a cheater could send an old `vt` and hit where targets used to be.
3. Clamped rewind: honour `vt` up to a cap.

## Decision

Clamp to `MAX_REWIND_MS = 300` (9 ticks). That covers the 100 ms interpolation delay plus 150 ms RTT, the project's target condition, with margin for jitter. Hits are judged against positions interpolated between two history frames, the same way the client draws them. The shooter's own position is the current authoritative one.

## Consequences

- A test shows a shot aimed where the target was 8 ticks ago hits with rewind and misses without it, and that `vt = 0` is clamped to 9 ticks.
- Players above about 200 ms RTT get partial compensation and must lead targets.
- The rewind depth of every shot is in `tanks_lag_comp_rewind_ticks`, so the window can be tuned from real data.
- With no walls yet, the "shot around a corner" downside only shows up as hits on a tank that already moved away. The window bounds how far.

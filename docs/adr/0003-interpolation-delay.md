# ADR 0003: Interpolation delay: 100 ms, with up to 200 ms of extrapolation

- Status: Accepted
- Date: 2026-10-07

## Context

Remote tanks are drawn between two received snapshots, so the client must render slightly in the past. A longer delay survives more jitter and loss before the buffer runs dry, but everything you see of other players is older, and the shooter has to lead targets more (lag compensation covers the hit, not the visual).

## Options

1. 50 ms (1.5 snapshot intervals): any jitter above about 17 ms starves the buffer.
2. 100 ms (3 intervals): survives jitter up to about 67 ms and one lost snapshot when the transport drops it.
3. 200 ms+: survives a TCP retransmission stall, but remote players look visibly late at all times.
4. 100 ms plus extrapolation when starved: keep the low delay and bridge stalls by continuing each tank on its last velocity.

## Decision

Option 4: `INTERP_DELAY_MS = 100`, `MAX_EXTRAPOLATE_MS = 200`, after which tanks hold still.

## Why the extrapolation was added

The first version held the last position when starved. At 150 ms RTT, 20 ms jitter and 5% loss with TCP-style retransmission, a 20 s session showed 179 frames where remote tanks froze. Each lost snapshot blocks everything behind it for about 230 ms (RTO), more than the 100 ms buffer. After adding extrapolation, the same conditions gave 0 frozen frames and 391 extrapolated ones in a 20 s run.

## Consequences

- Extrapolated positions can be wrong when a tank turns during a stall; the next real snapshot pulls it back through interpolation.
- Lag compensation must rewind at least this delay plus one-way latency (see ADR 0004).
- Under the same conditions, the 99th-percentile per-frame jump of remote tanks was 4.8 px in the authoritative client versus 29.7 px in the naive client (which draws raw snapshots).

# ADR 0005: Encoding: JSON with delta snapshots; binary deferred

- Status: Accepted
- Date: 2026-10-07

## Context

Snapshots are the bulk of the traffic: every player receives every other player's state 30 times a second. The options were a more compact format (MessagePack, Protobuf, a hand-rolled binary layout) and/or sending less data (deltas against the last state the client acknowledged).

## Options

1. Full JSON snapshots: readable in DevTools, zero tooling, largest.
2. Delta JSON snapshots: only changed fields since the client's acked tick. Needs a baseline history on both sides and an ack in every input.
3. Binary (MessagePack/Protobuf): smaller per field, less readable, extra dependency or schema.
4. Both 2 and 3.

## Decision

Option 2. JSON stays debuggable and the decoder is hand-validated. Delta encoding goes after the redundancy in the data: idle tanks, unchanged hp/score/name/aim fields.

## Measured

`npm run bandwidth`, 4 rooms x 8 bots, 20 s per variant, Apple M4 (bots move or idle at random and fire about once a second):

| Variant | Down KB/s per player | Up KB/s per player |
|---|---|---|
| Naive (client positions, full snapshots) | 24.04 | 1.75 |
| Authoritative, full snapshots | 24.30 | 2.22 |
| Authoritative, delta snapshots | 6.64 | 2.22 |

Delta snapshots cut downstream by 73%.

## Consequences

- The server keeps 64 ticks of history and diffs per baseline. The diff is encoded once per baseline and shared by every player on it.
- A lost or undecodable delta is not acked, so the server keeps using an older baseline or falls back to a full snapshot. No resync protocol is needed.
- Binary encoding is the next step if bandwidth matters more. It would shrink each message but not the message count, and profiling shows per-message socket writes, not bytes, dominate server CPU.

# ADR 0001: Transport: raw `ws` over WebSocket, not Socket.IO or WebRTC data channels

- Status: Accepted (Week 1)
- Date: 2026-10-06

## Context

The game needs a bidirectional, low-latency channel between browsers and a Node server: ~30 small messages per second each way per player. The project's point is to make the netcode visible (tick loop, prediction, reconciliation, lag compensation), and it must cost $0 to run and host.

## Options

### 1. Raw WebSocket (`ws` on the server, browser `WebSocket` on the client)
- + Smallest, most explicit stack. Every byte on the wire is ours, which makes bandwidth numbers honest.
- + Works everywhere, including free hosts and Cloudflare Tunnel. Same library for bots.
- - TCP: one lost packet stalls every later message (head-of-line blocking) until it is retransmitted. At 5% loss this shows up as hitches.
- - We write our own heartbeats, reconnect and message framing.

### 2. Socket.IO
- + Reconnect, rooms, acks and fallbacks out of the box.
- - Adds its own framing, an engine.io handshake and a custom protocol, which hides exactly what the project is meant to show and inflates bandwidth measurements.
- - Still TCP underneath, so no improvement on head-of-line blocking.

### 3. WebRTC data channels (unreliable, unordered)
- + UDP-like semantics: a lost snapshot is simply skipped, which is what real-time games want. No head-of-line blocking.
- - Needs signalling, ICE/STUN, and usually TURN for some NATs. Free TURN is unreliable; running one costs money or ops time.
- - Server-side Node WebRTC libraries are heavier and less mature; bots become harder to write.

## Decision

Use raw WebSockets via `ws`. Keep the transport behind a thin wrapper (`client/src/net.ts`, `server/src/gateway.ts`) and keep the protocol in `shared/` so a different transport could be swapped in later.

## Consequences

- Packet loss on TCP causes stalls rather than gaps. The client network simulator models this (`tcp` loss model: a lost message waits a retransmission timeout and blocks everything behind it). At 150 ms RTT and 5% loss, each loss stalls the stream for about 230 ms.
- Interpolation (100 ms) plus up to 200 ms of extrapolation hides most stalls for remote tanks (ADR 0003). The input token bucket lets the server catch up on inputs that arrive in a burst after a stall (ADR 0006).
- If the project ever needs real UDP behaviour, WebTransport (HTTP/3 datagrams) or WebRTC data channels are the next step; that would be a new ADR. The simulator's `drop` loss model shows roughly what that would look like.

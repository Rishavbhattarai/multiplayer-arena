# Tanks Arena: Multiplayer Real-Time Game

A browser top-down tank arena where the server is the only source of truth, built to show WebSocket netcode: fixed-tick simulation, server authority, and (in later weeks) client prediction, reconciliation, interpolation and lag compensation. TypeScript end to end, HTML5 Canvas, no game engine. Full scope: [SCOPE.md](SCOPE.md).

![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg) <!-- replace OWNER/REPO after pushing -->

## Status

| Week | Deliverable | State |
|---|---|---|
| 1 | Rooms, WebSocket protocol, naive server-sent positions | Done: two tabs see each other move (`?mode=naive`) |
| 2 | Input-only clients, server validation | Hook points in place (`// YOUR TURN`), see [YOUR_TURN.md](YOUR_TURN.md) |
| 3 | Prediction, reconciliation, interpolation, net simulator | Planned |
| 4 | Lag compensation, delta snapshots, reconnect | Planned |
| 5 | Bot load test, demo video, results | Planned |

Results table (players per server, KB/s per player, playable at 150 ms / 5% loss) will be filled in Week 5 with the hardware stated.

## Quickstart

Requires Node 22.12+ (Vitest 5 and Vite 8 need it) and npm.

```bash
npm install

# terminal 1: game server (HTTP + WebSocket on :8080, 30 Hz tick)
npm run dev:server

# terminal 2: client (Vite on :5173)
npm run dev:client
```

Play in two tabs:

1. Open http://localhost:5173, enter a name, click **Create room**. The URL becomes `?room=XXXXXX&mode=naive`.
2. Open the same URL in a second tab (or open http://localhost:5173 and join from the room list / room code).
3. Move with **W/S** (or Up/Down) and turn with **A/D** (or Left/Right). Each tab sees the other tank move.

Headless bots (server must be running):

```bash
npm run bots -- --bots 2 --duration 5            # creates a room
npm run bots -- --room XXXXXX --bots 5 --duration 60   # join the room you are watching
```

### Docker

```bash
docker compose up -d --build        # server :8080, static client :8081
docker compose --profile redis up -d --build   # also starts Redis (registry not wired yet)
docker compose down
```

## Modes

- `?mode=naive` (default for now): the Week 1 baseline. The client moves itself and sends its position; the server trusts it and rebroadcasts at 30 Hz; other tanks snap to the latest snapshot. Kept on purpose for the split-screen naive-vs-final demo.
- `?mode=authoritative` (or `?mode=final`): the room mode exists on the server, but input messages, server-side input application and the client are not written yet (see `// YOUR TURN` hooks and YOUR_TURN.md).
- `?server=http://host:port` overrides the server (else `VITE_SERVER_URL`, else `<page host>:8080`).

## Scripts

| Command | What it does |
|---|---|
| `npm run lint` | ESLint (typescript-eslint strict + stylistic) |
| `npm run typecheck` | `tsc` strict for shared, server, client, loadtest |
| `npm test` | Vitest: protocol codec, deterministic movement, rooms, tick loop, WebSocket end-to-end |
| `npm run build` | Production client build to `client/dist` |
| `npm run check` | All of the above |

## Layout

```
shared/    protocol types + codec, constants (TICK_RATE=30), deterministic stepTank
server/    HTTP lobby, WebSocket gateway, rooms, fixed-timestep loop
client/    Vite + Canvas client (naive mode)
loadtest/  headless bots using shared/
chaos/     planned failure-injection scripts
docs/      design.md (architecture, protocol), adr/
```

## HTTP API

| Method | Path | Result |
|---|---|---|
| GET | `/healthz` | `{ ok, rooms, players, serverId }` |
| GET | `/rooms` | list of rooms |
| POST | `/rooms` `{ "mode": "naive" \| "authoritative" }` | `201` room info |
| GET | `/rooms/:id` | room info or `404` |

WebSocket: `ws://host:8080/ws`, protocol described in [docs/design.md](docs/design.md).

## Docs

- [Design](docs/design.md)
- [ADR 0001: raw ws vs Socket.IO vs WebRTC](docs/adr/0001-transport-raw-ws-vs-socketio-vs-webrtc.md)

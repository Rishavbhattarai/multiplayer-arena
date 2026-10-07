# loadtest

Headless bots that use the same `@tanks/shared` protocol and movement code as the browser.

```bash
npm run dev:server                              # terminal 1
npm run bots -- --bots 2 --duration 5           # terminal 2: creates a room, 2 bots
npm run bots -- --room ABC123 --bots 10         # join an existing room (watch it in a browser tab)
```

Each bot prints one JSON line (snapshots received, KB/s in/out, errors). Exit code is non-zero if any bot failed to join, got no snapshots, or did not see the other bots.

Planned (Week 5): ramp bots until server p99 tick time exceeds the 33 ms budget, record players-per-server and KB/s per player before/after delta snapshots, and commit results with the hardware used.

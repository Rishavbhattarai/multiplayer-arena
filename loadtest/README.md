# loadtest

Headless clients that use the same `@tanks/shared` protocol and movement code as the browser. All scripts take `--url` (default `http://localhost:8080`).

| Command | What it does |
|---|---|
| `npm run bots -- --bots 4 --duration 10` | Bots join an authoritative room (or `--mode naive`, or `--room <ID>` to join one you are watching). Exit 0 only if every bot joined, received snapshots and saw every other bot. |
| `npm run bots -- --bots 4 --drop-every 2` | Same, but one bot's socket is killed every 2 s and resumed with its token. Fails if any resume lost the tank or its position. |
| `npm run cheat` | Cheating client (`cheat-bot.ts`): teleports, 10x input flooding, position fields in inputs, replayed and jumped seqs, rapid fire. Checks the server's snapshots for speed, teleport and fire rate, and prints rejection counters from `/metrics`. Exit 0 if every cheat was blocked. |
| `npm run bandwidth -- --rooms 4 --duration 20` | Downstream/upstream KB/s per player for naive, authoritative full, and authoritative delta snapshots. Writes `results/bandwidth.json`. |
| `npm run ramp -- --step 80 --workers 2` | Adds 8-player rooms of bots every 10 s until the server's p99 tick time exceeds 33.3 ms or it cannot hold 30 ticks/s. Bots run in worker processes. Server numbers come from `GET /stats` (exact percentiles, 5 s window) and `/metrics`. Writes `results/ramp-<mode>.json`. |

Bot behaviour: every 0.5 to 1.5 s a bot picks idle (30%), forward, forward + turn, or reverse. In authoritative rooms it fires at a random tank about once a second.

## Results

- `results/ramp-authoritative.json`: native Node on Apple M4 (4 performance + 6 efficiency cores, 16 GB). The host 1-minute load average is recorded per row, since other projects were running on the same machine.
- `results/ramp-authoritative-contended.json`: the same test while two other projects' load tests saturated the machine (load average about 20 to 60). Kept to show how much host contention moves the number.
- `results/bandwidth.json`

Run the ramp against a server started natively (`npm run start:server`), not in Docker Desktop: on macOS the Docker VM is shared with every other container, which skews tick timings.

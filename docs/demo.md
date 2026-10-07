# Demo recording script

Two clips for the README: a split-screen of the naive and authoritative clients under the same simulated lag, and a cheating client being corrected. About 5 minutes to set up and record.

## Setup

```bash
npm install
npm run dev:server        # terminal 1, :8080
npm run dev:client        # terminal 2, :5173
```

Create one room of each mode and fill both with bots (terminal 3):

```bash
NAIVE=$(curl -s -XPOST localhost:8080/rooms -d '{"mode":"naive"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).roomId')
AUTH=$(curl -s -XPOST localhost:8080/rooms -d '{"mode":"authoritative"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).roomId')
echo "naive: $NAIVE  authoritative: $AUTH"
npm run bots -- --room $NAIVE --mode naive --bots 3 --duration 600 &
npm run bots -- --room $AUTH --bots 3 --duration 600 &
```

## Clip 1: naive vs authoritative at 150 ms RTT, 20 ms jitter, 5% loss

1. Open two browser windows side by side (half screen each):
   - Left: `http://localhost:5173/?room=<NAIVE>&lag=150&jitter=20&loss=5`
   - Right: `http://localhost:5173/?room=<AUTH>&lag=150&jitter=20&loss=5`

   Both windows show `netsim 150ms ±20 5% tcp` in the panel, so the conditions are identical.
2. Start the screen recording (macOS: Cmd+Shift+5, record selected portion).
3. Watch the bots for 10 s without touching anything. Left: bots stutter and jump. Right: bots move smoothly.
4. Drive your own tank in each window for 10 s (W + A/D). In the right window, press W and the tank moves immediately even though the RTT is about 170 ms (client prediction). The dashed outline behind it is where the server last confirmed it.
5. In the right window, aim at a bot with the mouse and click. The red tracer shows a hit registered at the position you saw (lag compensation). Point to `correction 5s max` and `interp buffer` in the HUD.
6. Optional: set loss model to `drop` in both panels to show the UDP-style behaviour for comparison.
7. Stop recording, convert: `gifski --fps 15 --width 1200 -o docs/media/split-screen.gif recording.mov` (or keep the .mov for the video).

## Clip 2: cheating client is rejected

1. Open `http://localhost:3000` if you run the Docker stack (Grafana dashboard "Tanks Arena"), or keep a terminal on `curl -s localhost:8080/metrics | grep rejections`.
2. Record the terminal while running:

   ```bash
   npm run cheat
   ```

   It tries teleporting, 10x input flooding, position fields inside inputs, replayed and jumped seqs, and rapid fire, then prints what the server allowed (path length vs legitimate maximum, shots vs cooldown limit) and its rejection counters by reason. It ends with `OK: every cheat was rejected or corrected by the server`.
3. With Grafana open, the "Input rejections (anti-cheat)" panel jumps by reason during the run.

## Clip 3 (optional): reconnect

In the authoritative window, click **Drop connection**. The banner shows `Reconnecting...` and the tank comes back in the same place with the same score. Reloading the page within 30 s does the same (the resume token is kept in `sessionStorage`).

## Clean up

```bash
kill %1 %2      # bots
```

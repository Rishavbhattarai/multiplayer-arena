#!/usr/bin/env bash
# Chaos: freeze the game server process for a few seconds (docker compose pause)
# while bots play, then unfreeze it. Shows the fixed-timestep loop dropping its
# backlog (tanks_tick_overruns_total) instead of fast-forwarding, and clients
# carrying on afterwards.
#
#   ./chaos/pause-server.sh [pause_seconds]
#
# Needs the compose stack: docker compose up -d --build --wait
set -euo pipefail
PAUSE="${1:-5}"
URL="http://localhost:${SERVER_PORT:-8080}"
cd "$(dirname "$0")/.."
LOG="$(mktemp)"

npm run --silent bots -- --url "$URL" --bots 6 --duration $((PAUSE + 12)) > "$LOG" &
BOTS=$!
sleep 4
echo "pausing server for ${PAUSE}s"
docker compose pause server
sleep "$PAUSE"
docker compose unpause server
echo "server resumed"
wait $BOTS
tail -1 "$LOG"
echo "overruns reported by the server:"
curl -s "$URL/metrics" | grep '^tanks_tick_overruns_total'

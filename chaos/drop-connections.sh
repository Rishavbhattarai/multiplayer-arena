#!/usr/bin/env bash
# Chaos: abruptly kill player sockets (no "leave") and check every player
# resumes the same tank, at the same position, with its resume token.
#
#   ./chaos/drop-connections.sh [server_url] [seconds]
#
# Works against `npm run dev:server` or `docker compose up` (default http://localhost:8080).
set -euo pipefail
URL="${1:-http://localhost:8080}"
SECS="${2:-20}"
cd "$(dirname "$0")/.."
echo "dropping one of 6 bot connections every second for ${SECS}s against ${URL}"
npm run --silent bots -- --url "$URL" --bots 6 --duration "$SECS" --drop-every 1 | tail -1

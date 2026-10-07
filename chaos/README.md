# chaos

Placeholder. Planned scripts (Week 4-5):

- `kill-server.sh`: `docker compose kill server` mid-match, restart it, and show clients reconnecting within the 30 s window with state intact (needs the reconnect-token feature).
- `netem.sh`: degrade the network with `tc netem` inside the server container (latency, jitter, 5% loss) to compare naive vs final under identical conditions. The in-browser network simulator covers the same idea client-side.
- `kill-redis.sh`: stop Redis and show running rooms keep playing while new room creation fails over/degrades gracefully.

Each script should be recorded as a short GIF for the README.

import { startApp } from "./app.js";
import { loadConfig } from "./config.js";
import { jsonLogger } from "./log.js";

const config = loadConfig();
if (config.registry === "redis") {
  jsonLogger("warn", "ROOM_REGISTRY=redis is not implemented yet; falling back to in-memory registry");
}

const app = await startApp({ port: config.port, host: config.host, serverId: config.serverId, log: jsonLogger });

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    jsonLogger("info", "shutting down", { signal: sig });
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

import { defineConfig } from "vite";

// The dev server proxies the game server so the client can always use its own
// origin (same as the nginx image does in docker compose).
const target = process.env.GAME_SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    host: true,
    proxy: {
      "/rooms": target,
      "/healthz": target,
      "/stats": target,
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  preview: { port: 4173, host: true },
  build: { target: "es2022", sourcemap: true },
});

import { hostname } from "node:os";
import { DEFAULT_SERVER_PORT } from "@tanks/shared";

export interface ServerConfig {
  port: number;
  host: string;
  /** Identifies this process in the room -> server registry. */
  serverId: string;
  /** "memory" today; "redis" is planned (see roomRegistry.ts). */
  registry: "memory" | "redis";
  redisUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? DEFAULT_SERVER_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const registry = env.ROOM_REGISTRY === "redis" ? "redis" : "memory";
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    serverId: env.SERVER_ID ?? `${hostname()}:${port}`,
    registry,
    redisUrl: env.REDIS_URL,
  };
}

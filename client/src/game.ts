import type { WelcomeMessage } from "@tanks/shared";
import type { Connection } from "./net.js";

export type HudItem = [label: string, value: string];

/** A running game client for one room. Connections can be swapped on reconnect. */
export interface Game {
  attach(conn: Connection, welcome: WelcomeMessage): void;
  detach(): void;
  start(): void;
  stop(): void;
  setBanner(text: string | null): void;
  /** Debug/verification hook (exposed as window.__tanks). */
  debug(): Record<string, unknown>;
}

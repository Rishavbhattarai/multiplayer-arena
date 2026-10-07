/** Minimal structured logger: one JSON object per line on stdout. */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export const jsonLogger: Logger = (level, msg, fields) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

export const silentLogger: Logger = () => undefined;

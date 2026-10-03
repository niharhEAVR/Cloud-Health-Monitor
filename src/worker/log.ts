import type { WorkerEnv } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, boolean | number | string | undefined>;

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redactTargetUrl(value: string): string {
  try {
    const target = new URL(value);
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export function createLogger(config: Pick<WorkerEnv, "LOG_LEVEL">) {
  return (level: LogLevel, event: string, context: LogContext = {}): void => {
    if (severity[level] < severity[config.LOG_LEVEL]) {
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)),
    };
    const output = JSON.stringify(record);
    if (level === "error" || level === "warn") {
      console.error(output);
    } else {
      console.log(output);
    }
  };
}

export type WorkerLogger = ReturnType<typeof createLogger>;

/** Never log exception messages: drivers can include URLs, credentials, or SQL. */
export function boundedErrorCode(error: unknown): string {
  const candidate = typeof error === "object" && error !== null
    ? "code" in error && typeof error.code === "string"
      ? error.code
      : "name" in error && typeof error.name === "string"
        ? error.name
        : "UNKNOWN_ERROR"
    : "UNKNOWN_ERROR";
  return candidate.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "UNKNOWN_ERROR";
}

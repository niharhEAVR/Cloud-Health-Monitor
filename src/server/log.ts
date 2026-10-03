import "server-only";

import { parseServerEnv } from "@/server/env";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, boolean | number | string | undefined>;

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redactTargetUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export function log(level: LogLevel, event: string, context: LogContext = {}): void {
  const configuredLevel = parseServerEnv().LOG_LEVEL;
  if (severity[level] < severity[configuredLevel]) {
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
}

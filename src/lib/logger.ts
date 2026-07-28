import { env } from "../config/env.js";
import { safeJson } from "./json.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

function currentLevelRank(level: LogLevel) {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
  }
}

function resolveThreshold() {
  const value = (env.TASUKI_AGENT_LOG_LEVEL ?? "info").toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
}

const threshold = resolveThreshold();

export class Logger {
  constructor(private readonly moduleName: string, private readonly bindings: LogContext = {}) {}

  child(bindings: LogContext) {
    return new Logger(this.moduleName, { ...this.bindings, ...bindings });
  }

  log(level: LogLevel, message: string, context: LogContext = {}) {
    if (currentLevelRank(level) < currentLevelRank(threshold)) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.moduleName,
      message,
      ...this.bindings,
      ...context,
    };

    const line = safeJson(entry);
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }

  debug(message: string, context?: LogContext) {
    this.log("debug", message, context);
  }

  info(message: string, context?: LogContext) {
    this.log("info", message, context);
  }

  warn(message: string, context?: LogContext) {
    this.log("warn", message, context);
  }

  error(message: string, context?: LogContext) {
    this.log("error", message, context);
  }
}

export function createLogger(moduleName: string, bindings?: LogContext) {
  return new Logger(moduleName, bindings);
}

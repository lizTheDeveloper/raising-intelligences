/**
 * Minimal structured logger that emits newline-delimited JSON to stdout/stderr.
 *
 * Format: { level, time, msg, ...fields }
 *
 * Keeps errors/warnings on stderr so they can be filtered separately in
 * container log aggregators (Cloud Run, Fly, Coolify) without adding an
 * external dependency like pino.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(entry + "\n");
  } else {
    process.stdout.write(entry + "\n");
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info:  (msg: string, fields?: LogFields) => emit("info",  msg, fields),
  warn:  (msg: string, fields?: LogFields) => emit("warn",  msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

/**
 * Minimal dependency-free structured logger.
 *
 * Levels: debug < info < warn < error. Set the floor with LOG_LEVEL (default "info").
 * Output is line-based and human-readable, with optional structured data appended
 * as compact JSON so it stays greppable in Railway logs.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentFloor(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_ORDER[(raw as Level)] ?? LEVEL_ORDER.info;
}

function emit(level: Level, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < currentFloor()) return;

  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  let line = `${ts} ${tag} ${message}`;

  if (data !== undefined) {
    try {
      line += " " + JSON.stringify(data, bigintReplacer);
    } catch {
      line += " " + String(data);
    }
  }

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** JSON.stringify can't serialize bigint; render it as a decimal string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export const logger = {
  debug: (message: string, data?: unknown) => emit("debug", message, data),
  info: (message: string, data?: unknown) => emit("info", message, data),
  warn: (message: string, data?: unknown) => emit("warn", message, data),
  error: (message: string, data?: unknown) => emit("error", message, data),
};

/** Prints a visual section header — used by the CLI scripts to stay readable. */
export function section(title: string): void {
  const bar = "─".repeat(Math.max(4, 60 - title.length));
  console.log(`\n── ${title} ${bar}`);
}

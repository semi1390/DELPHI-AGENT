/**
 * Optional structured signal log.
 *
 * Every run already prints structured lines to stdout (greppable in Railway logs).
 * If SIGNAL_LOG_FILE is set, we ALSO append one JSON object per signal to that
 * file (JSON Lines), each tagged with a shared runId + ISO timestamp — so when you
 * run this on a schedule you can diff how a market's edge evolves over time.
 *
 * Append-only, best-effort: a logging failure never interrupts the scan.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Signal } from "./signal.js";
import { logger } from "./logger.js";

export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function appendSignals(
  filePath: string | undefined,
  runId: string,
  signals: Signal[],
): Promise<void> {
  if (!filePath) return;
  const ts = new Date().toISOString();
  const lines = signals.map((s) => JSON.stringify({ ts, runId, ...s })).join("\n") + "\n";
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, lines, "utf8");
    logger.debug("Appended signals to log file", { filePath, count: signals.length, runId });
  } catch (err) {
    logger.warn("Failed to write signal log (continuing)", {
      filePath,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
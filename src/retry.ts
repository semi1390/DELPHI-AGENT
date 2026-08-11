/**
 * Bounded retry with exponential backoff + jitter.
 *
 * Wraps a single async operation. On a transient failure it waits and retries,
 * up to `retries` extra attempts (so `retries: 4` = 5 total tries), with the delay
 * growing geometrically and a jitter component so many callers don't retry in
 * lockstep. Permanent failures (bad key, auth, validation) are not retried — no
 * point hammering the endpoint for an error that won't fix itself.
 *
 * This is the core of surviving 24/7 operation: a stray `fetch failed` on the
 * shared RPC becomes a logged retry instead of a dead run.
 */

import { logger } from "./logger.js";

export interface RetryOptions {
  /** Extra attempts after the first try. Default 4 (→ 5 total). */
  retries: number;
  /** First backoff delay in ms. Default 300. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. Default 5000. */
  maxDelayMs: number;
  /** Geometric growth factor. Default 2. */
  factor: number;
  /** Apply jitter to spread out retries. Default true. */
  jitter: boolean;
  /** Label used in retry logs so you can tell which call is flaking. */
  label?: string;
  /** Decide whether an error is worth retrying. Default: everything except auth/validation. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each backoff sleep. Default: warn log. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  retries: number;
  delayMs: number;
  error: unknown;
  label?: string;
}

const DEFAULTS: Omit<RetryOptions, "label" | "isRetryable" | "onRetry"> = {
  retries: 4,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

/** Errors we should NOT retry — they won't succeed on a repeat. */
const NON_RETRYABLE = /unauthor|forbidden|invalid api key|401|403|400|private key|bad request|not found|404/i;
/** Errors that are clearly transient/network-ish and worth retrying. */
const TRANSIENT = /fetch failed|network|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket|429|rate.?limit|500|502|503|504|gateway|temporarily/i;

export function defaultIsRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: unknown }).cause ?? ""}` : String(err);
  if (NON_RETRYABLE.test(msg)) return false;
  if (TRANSIENT.test(msg)) return true;
  // Unknown errors: default to retrying — reads are idempotent here, so a few
  // extra attempts are cheap and a mystery failure is often a transient blip.
  return true;
}

function computeDelay(attempt: number, o: RetryOptions): number {
  const raw = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(o.factor, attempt - 1));
  if (!o.jitter) return raw;
  // Equal jitter: half fixed floor + half random, so we never wait ~0ms.
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const o: RetryOptions = { ...DEFAULTS, ...options };
  const isRetryable = o.isRetryable ?? defaultIsRetryable;
  const onRetry =
    o.onRetry ??
    ((info: RetryInfo) =>
      logger.warn("retrying after transient error", {
        label: info.label,
        attempt: info.attempt,
        of: info.retries,
        delayMs: info.delayMs,
        message: info.error instanceof Error ? info.error.message : String(info.error),
      }));

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > o.retries || !isRetryable(err)) throw err;
      const delayMs = computeDelay(attempt, o);
      onRetry({ attempt, retries: o.retries, delayMs, error: err, label: o.label });
      await sleep(delayMs);
    }
  }
}
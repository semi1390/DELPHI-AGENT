/**
 * Rate-source registry.
 *
 * Maps a base-rates.json entity's `source` string to a fetcher returning a live
 * RateModel. Unregistered source → null → estimator abstains (this is how Musk/X
 * stays flat: no source, no guess).
 */

import type { RetryOptions } from "../../retry.js";
import { fetchTrumpTruthRate, type RateModel } from "./trumpstruth.js";

export type { RateModel } from "./trumpstruth.js";

export interface SourceOptions {
  lookbackDays: number;
  retry: Partial<RetryOptions>;
  cacheTtlMs?: number;
  trumpsTruthBaseUrl: string;
  dropZeroDays: boolean;
  countMode: "all" | "original";
  repostPattern: RegExp;
}

export type RateFetcher = (opts: SourceOptions) => Promise<RateModel | null>;

const REGISTRY: Record<string, RateFetcher> = {
  trumpstruth: (o) =>
    fetchTrumpTruthRate({
      baseUrl: o.trumpsTruthBaseUrl,
      lookbackDays: o.lookbackDays,
      retry: o.retry,
      cacheTtlMs: o.cacheTtlMs,
      dropZeroDays: o.dropZeroDays,
      countMode: o.countMode,
      repostPattern: o.repostPattern,
    }),
};

export function getRateFetcher(source: string | undefined): RateFetcher | null {
  if (!source) return null;
  return REGISTRY[source] ?? null;
}
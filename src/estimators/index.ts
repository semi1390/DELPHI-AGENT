/**
 * Estimator router.
 *
 * `estimateProbability(market, outcomeIdx)` is the single entry point the signal
 * layer calls. Estimators are a chain of SELF-GATING specialists tried in order;
 * the first to return a non-null estimate wins, and any that don't fit abstain
 * (return null) and fall through:
 *
 *   1. manual   — your explicit override for this market outcome, if set
 *   2. quant    — crypto/macro terminal threshold markets (GBM); else abstains
 *   3. baserate — count/recurring-event markets (Poisson); else abstains
 *   4. llm      — news/behavioral (stub; abstains for now)
 *   5. baseline — market-implied, zero edge (always answers)
 *
 * Because quant and baserate self-abstain on markets they don't fit (a cheap
 * regex parse, no network on a miss), it's safe to offer every market to each.
 * Adding a new specialist is a one-line insertion here.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { ProbabilityEstimator, SourcedEstimate } from "./types.js";
import { BaselineEstimator } from "./baseline.js";
import { QuantEstimator } from "./quant.js";
import { BaseRateEstimator } from "./baserate.js";
import { DataLookupEstimator } from "./datalookup.js";
import { MeanReversionEstimator } from "./meanrev.js";
import { LLMEstimator } from "./llm.js";
import { ManualOverrideEstimator } from "./manual.js";

const chain: ProbabilityEstimator[] = [
  new ManualOverrideEstimator(),
  new QuantEstimator(),
  new BaseRateEstimator(),
  new DataLookupEstimator(),
  new MeanReversionEstimator(),
  new LLMEstimator(),
  new BaselineEstimator(),
];

export async function estimateProbability(
  market: Market,
  outcomeIdx: number,
): Promise<SourcedEstimate | null> {
  for (const est of chain) {
    const result = await est.estimate(market, outcomeIdx);
    if (result) return { ...result, source: est.name };
  }
  return null;
}

export type { ProbabilityEstimator, Estimate, SourcedEstimate } from "./types.js";
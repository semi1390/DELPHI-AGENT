/**
 * Baseline estimator.
 *
 * Returns the market's own implied probability, so `edge = estimate − implied`
 * comes out to exactly zero. This makes no real prediction — its only job is to
 * prove the pipeline works end to end and to give every other estimator a safe
 * fallback. When you see ~0 edge everywhere, that's the baseline doing its job:
 * "I have no view beyond what the market already says."
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";

export class BaselineEstimator implements ProbabilityEstimator {
  readonly name = "baseline";

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const implied = market.spotImpliedProbabilities?.[outcomeIdx];
    if (implied === undefined || Number.isNaN(implied)) return null;
    return {
      probability: implied,
      confidence: 0,
      rationale: "market-implied (zero-edge baseline)",
    };
  }
}
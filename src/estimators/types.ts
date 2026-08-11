/**
 * Pluggable probability-estimation interface.
 *
 * The whole edge layer is built around one idea: for a given market outcome,
 * produce *your* estimated probability that it resolves true. Different market
 * types need different methods (a sports market wants data/odds; a "will X be
 * announced by Friday" market wants an LLM read; sometimes you just want to type
 * a number in yourself). So estimation is abstracted behind this interface and
 * selected per market — see ./index.ts for the router.
 *
 * An estimator may ABSTAIN by returning null: "I have no opinion on this one."
 * Abstaining is first-class — it means no edge is computed for that outcome,
 * rather than a fabricated number. The baseline estimator never abstains, so the
 * pipeline always produces a row end to end.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";

export interface Estimate {
  /** Your estimated probability in [0, 1] that this outcome resolves true. */
  probability: number;
  /** Optional confidence in the estimate, 0..1. Baseline uses 0 (no conviction). */
  confidence?: number;
  /** Short, human-readable note on where the number came from. */
  rationale?: string;
}

export interface ProbabilityEstimator {
  /** Stable identifier, surfaced in the signal table and logs. */
  readonly name: string;
  /**
   * Estimate the probability for `market`'s outcome at `outcomeIdx`,
   * or return null to abstain (no opinion → no edge for that outcome).
   *
   * Implementations MUST stay read-only and side-effect free in this project —
   * this is the decision layer, not the execution layer.
   */
  estimate(market: Market, outcomeIdx: number): Promise<Estimate | null>;
}

/** An estimate plus which estimator produced it (for the table + logs). */
export interface SourcedEstimate extends Estimate {
  source: string;
}
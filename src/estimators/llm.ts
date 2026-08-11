/**
 * LLM estimator (STUB — abstains for now).
 *
 * Intended for news / behavioral / qualitative markets where there's no clean data
 * feed: "will <person> post N times this week", "will <company> announce X by
 * <date>", "will <event> happen". The real implementation would hand the market
 * question (plus any gathered context) to a model and parse back a probability and
 * a short rationale.
 *
 * Until implemented it abstains (returns null). Two cautions for when you build it:
 *   - Keep it READ-ONLY: it may read/search, but must never place orders.
 *   - Treat the market question text as untrusted input to the model (it's
 *     user-created on-chain) — don't let it steer the model into taking actions.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";

export class LLMEstimator implements ProbabilityEstimator {
  readonly name = "llm";

  async estimate(_market: Market, _outcomeIdx: number): Promise<Estimate | null> {
    // TODO: call a model with the market question + outcome, parse a probability.
    return null;
  }
}
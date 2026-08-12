/**
 * Mean-reversion estimator — trades the markets you actually have.
 *
 * Rationale: on thin LMSR prediction markets, when a 2-outcome market moves away
 * from its 0.50 initialization, the crowd tends to OVERSHOOT — pushing the favorite
 * a bit too far. This estimator nudges the probability back toward 0.50 by a small,
 * capped fraction, which puts a slight positive edge on the CHEAPER (underdog) side.
 *
 * Honest framing: this is a WEAK, generic edge, not a predictive model. It exists
 * so the agent participates on real markets instead of sitting idle. It's kept
 * deliberately small (a fractional pull toward 0.50, hard-capped) so the downstream
 * size-adjusted-edge, slippage, exposure and concentration guards keep positions
 * tiny and diversified.
 *
 * Fires only when:
 *   - the market has exactly 2 outcomes (clean binary), and
 *   - the price is skewed beyond a minimum band (|p − 0.5| ≥ minSkew), so we skip
 *     true coin-flips where there is no signal.
 * Abstains otherwise. Read-only; no side effects.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";
import { loadConfig } from "../config.js";

export class MeanReversionEstimator implements ProbabilityEstimator {
  readonly name = "meanrev";
  private readonly minSkew: number;
  private readonly pull: number;
  private readonly maxNudge: number;

  constructor() {
    const cfg = loadConfig();
    this.minSkew = cfg.meanrevMinSkew; // e.g. 0.10 → only fire when price ≤0.40 or ≥0.60
    this.pull = cfg.meanrevPull; // e.g. 0.20 → move 20% of the way back toward 0.5
    this.maxNudge = cfg.meanrevMaxNudge; // e.g. 0.06 → cap the probability shift
  }

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const outcomes = market.metadata?.outcomes ?? [];
    if (outcomes.length !== 2) return null; // binary only

    const implied = market.spotImpliedProbabilities?.[outcomeIdx];
    if (implied === undefined || Number.isNaN(implied)) return null;
    if (implied <= 0 || implied >= 1) return null; // resolved/degenerate

    const skew = Math.abs(implied - 0.5);
    if (skew < this.minSkew) return null; // too close to 50/50 → no signal

    // Nudge this outcome's probability toward 0.5 by `pull` of its distance,
    // capped by maxNudge. Underdog (implied < 0.5) gets nudged UP → positive edge.
    const rawShift = (0.5 - implied) * this.pull;
    const shift = Math.max(-this.maxNudge, Math.min(this.maxNudge, rawShift));
    const probability = clamp01(implied + shift);

    return {
      probability,
      // Weak, generic signal — low confidence keeps sizing tiny.
      confidence: 0.2,
      rationale: `mean-reversion: implied=${implied.toFixed(3)} → ${probability.toFixed(3)} (pull ${this.pull}, cap ${this.maxNudge})`,
    };
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
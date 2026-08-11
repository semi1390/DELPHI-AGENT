/**
 * Signal builder — the heart of the read-only decision layer.
 *
 * For one market outcome it assembles:
 *   - impliedProb        : the market's implied probability (the LMSR price view)
 *   - estimate           : your probability from the estimator router (may abstain)
 *   - edge               : estimate − impliedProb   (positive = possibly underpriced)
 *   - slippage probe     : average fill price for a small buy vs spot
 *   - edgeAfterSlippage  : estimate − avgProbePrice (does the edge survive paying up?)
 *
 * `edge` is measured against the *spot* price; `edgeAfterSlippage` is measured
 * against the price you'd actually pay for a small size. If edge is positive but
 * edgeAfterSlippage is not, the apparent mispricing doesn't survive execution.
 *
 * Everything here is read-only: estimators don't act, and the slippage probe is a
 * simulated quote.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { estimateProbability } from "./estimators/index.js";
import { probeBuySlippage, type QuoteProvider } from "./slippage.js";

export interface Signal {
  marketId: string;
  question: string;
  category: string;
  status: string;
  outcomeIdx: number;
  outcomeName: string;
  spotPrice: number | null;
  impliedProb: number | null;
  estimate: number | null;
  estimatorSource: string | null;
  confidence: number | null;
  edge: number | null;
  avgProbePrice: number | null;
  slippagePct: number | null;
  edgeAfterSlippage: number | null;
}

export interface BuildSignalOptions {
  probeShares: number;
  tokenDecimals: number;
}

/** Build signals for every outcome of a single market. */
export async function buildMarketSignals(
  quotes: QuoteProvider,
  market: Market,
  opts: BuildSignalOptions,
): Promise<Signal[]> {
  const outcomes = market.metadata?.outcomes ?? [];
  const prices = market.spotPrices ?? [];
  const implied = market.spotImpliedProbabilities ?? [];
  const marketAddress = market.id as `0x${string}`;

  // Probe each outcome in parallel; they're independent read-only quotes.
  return Promise.all(
    outcomes.map(async (name, idx): Promise<Signal> => {
      const spotPrice = prices[idx] ?? null;
      const impliedProb = implied[idx] ?? null;

      const est = await estimateProbability(market, idx);
      const estimate = est?.probability ?? null;
      const edge =
        estimate !== null && impliedProb !== null ? estimate - impliedProb : null;

      let avgProbePrice: number | null = null;
      let slippagePct: number | null = null;
      if (spotPrice !== null) {
        const probe = await probeBuySlippage(
          quotes,
          marketAddress,
          idx,
          spotPrice,
          opts.probeShares,
          opts.tokenDecimals,
        );
        if (probe) {
          avgProbePrice = probe.avgPrice;
          slippagePct = probe.slippagePct;
        }
      }

      const edgeAfterSlippage =
        estimate !== null && avgProbePrice !== null ? estimate - avgProbePrice : null;

      return {
        marketId: market.id,
        question: market.metadata?.question ?? "(question unavailable)",
        category: market.category,
        status: market.status,
        outcomeIdx: idx,
        outcomeName: name,
        spotPrice,
        impliedProb,
        estimate,
        estimatorSource: est?.source ?? null,
        confidence: est?.confidence ?? null,
        edge,
        avgProbePrice,
        slippagePct,
        edgeAfterSlippage,
      };
    }),
  );
}

/**
 * Sort signals best-first: edges that survive slippage on top, then raw edge.
 * Rows with no surviving-edge number sink below those that have one.
 */
export function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const av = a.edgeAfterSlippage ?? Number.NEGATIVE_INFINITY;
    const bv = b.edgeAfterSlippage ?? Number.NEGATIVE_INFINITY;
    if (bv !== av) return bv - av;
    const ae = a.edge ?? Number.NEGATIVE_INFINITY;
    const be = b.edge ?? Number.NEGATIVE_INFINITY;
    return be - ae;
  });
}
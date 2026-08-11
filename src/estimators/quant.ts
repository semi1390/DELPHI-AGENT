/**
 * Quant estimator — the crypto/macro "brain".
 *
 * For crypto threshold markets ("will [asset] be above/below [price] by [date]"):
 *   1. parse the market → asset, comparator/direction, threshold, settlement time
 *   2. fetch live spot + realized (annualized) volatility for the asset
 *   3. price P(proposition true) with a lognormal/GBM model
 *   4. map to the specific outcome (Yes/Above → P; No/Below → 1−P)
 *
 * Abstains (returns null → baseline, zero edge) whenever it can't parse the market,
 * can't classify the outcome, has no future settlement time, or can't get price/vol
 * data. It never guesses. Every produced estimate logs its intermediate values
 * (spot, σ, T, computed prob) so you can sanity-check it in the signal run.
 *
 * Price source is pluggable (CoinGecko by default, Binance optional) via config.
 * READ-ONLY: fetches market data only; never places orders.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";
import { parseThresholdMarket, outcomePolarity } from "../quant/parseMarket.js";
import { probThreshold } from "../quant/gbm.js";
import type { AssetStats, PriceDataOptions } from "../quant/priceData.js";
import { selectPriceSource, type PriceSource } from "../quant/priceSource.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Injectable fetcher for tests: (assetKey, symbol, opts) → stats|null. */
export type SpotVolFetcher = (
  assetKey: string,
  symbol: string,
  opts: PriceDataOptions,
) => Promise<AssetStats | null>;

export class QuantEstimator implements ProbabilityEstimator {
  readonly name = "quant";
  private readonly source: Pick<PriceSource, "name" | "fetch">;
  private readonly priceOpts: PriceDataOptions;
  private readonly drift: number;

  /** Pass a fetcher to bypass the real network in tests. */
  constructor(fetcher?: SpotVolFetcher) {
    const cfg = loadConfig();
    const selected = selectPriceSource(cfg);
    this.source = fetcher ? { name: "coingecko", fetch: fetcher } : selected;
    this.drift = cfg.quantDrift;
    this.priceOpts = {
      apiBase: selected.apiBase,
      volDays: cfg.quantVolDays,
      retry: { retries: cfg.retries, baseDelayMs: cfg.retryBaseMs, maxDelayMs: cfg.retryMaxMs },
    };
  }

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const parsed = parseThresholdMarket(market);
    if (!parsed.ok) {
      logger.debug("quant: not applicable", { market: market.id, reason: parsed.reason });
      return null;
    }

    const outcomeName = market.metadata?.outcomes?.[outcomeIdx] ?? "";
    const polarity = outcomePolarity(outcomeName);
    if (!polarity) {
      logger.debug("quant: cannot classify outcome polarity → abstain", { outcomeName });
      return null;
    }

    const tYears = (parsed.value.settlementMs - Date.now()) / YEAR_MS;
    if (tYears <= 0) {
      logger.debug("quant: settlement not in the future → abstain", { market: market.id });
      return null;
    }

    const stats = await this.source.fetch(parsed.value.asset, parsed.value.symbol, this.priceOpts);
    if (!stats) return null; // data unavailable → baseline (already logged)

    const pTrue = probThreshold({
      spot: stats.spot,
      strike: parsed.value.threshold,
      sigmaAnnual: stats.sigmaAnnual,
      tYears,
      drift: this.drift,
      direction: parsed.value.direction,
    });
    if (pTrue === null) return null;

    const probability = polarity === "aff" ? pTrue : 1 - pTrue;

    let confidence = 0.6;
    if (tYears < 1 / 365) confidence = 0.4; // under a day
    if (stats.samples < this.priceOpts.volDays * 0.8) confidence = Math.min(confidence, 0.4);

    logger.info("quant estimate", {
      market: market.id,
      asset: parsed.value.asset,
      outcome: outcomeName,
      direction: parsed.value.direction,
      threshold: parsed.value.threshold,
      spot: round(stats.spot),
      sigmaAnnual: round(stats.sigmaAnnual, 4),
      volSamples: stats.samples,
      tYears: round(tYears, 5),
      settlementSource: parsed.value.settlementSource,
      dataSource: stats.source,
      pTrue: round(pTrue, 4),
      probability: round(probability, 4),
    });

    return {
      probability,
      confidence,
      rationale:
        `GBM ${parsed.value.asset} ${polarity === "aff" ? "" : "¬"}` +
        `(${parsed.value.direction === "gt" ? ">" : "<"}${parsed.value.threshold}) ` +
        `S=${round(stats.spot)} σ=${(stats.sigmaAnnual * 100).toFixed(0)}% ` +
        `T=${round(tYears, 4)}y`,
    };
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
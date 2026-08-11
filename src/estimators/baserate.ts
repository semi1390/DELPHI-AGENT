/**
 * Base-rate estimator — count / recurring-event markets (auto-fetched rates + NB).
 *
 * For "how many times [entity] does [X] over [window]" markets:
 *   1. parse the count band [low, high] and window length (days)
 *   2. FETCH the entity's recent daily posting counts from its live source
 *      (e.g. trumpstruth.org) — trailing mean/day AND daily variance
 *   3. model the window count with a NEGATIVE BINOMIAL (over-dispersion from the
 *      observed daily variance), so bursty posting doesn't understate the tails
 *   4. P(Yes) = P(low ≤ N ≤ high); map to the outcome
 *
 * Abstains (→ baseline, zero edge) on: non-count questions, unclassifiable
 * outcomes, entities with no fetchable source, or any fetch/parse failure. It
 * NEVER falls back to a guessed rate. Logs the fetched rate, NB params, and prob.
 *
 * READ-ONLY: fetches public post data; never places orders.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";
import { outcomePolarity } from "../quant/parseMarket.js";
import { parseCountMarket } from "../baserate/parseCount.js";
import { negBinomRangeProb, dispersionFromMoments } from "../baserate/nb.js";
import { loadRates, type EntityConfig } from "../baserate/rates.js";
import { getRateFetcher, type SourceOptions } from "../baserate/sources/index.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

export class BaseRateEstimator implements ProbabilityEstimator {
  readonly name = "baserate";
  private readonly entities: EntityConfig[];
  private readonly sourceOpts: SourceOptions;

  constructor(path = "base-rates.json") {
    const cfg = loadConfig();
    this.entities = loadRates(path);
    this.sourceOpts = {
      lookbackDays: cfg.baseRateLookbackDays,
      cacheTtlMs: cfg.baseRateCacheHours * 60 * 60 * 1000,
      trumpsTruthBaseUrl: cfg.trumpsTruthBaseUrl,
      dropZeroDays: cfg.baseRateDropZeroDays,
      countMode: cfg.baseRateCountMode,
      repostPattern: new RegExp(cfg.baseRateRepostPattern, "i"),
      retry: { retries: cfg.retries, baseDelayMs: cfg.retryBaseMs, maxDelayMs: cfg.retryMaxMs },
    };
  }

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const parsed = parseCountMarket(market, this.entities);
    if (!parsed.ok) {
      logger.debug("baserate: not applicable", { market: market.id, reason: parsed.reason });
      return null;
    }

    const outcomeName = market.metadata?.outcomes?.[outcomeIdx] ?? "";
    const polarity = outcomePolarity(outcomeName);
    if (!polarity) {
      logger.debug("baserate: cannot classify outcome polarity → abstain", { outcomeName });
      return null;
    }

    const entity = this.entities.find((e) => e.key === parsed.value.entityKey);
    if (!entity) return null;

    // Resolve the rate: live source preferred, manual override honored, else abstain.
    const rate = await this.resolveRate(entity, parsed.value.windowDays);
    if (!rate) {
      logger.debug("baserate: no fetchable rate for entity → abstain", { entity: entity.key });
      return null;
    }

    const { low, high, windowDays } = parsed.value;
    const windowMean = rate.meanPerDay * windowDays;
    const windowVar = rate.variancePerDay * windowDays; // variance adds over independent days
    const r = dispersionFromMoments(windowMean, windowVar);
    const pYes = negBinomRangeProb(low, high, windowMean, r);
    if (!Number.isFinite(pYes)) return null;

    const probability = polarity === "aff" ? pYes : 1 - pYes;
    const overdispersion = windowVar > windowMean ? windowVar / windowMean : 1;

    logger.info("baserate estimate", {
      market: market.id,
      entity: entity.key,
      outcome: outcomeName,
      rateSource: rate.source,
      meanPerDay: round(rate.meanPerDay, 2),
      lookbackDays: rate.lookbackDays,
      droppedZeroDays: rate.droppedZeroDays,
      meanWithZeros: rate.meanWithZeros !== undefined ? round(rate.meanWithZeros, 2) : undefined,
      meanWithoutZeros: rate.meanWithoutZeros !== undefined ? round(rate.meanWithoutZeros, 2) : undefined,
      countMode: rate.countMode,
      repostsDetected: rate.repostsDetected,
      windowDays: round(windowDays, 2),
      band: high === Infinity ? `>=${low}` : `${low}..${high}`,
      windowMean: round(windowMean, 1),
      overdispersion: round(overdispersion, 2),
      nbDispersionR: Number.isFinite(r) ? round(r, 1) : "inf(Poisson)",
      pYes: round(pYes, 4),
      probability: round(probability, 4),
    });

    return {
      probability,
      // Coarse model on noisy behavior — keep confidence modest.
      confidence: 0.5,
      rationale:
        `NB μ=${round(windowMean, 1)} ` +
        `(${round(rate.meanPerDay, 1)}/day×${round(windowDays, 1)}d, ${rate.source}) ` +
        `overdisp=${round(overdispersion, 1)}× ` +
        `P(${high === Infinity ? `≥${low}` : `${low}–${high}`})=${round(pYes, 3)}`,
    };
  }

  private async resolveRate(
    entity: EntityConfig,
    windowDays: number,
  ): Promise<{
    meanPerDay: number;
    variancePerDay: number;
    lookbackDays: number;
    source: string;
    droppedZeroDays?: number;
    meanWithZeros?: number;
    meanWithoutZeros?: number;
    countMode?: string;
    repostsDetected?: number;
    totalItems?: number;
  } | null> {
    // Manual override wins if present.
    if (entity.ratePerDay !== undefined) {
      return {
        meanPerDay: entity.ratePerDay,
        variancePerDay: entity.ratePerDay,
        lookbackDays: 0,
        source: "manual override",
      };
    }
    const fetcher = getRateFetcher(entity.source);
    if (!fetcher) return null;
    const model = await fetcher(this.sourceOpts);
    if (!model) return null;
    return model;
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
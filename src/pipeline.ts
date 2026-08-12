/**
 * Shared plan-cycle pipeline (READ-ONLY).
 *
 * One function that runs the full observation pipeline for a single cycle:
 *   open markets → per-market signals (fault-tolerant) → planTrades (sizing +
 *   size-adjusted edge + slippage/exposure/concentration guards) → a plan.
 * Used by BOTH the one-shot `npm run plan` script and the 24/7 worker, so they
 * can never drift. It computes and returns; it never places orders.
 */

import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { ResilientReader } from "./resilientClient.js";
import type { AppConfig } from "./config.js";
import { buildMarketSignals, type Signal } from "./signal.js";
import { planTrades, type Plan } from "./trading/planner.js";
import { logger } from "./logger.js";

export interface CycleResult {
  runId: string;
  at: string;
  plan: Plan;
  markets: Market[];
  openMarkets: number;
  failedMarkets: number;
  tokenDecimals: number;
}

/** Run one full read-only plan cycle. Never throws for a single bad market. */
export async function runPlanCycle(
  reader: ResilientReader,
  config: AppConfig,
  runId: string,
): Promise<CycleResult> {
  const at = new Date().toISOString();

  const { decimals: tokenDecimals } = await reader.getErc20BalanceWithDecimals();
  const { markets } = await reader.listMarkets({
    status: "open",
    limit: config.marketScanLimit,
    pricesAndImpliedProbabilities: true,
  });
  const open = markets ?? [];

  const signals: Signal[] = [];
  let failedMarkets = 0;
  for (const m of open) {
    try {
      const rows = await buildMarketSignals(reader, m, {
        probeShares: config.probeShares,
        tokenDecimals,
      });
      signals.push(...rows);
    } catch (err) {
      failedMarkets++;
      logger.warn("Skipping market after repeated failures", {
        market: m.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const plan = await planTrades(reader, signals, {
    bankroll: config.bankroll,
    kellyFraction: config.kellyFraction,
    maxPositionPerMarket: config.maxPositionPerMarket,
    maxTotalExposure: config.maxTotalExposure,
    minEdgeToTrade: config.minEdgeToTrade,
    slippageTolerance: config.slippageTolerance,
    minOrderTst: config.minOrderTst,
    maxSlippagePct: config.maxSlippagePct,
    maxConcentration: config.maxConcentration,
    tokenDecimals,
  });

  return { runId, at, plan, markets: open, openMarkets: open.length, failedMarkets, tokenDecimals };
}

/** Placeholder so the type is imported where the gated live path lives. */
export type { DelphiClient };
/**
 * tradePlan.ts — one-shot DRY-RUN plan (npm run plan).
 *
 * Runs a single observation cycle via the shared pipeline and prints the intended
 * orders + portfolio. Places ZERO orders by default. The gated live path exists in
 * ./execute.ts and is reached ONLY if DRY_RUN=false (not the default); the 24/7
 * worker never touches it.
 *
 * Run:  npm run plan
 */

import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, assertPrivateKey } from "../src/config.js";
import { runPlanCycle } from "../src/pipeline.js";
import { renderPlan, persistCycle } from "../src/planLog.js";
import { executeLivePlan } from "../src/trading/execution.js";
import { logger } from "../src/logger.js";

async function main(): Promise<void> {
  const { client, reader, config } = createDelphiClient();
  assertApiKey(config);
  assertPrivateKey(config);

  const dryRun = config.dryRun;
  const runId = `${Date.now().toString(36)}`;
  logger.info("heartbeat: trade-plan starting", { runId, dryRun, mode: dryRun ? "DRY-RUN (no orders)" : "LIVE" });
  if (!dryRun) {
    logger.warn("⚠ LIVE MODE (DRY_RUN=false): this run WILL place real orders on competition-testnet.");
  }

  const result = await runPlanCycle(reader, config, runId);
  renderPlan(result.plan, config.maxTotalExposure, dryRun);
  await persistCycle(config.planLogFile, runId, result.at, result.plan, dryRun);

  if (dryRun) {
    logger.info("DRY-RUN: no orders placed. Set DRY_RUN=false to enable the live path.");
  } else {
    const exec = await executeLivePlan({
      client, reader, plan: result.plan, markets: result.markets, dryRun: false,
      config: {
        maxTotalExposure: config.maxTotalExposure,
        maxLiveExposure: config.maxLiveExposure,
        minOrderTst: config.minOrderTst,
        slippageTolerance: config.slippageTolerance,
        tokenDecimals: result.tokenDecimals,
        redeemEnabled: config.redeemEnabled,
        takeProfitEnabled: config.takeProfitEnabled,
        takeProfitPct: config.takeProfitPct,
        sellSlippageTolerance: config.sellSlippageTolerance,
        topUpEnabled: config.topUpEnabled,
        topUpMaxWorse: config.topUpMaxWorse,
      },
    });
    logger.warn("live: execution report", {
      filled: exec.fills.length, spent: Number(exec.spent.toFixed(2)),
      redeemedTokens: exec.redeemedTokens, skips: exec.skips.length, errors: exec.errors.length,
    });
    for (const f of exec.fills) logger.info("live: fill", f);
  }

  logger.info("heartbeat: trade-plan complete", {
    runId, dryRun,
    openMarkets: result.openMarkets, failedMarkets: result.failedMarkets,
    intendedOrders: result.plan.orders.length, skips: result.plan.skips.length,
  });
}

main().catch((err) => {
  logger.error("tradePlan failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
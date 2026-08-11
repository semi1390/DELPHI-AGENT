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
import { executeOrder } from "../src/trading/execute.js";
import type { IntendedOrder } from "../src/trading/planner.js";
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
    // GATED LIVE PATH — only reached when DRY_RUN=false (not the default).
    logger.warn("Placing live orders…", { count: result.plan.orders.length });
    let placed = 0;
    for (const o of result.plan.orders as IntendedOrder[]) {
      try {
        await executeOrder(client, o, { dryRun: false });
        placed++;
      } catch (err) {
        logger.error("Order failed", { market: o.marketId, message: err instanceof Error ? err.message : String(err) });
      }
    }
    logger.warn("Live run complete", { placed });
  }

  logger.info("heartbeat: trade-plan complete", {
    runId,
    dryRun,
    openMarkets: result.openMarkets,
    failedMarkets: result.failedMarkets,
    intendedOrders: result.plan.orders.length,
    skips: result.plan.skips.length,
    totalExposure: Number(result.plan.portfolio.totalExposure.toFixed(2)),
  });
}

main().catch((err) => {
  logger.error("tradePlan failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
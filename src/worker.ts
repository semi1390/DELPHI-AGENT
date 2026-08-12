/**
 * worker.ts — long-running scheduled worker (Railway entrypoint). DRY-RUN ONLY.
 *
 * Runs the full observation pipeline (open markets → signals → edge → size-adjusted
 * sizing → risk guards → intended portfolio) every PLAN_INTERVAL_MINUTES, forever.
 * Each cycle logs heartbeats + timestamps, renders the intended-orders table, and
 * (optionally) appends the intended orders to PLAN_LOG_FILE for later review.
 *
 * Zero execution. DRY_RUN defaults to true; this worker NEVER calls the live path
 * even if DRY_RUN=false — turning on real trading is a separate, deliberate build.
 * A cycle that fails is logged and skipped; the loop continues to the next tick.
 */

import { createDelphiClient } from "./delphi.js";
import { assertApiKey, assertPrivateKey, loadConfig } from "./config.js";
import { runPlanCycle } from "./pipeline.js";
import { renderPlan, persistCycle } from "./planLog.js";
import { executeLivePlan } from "./trading/execution.js";
import { logger, section } from "./logger.js";

let timer: NodeJS.Timeout | undefined;
let cycles = 0;
let running = false;
const bootedAt = Date.now();

async function runOnce(): Promise<void> {
  if (running) {
    logger.warn("heartbeat: previous cycle still running, skipping this tick");
    return;
  }
  running = true;
  cycles += 1;
  const runId = `${Date.now().toString(36)}-${cycles}`;
  const cycleStart = Date.now();
  const uptimeMin = Math.round((Date.now() - bootedAt) / 60_000);

  const { client, reader, config } = createDelphiClient();
  logger.info("heartbeat: cycle start", { runId, cycle: cycles, uptimeMin, dryRun: config.dryRun });

  try {
    const result = await runPlanCycle(reader, config, runId);
    renderPlan(result.plan, config.maxTotalExposure, config.dryRun);
    await persistCycle(config.planLogFile, runId, result.at, result.plan, config.dryRun);

    if (!config.dryRun) {
      // ── LIVE EXECUTION (DRY_RUN=false) ──────────────────────────────────────
      const exec = await executeLivePlan({
        client,
        reader,
        plan: result.plan,
        markets: result.markets,
        dryRun: false,
        config: {
          maxTotalExposure: config.maxTotalExposure,
          maxLiveExposure: config.maxLiveExposure,
          minOrderTst: config.minOrderTst,
          slippageTolerance: config.slippageTolerance,
          tokenDecimals: result.tokenDecimals,
          redeemEnabled: config.redeemEnabled,
        },
      });
      logger.info("live: execution report", {
        runId,
        wallet: exec.wallet,
        balanceBefore: exec.balanceBefore,
        liveExposureBefore: exec.currentLiveExposureBefore,
        redeemedMarkets: exec.redeemedMarkets,
        redeemedTokens: exec.redeemedTokens,
        filled: exec.fills.length,
        spent: Number(exec.spent.toFixed(2)),
        skips: exec.skips.length,
        errors: exec.errors.length,
        stuckNeedingLiquidation: exec.stuckNeedingLiquidation,
      });
    }

    logger.info("heartbeat: cycle complete", {
      runId,
      cycle: cycles,
      mode: config.dryRun ? "DRY-RUN" : "LIVE",
      openMarkets: result.openMarkets,
      failedMarkets: result.failedMarkets,
      intendedOrders: result.plan.orders.length,
      skips: result.plan.skips.length,
      totalExposure: Number(result.plan.portfolio.totalExposure.toFixed(2)),
      elapsedMs: Date.now() - cycleStart,
    });
  } catch (err) {
    // A whole-cycle failure (after the read layer's own retries) must not kill the
    // worker — log it and let the next tick try again.
    logger.error("cycle failed (worker stays alive)", {
      runId,
      cycle: cycles,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertApiKey(config);
  assertPrivateKey(config); // quoteBuy builds the signer (read-only)

  section("Delphi agent — scheduled worker (DRY-RUN observation)");
  logger.info("worker starting", {
    dryRun: config.dryRun,
    intervalMinutes: config.planIntervalMinutes,
    network: config.network,
    planLogFile: config.planLogFile ?? "(stdout only)",
  });
  if (!config.dryRun) {
    logger.warn("DRY_RUN=false is set, but this WORKER never executes — it is observation-only. Use the live path deliberately elsewhere.");
  }

  await runOnce(); // run immediately on boot
  timer = setInterval(() => {
    void runOnce();
  }, config.planIntervalMinutes * 60_000);
}

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down worker.`, { cycles, uptimeMin: Math.round((Date.now() - bootedAt) / 60_000) });
  if (timer) clearInterval(timer);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection (worker stays alive)", {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((err) => {
  logger.error("worker failed to start", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
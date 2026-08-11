/**
 * Plan-cycle rendering + persistence.
 *
 * `renderPlan` prints the human-readable intended-orders table, skips, and
 * portfolio (shared by the one-shot script and the worker). `persistCycle` appends
 * one JSON line per intended order to PLAN_LOG_FILE so you can review the history
 * of what the agent flagged and later check it against real settlements.
 *
 * NOTE: on Railway the container filesystem is EPHEMERAL — a JSONL file survives
 * restarts only if you attach a Volume and point PLAN_LOG_FILE at it. Structured
 * stdout logs (which Railway retains + lets you search) are the primary record;
 * the file is a convenience for durable, machine-readable history.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plan } from "./trading/planner.js";
import { logger, section } from "./logger.js";

function pad(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + "…";
}
function sign(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(4);
}

export function renderPlan(plan: Plan, maxTotalExposure: number, dryRun: boolean): void {
  section(`Intended orders — ${plan.orders.length} (${dryRun ? "DRY-RUN" : "LIVE"})`);
  if (plan.orders.length === 0) {
    console.log("  (none — no candidate cleared the guards after size-adjustment)");
  } else {
    console.log(
      "  " + pad("MARKET", 26) + " " + pad("OUTCOME", 12) + " " + pad("src", 9) +
        "  1sh-edge  adj-edge  size(TST)  avgFill  slip     shrunk",
    );
    console.log("  " + "─".repeat(104));
    for (const o of plan.orders) {
      console.log(
        "  " + pad(o.question, 26) + " " + pad(o.outcomeName, 12) + " " + pad(o.source, 9) +
          "  " + sign(o.oneShareEdge) + "  " + sign(o.sizeAdjustedEdge) +
          "   " + pad(o.expectedCostTst.toFixed(2), 8) +
          "  " + o.avgFillPrice.toFixed(3) +
          "  " + (o.expectedSlippagePct >= 0 ? "+" : "") + o.expectedSlippagePct.toFixed(1) + "%" +
          "    " + (o.shrunk ? `yes (${o.shrinkReason})` : "no"),
      );
    }
  }

  if (plan.skips.length > 0) {
    section(`Skipped / dropped — ${plan.skips.length}`);
    for (const s of plan.skips) {
      console.log(`  ${pad(s.outcomeName, 16)} ${pad(s.source, 9)} 1sh-edge=${s.oneShareEdge?.toFixed(4) ?? "n/a"}  → ${s.reason}`);
    }
  }

  section("Intended portfolio");
  const p = plan.portfolio;
  console.log(`  Total exposure:        ${p.totalExposure.toFixed(2)} TST  (${p.utilizationPct.toFixed(1)}% of max ${maxTotalExposure.toFixed(2)})`);
  console.log(`  Markets held:          ${p.marketsCount}`);
  console.log(`  Concentration cap:     ${p.concentrationCapPct.toFixed(1)}% per market (effective)`);
  console.log(`  Largest concentration: ${p.largestMarketSharePct.toFixed(1)}% of exposure in one market`);
  for (const m of p.byMarket) {
    const pct = p.totalExposure > 0 ? (m.exposure / p.totalExposure) * 100 : 0;
    console.log(`     ${pad(m.question, 40)}  ${m.exposure.toFixed(2)} TST  (${pct.toFixed(1)}%)`);
  }
}

/** Append one JSON line per intended order (and a summary line) to PLAN_LOG_FILE. */
export async function persistCycle(
  filePath: string | undefined,
  runId: string,
  at: string,
  plan: Plan,
  dryRun: boolean,
): Promise<void> {
  if (!filePath) return;
  const rows = plan.orders.map((o) =>
    JSON.stringify({
      ts: at, runId, dryRun, kind: "intended_order",
      marketId: o.marketId, question: o.question, outcomeIdx: o.outcomeIdx, outcomeName: o.outcomeName,
      source: o.source, estimate: o.estimate, impliedProb: o.impliedProb,
      oneShareEdge: o.oneShareEdge, sizeAdjustedEdge: o.sizeAdjustedEdge,
      sizeTst: o.expectedCostTst, avgFillPrice: o.avgFillPrice, slippagePct: o.expectedSlippagePct,
      shrunk: o.shrunk, shrinkReason: o.shrinkReason ?? null,
    }),
  );
  rows.push(
    JSON.stringify({
      ts: at, runId, dryRun, kind: "cycle_summary",
      intendedOrders: plan.orders.length, skips: plan.skips.length,
      totalExposure: plan.portfolio.totalExposure, markets: plan.portfolio.marketsCount,
    }),
  );
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, rows.join("\n") + "\n", "utf8");
    logger.debug("Persisted cycle to plan log", { filePath, orders: plan.orders.length, runId });
  } catch (err) {
    logger.warn("Failed to write plan log (continuing)", {
      filePath, message: err instanceof Error ? err.message : String(err),
    });
  }
}
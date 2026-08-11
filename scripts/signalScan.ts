/**
 * signalScan.ts — read-only edge / signal layer (Prompt 2).
 *
 * Pipeline (NO trading, NO order execution anywhere):
 *   1. list OPEN markets only (with on-chain prices + implied probabilities)
 *   2. for each outcome: estimate your probability (pluggable estimators)
 *   3. edge = your estimate − market-implied probability
 *   4. probe a small buy via read-only quote → average fill price + slippage%
 *   5. edgeAfterSlippage = your estimate − average fill price
 *   6. print a sorted table and log each signal (optionally to a JSONL file)
 *
 * Needs DELPHI_API_ACCESS_KEY (to list markets) and WALLET_PRIVATE_KEY (the SDK
 * builds a signer to obtain the public client used by the quote — still a pure
 * read; no transaction is ever sent).
 *
 * Run:  npm run signal
 */

import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, assertPrivateKey } from "../src/config.js";
import { buildMarketSignals, sortSignals, type Signal } from "../src/signal.js";
import { appendSignals, newRunId } from "../src/signalLog.js";
import { logger, section } from "../src/logger.js";

function fmt(n: number | null, digits = 4): string {
  return n === null || Number.isNaN(n) ? "   n/a" : n.toFixed(digits);
}
function fmtPct(n: number | null): string {
  return n === null || Number.isNaN(n) ? "  n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtEdge(n: number | null): string {
  return n === null || Number.isNaN(n) ? "   n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}
function truncate(s: string, len: number): string {
  return s.length <= len ? s.padEnd(len) : s.slice(0, len - 1) + "…";
}

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertApiKey(config); // list markets
  assertPrivateKey(config); // quote builds the signer (read-only)

  const runId = newRunId();
  const startedAt = Date.now();
  // Heartbeat #1: emitted before any network call, so a scheduler sees the run
  // started even if the first fetch is slow or fails.
  logger.info("heartbeat: signal run starting", { runId, at: new Date().toISOString() });

  // Health + collateral token decimals (needed to price the slippage probe).
  try {
    const health = await reader.health();
    logger.info("REST API health", { status: health.status });
  } catch (err) {
    logger.warn("Health check failed (continuing)", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const { decimals: tokenDecimals } = await reader.getErc20BalanceWithDecimals();

  // OPEN markets only — the whole point of Prompt 2's filter.
  const { markets } = await reader.listMarkets({
    status: "open",
    limit: config.marketScanLimit,
    pricesAndImpliedProbabilities: true,
  });
  const openMarkets = markets ?? [];
  logger.info("Fetched open markets", {
    count: openMarkets.length,
    probeShares: config.probeShares,
    minEdge: config.minEdge,
    runId,
  });

  if (openMarkets.length === 0) {
    logger.warn("No open markets right now. The tradeable field varies through the competition.");
    return;
  }

  // Build signals for every outcome of every open market. Each market is isolated:
  // if one still fails after retries, we skip it and keep going rather than
  // crashing the whole scan.
  const all: Signal[] = [];
  let failedMarkets = 0;
  for (const market of openMarkets) {
    try {
      const rows = await buildMarketSignals(reader, market, {
        probeShares: config.probeShares,
        tokenDecimals,
      });
      all.push(...rows);
    } catch (err) {
      failedMarkets += 1;
      logger.warn("Skipping market after repeated failures", {
        market: market.id,
        question: market.metadata?.question,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sorted = sortSignals(all);

  // ── Table ────────────────────────────────────────────────────────────────
  section(`Signals — ${all.length} outcomes across ${openMarkets.length} open markets`);
  console.log(
    "  " +
      truncate("MARKET", 34) +
      " " +
      truncate("OUTCOME", 16) +
      "  price   implied  myEst    edge    slip   edgeAfterSlip  src",
  );
  console.log("  " + "─".repeat(112));

  for (const s of sorted) {
    const flag = s.edgeAfterSlippage !== null && s.edgeAfterSlippage >= config.minEdge ? " *" : "  ";
    console.log(
      flag +
        truncate(s.question, 34) +
        " " +
        truncate(s.outcomeName, 16) +
        "  " +
        fmt(s.spotPrice, 3) +
        "   " +
        fmt(s.impliedProb, 3) +
        "   " +
        fmt(s.estimate, 3) +
        "  " +
        fmtEdge(s.edge) +
        "  " +
        fmtPct(s.slippagePct) +
        "     " +
        fmtEdge(s.edgeAfterSlippage) +
        "   " +
        (s.estimatorSource ?? "-"),
    );
  }

  const candidates = sorted.filter(
    (s) => s.edgeAfterSlippage !== null && s.edgeAfterSlippage >= config.minEdge,
  );
  console.log("");
  logger.info("heartbeat: signal run complete", {
    runId,
    outcomes: all.length,
    openMarkets: openMarkets.length,
    failedMarkets,
    buyCandidates: candidates.length,
    minEdge: config.minEdge,
    elapsedMs: Date.now() - startedAt,
  });
  if (candidates.length === 0) {
    logger.info(
      "No outcomes clear the edge threshold after slippage — expected with the " +
        "baseline estimator (zero edge). Set manual overrides or implement quant/llm.",
    );
  }

  // Optional JSONL history for scheduled runs.
  await appendSignals(config.signalLogFile, runId, sorted);
}

main().catch((err) => {
  logger.error("signalScan failed", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
/**
 * index.ts — long-running entrypoint (READ-ONLY).
 *
 * This is what `npm start` runs, and what Railway runs as a worker. It does NOT
 * place trades. It performs a one-time connect + wallet + market read, then stays
 * alive with a periodic read-only heartbeat so the process is genuinely "24/7"
 * without crash-looping. All reads go through the resilient reader (retry +
 * backoff), and the heartbeat never throws — a failed poll is logged and the next
 * one still fires. The trading loop is intentionally not built yet.
 */

import { createDelphiClient } from "./delphi.js";
import { assertApiKey, assertPrivateKey } from "./config.js";
import { formatGas, formatToken, formatPrice, formatPct } from "./format.js";
import { logger, section } from "./logger.js";
import type { ResilientReader } from "./resilientClient.js";

let heartbeatTimer: NodeJS.Timeout | undefined;
let beats = 0;
const bootedAt = Date.now();

async function startupChecks(): Promise<void> {
  const { reader, config } = createDelphiClient();

  // Require both secrets: the key (address/balances) and the API key (markets).
  assertPrivateKey(config);
  assertApiKey(config);

  section("Startup checks");

  // 1) API reachability.
  try {
    const health = await reader.health();
    logger.info("REST API health", { status: health.status });
  } catch (err) {
    logger.warn("Health check failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2) Wallet + funding.
  const { address } = await reader.getSigner();
  const gasWei = await reader.getEthBalance();
  const { balance, decimals } = await reader.getErc20BalanceWithDecimals();
  logger.info("Wallet", {
    address,
    tst: formatToken(balance, decimals),
    ethGas: formatGas(gasWei),
  });
  if (gasWei === 0n) logger.warn("Gas balance is 0 — fund before trading.");
  if (balance === 0n) logger.warn("TST balance is 0 — fund before trading.");

  // 3) One market read to prove data flow.
  const { markets } = await reader.listMarkets({
    status: "open",
    limit: 5,
    pricesAndImpliedProbabilities: true,
  });
  const sample = markets ?? [];
  logger.info("Sampled open markets", { count: sample.length });
  const first = sample[0];
  if (first) {
    logger.info("Top market", {
      question: first.metadata?.question ?? "(unavailable)",
      status: first.status,
      outcomes: first.metadata?.outcomes ?? [],
      spotPrices: (first.spotPrices ?? []).map((p) => formatPrice(p)),
      implied: (first.spotImpliedProbabilities ?? []).map((p) => formatPct(p)),
    });
  }

  // 4) Heartbeat: keep the process alive with a light, read-only balance poll.
  const everyMs = config.heartbeatMinutes * 60_000;
  logger.info("Entering read-only heartbeat (no trading in this prompt)", {
    everyMinutes: config.heartbeatMinutes,
  });
  heartbeatTimer = setInterval(() => {
    void heartbeat(reader);
  }, everyMs);
}

async function heartbeat(reader: ResilientReader): Promise<void> {
  beats += 1;
  const uptimeMin = Math.round((Date.now() - bootedAt) / 60_000);
  try {
    const gasWei = await reader.getEthBalance();
    const { balance, decimals } = await reader.getErc20BalanceWithDecimals();
    logger.info("heartbeat: alive", {
      beat: beats,
      uptimeMin,
      tst: formatToken(balance, decimals),
      ethGas: formatGas(gasWei),
    });
  } catch (err) {
    // Even after retries this can fail; log and stay alive for the next beat.
    logger.warn("heartbeat: alive but read failed", {
      beat: beats,
      uptimeMin,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down.`, { beats, uptimeMin: Math.round((Date.now() - bootedAt) / 60_000) });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Keep the worker alive on unexpected errors rather than crash-looping on Railway.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection (staying alive)", {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

startupChecks().catch((err) => {
  logger.error("Startup failed", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
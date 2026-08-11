/**
 * marketScan.ts — read live competition markets.
 *
 * Connects to competition-testnet, lists available markets, and for each prints:
 *   - the market question
 *   - its outcomes
 *   - the current on-chain spot price and implied probability per outcome
 *
 * On competition-testnet these are LMSR markets; the SDK exposes their on-chain
 * spot prices via `spotPrices` / `spotImpliedProbabilities`, which are only
 * populated when we pass `pricesAndImpliedProbabilities: true`.
 *
 * READ-ONLY. This uses the REST API, so it needs DELPHI_API_ACCESS_KEY. No wallet
 * private key is required just to scan.
 *
 * Run:  npm run scan
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey } from "../src/config.js";
import { formatPrice, formatPct } from "../src/format.js";
import { logger, section } from "../src/logger.js";

async function main(): Promise<void> {
  const { client, config } = createDelphiClient();
  assertApiKey(config);

  // Connectivity check (unauthenticated) — fails fast with a clear message if the
  // API is unreachable, before we try an authenticated list.
  try {
    const health = await client.health();
    logger.info("REST API health", { status: health.status });
  } catch (err) {
    logger.warn("Health check failed (continuing to try listMarkets)", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Only OPEN (tradeable) markets — settled/failed ones aren't actionable.
  const { markets } = await client.listMarkets({
    status: "open",
    limit: config.marketScanLimit,
    pricesAndImpliedProbabilities: true,
  });

  const list: Market[] = markets ?? [];
  section(`Open markets (${list.length})`);

  if (list.length === 0) {
    logger.warn(
      "No open markets right now. The tradeable field varies through the " +
        "competition as markets open and settle. (If this is unexpected, confirm " +
        "your API key is a testnet key and a competition is active.)",
    );
    return;
  }

  for (const [i, market] of list.entries()) {
    printMarket(i + 1, market);
  }

  logger.info("Scan complete", { count: list.length, network: config.network });
}

function printMarket(index: number, market: Market): void {
  const question = market.metadata?.question ?? "(question metadata unavailable)";
  const outcomes = market.metadata?.outcomes ?? [];
  const prices = market.spotPrices ?? [];
  const probs = market.spotImpliedProbabilities ?? [];

  console.log(`\n[${index}] ${question}`);
  console.log(`     status: ${market.status}   category: ${market.category}`);
  console.log(`     market: ${market.id}`);
  if (market.marketUrl) console.log(`     url:    ${market.marketUrl}`);

  if (outcomes.length === 0) {
    console.log("     outcomes: (none listed in metadata)");
    return;
  }

  console.log("     outcomes:");
  outcomes.forEach((name, idx) => {
    const price = formatPrice(prices[idx]);
    const prob = formatPct(probs[idx]);
    const label = `${idx}. ${name}`.padEnd(28);
    console.log(`        ${label} price=${price}  implied=${prob}`);
  });

  if (prices.length === 0) {
    console.log(
      "     (no live prices returned for this market — it may not be open for trading)",
    );
  }
}

main().catch((err) => {
  logger.error("marketScan failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
/**
 * sellDebug.ts — diagnose why sellShares reverts (run on YOUR terminal, real chain).
 *
 * For each open position you hold, it:
 *   1. prints the position (market, outcome, shares)
 *   2. calls quoteSell (read-only) → expected tokensOut
 *   3. ATTEMPTS a real sell of a chosen % of the position and prints the FULL raw
 *      error (including the revert selector) so we can finally decode it.
 *
 * Usage:
 *   npm run selldebug            # dry: shows positions + quotes, NO sell
 *   npm run selldebug -- --sell  # attempts a real sell on the FIRST position
 *   npm run selldebug -- --sell --pct 50   # sell 50% of it
 */
import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, assertPrivateKey } from "../src/config.js";
import { logger, section } from "../src/logger.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

async function main(): Promise<void> {
  const { client, reader, config } = createDelphiClient();
  assertApiKey(config); assertPrivateKey(config);
  const doSell = arg("sell") !== undefined;
  const pct = Math.min(100, Math.max(1, Number(arg("pct", "100"))));
  const { address: wallet } = await reader.getSigner();

  // gather positions
  const all: any[] = [];
  for (let p = 0; p < 20; p++) {
    const { positions } = await reader.listPositions({ wallet, skip: p * 50, limit: 50 });
    const b = positions ?? []; all.push(...b); if (b.length < 50) break;
  }
  const held = all.filter((p) => !p.redeemedOrLiquidated && BigInt(p.shares || "0") > 0n);
  section(`Positions held: ${held.length}`);
  for (const p of held) console.log(`  ${p.marketProxy} outcome=${p.outcomeIdx} shares=${p.shares} status=${p.marketStatus}`);

  const open = held.filter((p) => p.marketStatus === "open");
  if (open.length === 0) { logger.warn("No OPEN positions to sell (settled ones must be redeemed)."); return; }

  section("Quote each open position (read-only)");
  for (const p of open) {
    try {
      const q = await reader.quoteSell({ marketAddress: p.marketProxy, outcomeIdx: Number(p.outcomeIdx), sharesIn: BigInt(p.shares) });
      console.log(`  ${p.marketProxy} o=${p.outcomeIdx}: quoteSell tokensOut=${q.tokensOut}`);
    } catch (e) {
      console.log(`  ${p.marketProxy} o=${p.outcomeIdx}: quoteSell FAILED → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!doSell) { logger.info("Dry mode. Re-run with --sell to attempt a real sell and capture the revert."); return; }

  const target = open[0];
  const shares = BigInt(target.shares);
  const sellShares = (shares * BigInt(pct)) / 100n;
  section(`ATTEMPTING REAL SELL: ${pct}% of first open position`);
  console.log(`  market=${target.marketProxy} outcome=${target.outcomeIdx} sharesIn=${sellShares}`);
  try {
    const q = await reader.quoteSell({ marketAddress: target.marketProxy, outcomeIdx: Number(target.outcomeIdx), sharesIn: sellShares });
    // minTokensOut = 0 → accept ANY output, so we isolate NON-slippage reverts
    const res = await client.sellShares({ marketAddress: target.marketProxy, outcomeIdx: Number(target.outcomeIdx), sharesIn: sellShares, minTokensOut: 0n });
    logger.info("SELL SUCCEEDED", { txHash: res.transactionHash, quotedTokensOut: q.tokensOut.toString() });
  } catch (e: any) {
    // Print EVERYTHING — this is the diagnostic payload.
    console.log("\n=== RAW SELL ERROR (paste this back) ===");
    console.log("message:", e?.message);
    console.log("shortMessage:", e?.shortMessage);
    console.log("details:", e?.details);
    console.log("data:", e?.data ?? e?.cause?.data);
    console.log("cause:", e?.cause?.message ?? e?.cause);
    if (e?.metaMessages) console.log("meta:", e.metaMessages.join("\n"));
    console.log("=======================================");
  }
}
main().catch((e) => { logger.error("sellDebug failed", { message: e instanceof Error ? e.message : String(e) }); process.exitCode = 1; });
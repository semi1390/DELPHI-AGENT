/**
 * surveyMarkets.ts — full read-only survey of the open board.
 *
 * Lists every open market with category, outcome count, prices, skew, and which
 * estimator would fire (quant / baserate / meanrev / none). Groups by category so
 * you can see where edges could realistically live. READ-ONLY.
 *
 * Run:  npm run survey
 */
import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey } from "../src/config.js";
import { estimateProbability } from "../src/estimators/index.js";
import { logger, section } from "../src/logger.js";

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertApiKey(config);
  const { markets } = await reader.listMarkets({ status: "open", limit: config.marketScanLimit, pricesAndImpliedProbabilities: true });
  const open = markets ?? [];
  section(`Open market survey — ${open.length} markets`);

  const byCat = new Map<string, number>();
  const byEstimator = new Map<string, number>();

  for (const m of open) {
    const outcomes = m.metadata?.outcomes ?? [];
    const probs = m.spotImpliedProbabilities ?? [];
    const cat = m.category ?? "?";
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);

    // Which estimator fires on outcome 0?
    let src = "none";
    try { const e = await estimateProbability(m, 0); if (e && e.source !== "baseline") src = e.source; } catch {}
    byEstimator.set(src, (byEstimator.get(src) ?? 0) + 1);

    const skew = probs.length === 2 ? Math.abs((probs[0] ?? 0.5) - 0.5).toFixed(2) : "-";
    const priceStr = outcomes.map((o, i) => `${o}=${(probs[i] ?? 0).toFixed(2)}`).join(" ");
    console.log(`\n[${cat}] ${m.metadata?.question ?? "?"}`);
    console.log(`   outcomes=${outcomes.length} skew=${skew} fires=${src}  | ${priceStr}`);
  }

  section("Summary by category");
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(16)} ${n}`);
  section("Summary by estimator that fires");
  for (const [s, n] of [...byEstimator.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(16)} ${n}`);
  logger.info("survey complete", { openMarkets: open.length });
}
main().catch((e) => { logger.error("survey failed", { message: e instanceof Error ? e.message : String(e) }); process.exitCode = 1; });
/**
 * quantProbe.ts — diagnostic for the quant estimator (READ-ONLY).
 *
 * For every OPEN market it prints the FULL question (untruncated), the settlement
 * fields, and what the parser made of it — either the extracted asset/direction/
 * threshold/time, or the reason it abstained. For markets that parse, it also
 * fetches live spot/vol and prints the modeled probability.
 *
 * This is how you verify parsing + data against real markets on your machine
 * (the signal table truncates questions and hides the reasons). If a crypto
 * market you expected to price shows "not applicable", the reason tells you what
 * to adjust in parseMarket.ts.
 *
 * Run:  npm run quant
 */

import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, loadConfig } from "../src/config.js";
import { parseThresholdMarket, outcomePolarity } from "../src/quant/parseMarket.js";
import { probThreshold } from "../src/quant/gbm.js";
import { selectPriceSource } from "../src/quant/priceSource.js";
import { logger, section } from "../src/logger.js";

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertApiKey(config);
  const cfg = loadConfig();
  const priceSource = selectPriceSource(cfg);
  logger.info("Price source", { source: priceSource.name, apiBase: priceSource.apiBase });

  const { markets } = await reader.listMarkets({
    status: "open",
    limit: config.marketScanLimit,
    pricesAndImpliedProbabilities: true,
  });
  const open = markets ?? [];
  section(`Quant probe — ${open.length} open markets`);

  let applicable = 0;
  for (const [i, m] of open.entries()) {
    const q = m.metadata?.question ?? "(no question)";
    console.log(`\n[${i + 1}] ${q}`);
    console.log(`     category=${m.category}  settlesAt=${m.settlesAt ?? "-"}  resolvesAt=${m.resolvesAt ?? "-"}`);

    const parsed = parseThresholdMarket(m);
    if (!parsed.ok) {
      console.log(`     → not applicable (${parsed.reason}) → baseline/zero-edge`);
      continue;
    }
    applicable++;
    const p = parsed.value;
    const tYears = (p.settlementMs - Date.now()) / YEAR_MS;
    console.log(
      `     → parsed: asset=${p.asset} ${p.direction === "gt" ? ">" : "<"}${p.threshold} ` +
        `T=${tYears.toFixed(5)}y (via ${p.settlementSource})`,
    );

    if (tYears <= 0) {
      console.log("     → settlement not in the future → abstain");
      continue;
    }

    const stats = await priceSource.fetch(p.asset, p.symbol, {
      apiBase: priceSource.apiBase,
      volDays: cfg.quantVolDays,
      retry: { retries: cfg.retries, baseDelayMs: cfg.retryBaseMs, maxDelayMs: cfg.retryMaxMs },
    });
    if (!stats) {
      console.log("     → price/vol unavailable → abstain (baseline). Check PRICE_SOURCE / network.");
      continue;
    }

    const pTrue = probThreshold({
      spot: stats.spot,
      strike: p.threshold,
      sigmaAnnual: stats.sigmaAnnual,
      tYears,
      drift: cfg.quantDrift,
      direction: p.direction,
    });
    console.log(
      `     → spot=${stats.spot} σ=${(stats.sigmaAnnual * 100).toFixed(1)}% ` +
        `(${stats.samples} samples)  P(true)=${pTrue === null ? "n/a" : pTrue.toFixed(4)}`,
    );
    const outcomes = m.metadata?.outcomes ?? [];
    outcomes.forEach((name, idx) => {
      const pol = outcomePolarity(name);
      const prob = pTrue === null || !pol ? null : pol === "aff" ? pTrue : 1 - pTrue;
      const implied = m.spotImpliedProbabilities?.[idx];
      const edge = prob !== null && implied !== undefined ? prob - implied : null;
      console.log(
        `        outcome[${idx}] ${name.padEnd(18)} quant=${prob === null ? "n/a" : prob.toFixed(4)}` +
          `  implied=${implied?.toFixed(4) ?? "n/a"}  edge=${edge === null ? "n/a" : (edge >= 0 ? "+" : "") + edge.toFixed(4)}`,
      );
    });
  }

  logger.info("Quant probe complete", {
    openMarkets: open.length,
    applicable,
    notApplicable: open.length - applicable,
    priceSource: priceSource.name,
    apiBase: priceSource.apiBase,
    volDays: cfg.quantVolDays,
    drift: cfg.quantDrift,
  });
}

main().catch((err) => {
  logger.error("quantProbe failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
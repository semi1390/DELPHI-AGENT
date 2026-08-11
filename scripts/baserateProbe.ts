/**
 * baserateProbe.ts — diagnostic + live verification for the base-rate estimator.
 *
 * First it FETCHES each source's rate and prints the trailing daily counts, the
 * mean/day, the over-dispersion, and the NB dispersion param — so you can eyeball
 * whether the fetched data is sane (this is the trumpstruth.org verification step
 * I could not do from the build environment). Then, for each open count market, it
 * prints the parsed band/window, the modeled P(Yes), and the edge — or the reason
 * it abstained.
 *
 * Run:  npm run baserate
 */

import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, loadConfig } from "../src/config.js";
import { loadRates } from "../src/baserate/rates.js";
import { parseCountMarket } from "../src/baserate/parseCount.js";
import { negBinomRangeProb, dispersionFromMoments } from "../src/baserate/nb.js";
import { getRateFetcher, type RateModel } from "../src/baserate/sources/index.js";
import { outcomePolarity } from "../src/quant/parseMarket.js";
import { logger, section } from "../src/logger.js";

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertApiKey(config);
  const cfg = loadConfig();
  const entities = loadRates();

  // ── Live rate verification ──────────────────────────────────────────────────
  section("Fetched rates (verify these look sane)");
  const rates = new Map<string, RateModel | null>();
  for (const e of entities) {
    if (e.ratePerDay !== undefined) {
      console.log(`  ${e.key}: manual override ${e.ratePerDay}/day (no dispersion)`);
      continue;
    }
    const fetcher = getRateFetcher(e.source);
    if (!fetcher) {
      console.log(`  ${e.key}: no source registered → ABSTAINS`);
      continue;
    }
    const model = await fetcher({
      lookbackDays: cfg.baseRateLookbackDays,
      cacheTtlMs: cfg.baseRateCacheHours * 3_600_000,
      trumpsTruthBaseUrl: cfg.trumpsTruthBaseUrl,
      dropZeroDays: cfg.baseRateDropZeroDays,
      countMode: cfg.baseRateCountMode,
      repostPattern: new RegExp(cfg.baseRateRepostPattern, "i"),
      retry: { retries: cfg.retries, baseDelayMs: cfg.retryBaseMs, maxDelayMs: cfg.retryMaxMs },
    });
    rates.set(e.key, model);
    if (!model) {
      console.log(`  ${e.key}: fetch failed/empty → ABSTAINS (safe). Check the feed manually.`);
      continue;
    }
    const od = model.variancePerDay > model.meanPerDay ? model.variancePerDay / model.meanPerDay : 1;
    console.log(`  ${e.key}: source=${model.source}  countMode=${model.countMode}`);
    console.log(`     mean=${model.meanPerDay.toFixed(2)}/day  variance=${model.variancePerDay.toFixed(1)}  overdispersion=${od.toFixed(2)}x  statDays=${model.lookbackDays}`);
    console.log(`     zero-handling: dropped ${model.droppedZeroDays} zero day(s)  |  mean WITH zeros=${model.meanWithZeros.toFixed(2)}  mean WITHOUT zeros=${Number.isNaN(model.meanWithoutZeros) ? "n/a" : model.meanWithoutZeros.toFixed(2)}`);
    console.log(`     reposts: detected ${model.repostsDetected}/${model.totalItems} items as reposts (verify below — if 0, "original" mode = "all")`);
    console.log(`     daily counts: [${model.dailyCounts.join(", ")}]`);
    console.log(`     sample titles (check how reposts read):`);
    for (const s of model.sampleTitles) console.log(`        ${s.isRepost ? "[REPOST]" : "[post]  "} ${s.title}`);
  }

  const { markets } = await reader.listMarkets({
    status: "open",
    limit: config.marketScanLimit,
    pricesAndImpliedProbabilities: true,
  });
  const open = markets ?? [];
  section(`Base-rate probe — ${open.length} open markets`);

  let applicable = 0;
  for (const [i, m] of open.entries()) {
    const q = m.metadata?.question ?? "(no question)";
    const parsed = parseCountMarket(m, entities);
    if (!parsed.ok) {
      console.log(`\n[${i + 1}] ${q}`);
      console.log(`     → not applicable (${parsed.reason})`);
      continue;
    }
    applicable++;
    const p = parsed.value;
    const model = rates.get(p.entityKey);
    console.log(`\n[${i + 1}] ${q}`);
    if (!model) {
      console.log(`     → entity=${p.entityKey} band=${band(p.low, p.high)} window=${p.windowDays}d  → no rate → ABSTAIN`);
      continue;
    }
    const windowMean = model.meanPerDay * p.windowDays;
    const windowVar = model.variancePerDay * p.windowDays;
    const r = dispersionFromMoments(windowMean, windowVar);
    const pYes = negBinomRangeProb(p.low, p.high, windowMean, r);
    console.log(
      `     → entity=${p.entityKey} band=${band(p.low, p.high)} window=${p.windowDays}d ` +
        `μ=${windowMean.toFixed(1)} r=${Number.isFinite(r) ? r.toFixed(1) : "inf(Poisson)"}  P(Yes)=${pYes.toFixed(4)}`,
    );
    const outcomes = m.metadata?.outcomes ?? [];
    outcomes.forEach((name, idx) => {
      const pol = outcomePolarity(name);
      const prob = !pol ? null : pol === "aff" ? pYes : 1 - pYes;
      const implied = m.spotImpliedProbabilities?.[idx];
      const edge = prob !== null && implied !== undefined ? prob - implied : null;
      console.log(
        `        outcome[${idx}] ${name.padEnd(18)} baserate=${prob === null ? "n/a" : prob.toFixed(4)}` +
          `  implied=${implied?.toFixed(4) ?? "n/a"}  edge=${edge === null ? "n/a" : (edge >= 0 ? "+" : "") + edge.toFixed(4)}`,
      );
    });
  }

  logger.info("Base-rate probe complete", {
    openMarkets: open.length,
    applicable,
    notApplicable: open.length - applicable,
    entitiesConfigured: entities.length,
  });
  if (entities.length === 0) {
    logger.warn("No entities configured — copy base-rates.example.json to base-rates.json.");
  }
}

function band(low: number, high: number): string {
  return high === Infinity ? `>=${low}` : `${low}..${high}`;
}

main().catch((err) => {
  logger.error("baserateProbe failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
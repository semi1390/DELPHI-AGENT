/**
 * datalookupProbe.ts — verify the data-lookup fetches + estimates (npm run datalookup).
 * Fetches SILSO + NSIDC, prints the latest values, then for each open market that
 * parses as data-lookup shows the threshold, published/projected value, and P(Yes).
 */
import { createDelphiClient } from "../src/delphi.js";
import { assertApiKey, loadConfig } from "../src/config.js";
import { parseLookupMarket } from "../src/datalookup/parse.js";
import { fetchSunspots } from "../src/datalookup/sources/silso.js";
import { fetchSeaIce } from "../src/datalookup/sources/nsidc.js";
import { logger, section } from "../src/logger.js";

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertApiKey(config);
  const cfg = loadConfig();
  const retry = { retries: cfg.retries, baseDelayMs: cfg.retryBaseMs, maxDelayMs: cfg.retryMaxMs };

  section("Data source verification");
  const ss = await fetchSunspots({ url: cfg.silsoUrl, retry });
  if (ss) { const l = ss.points[ss.points.length-1]; console.log(`  SILSO sunspots: ${ss.points.length} days, latest ${l.date} = ${l.value}`); }
  else console.log("  SILSO: FETCH FAILED → sunspot markets will abstain (check SILSO_URL)");
  const si = await fetchSeaIce({ url: cfg.nsidcUrl, retry });
  if (si) { const l = si.points[si.points.length-1]; console.log(`  NSIDC sea ice: ${si.points.length} days, latest ${l.date} = ${l.value} M km²`); }
  else console.log("  NSIDC: FETCH FAILED → sea-ice markets will abstain (check NSIDC_URL)");

  const { markets } = await reader.listMarkets({ status: "open", limit: config.marketScanLimit, pricesAndImpliedProbabilities: true });
  const open = markets ?? [];
  section(`Data-lookup markets in the open book (${open.length} total)`);
  let n = 0;
  for (const m of open) {
    const p = parseLookupMarket(m);
    if (!p) continue;
    n++;
    console.log(`\n[${p.type}] ${m.metadata?.question}`);
    console.log(`   comparator=${p.comparator} threshold=${p.threshold} targetDate=${p.targetDate}`);
  }
  if (n === 0) console.log("  (none parsed as data-lookup right now)");
  logger.info("datalookup probe complete", { openMarkets: open.length, dataLookupMarkets: n });
}
main().catch((e) => { logger.error("datalookupProbe failed", { message: e instanceof Error ? e.message : String(e) }); process.exitCode = 1; });
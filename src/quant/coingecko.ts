/**
 * CoinGecko price/volatility provider (default source).
 *
 * Same shape and return type as the Binance provider (getSpotAndVol), so the
 * estimator doesn't care which is used. Chosen as the default because CoinGecko
 * is reachable where Binance often isn't (some ISPs/regions block Binance DNS
 * entirely) and it works from Railway too. Free, no API key.
 *
 * Endpoints (public, no key):
 *   spot   : /api/v3/simple/price?ids=<id>&vs_currencies=usd
 *   history: /api/v3/coins/<id>/market_chart?vs_currency=usd&days=<N>&interval=daily
 *            → { prices: [[tsMs, price], ...] }  (one point per day)
 *
 * Realized vol: daily log returns from the history closes → sample stdev → ×√365.
 *
 * Safety: every fetch goes through the retry layer; any failure or malformed
 * payload returns null so the estimator abstains (baseline). Never fabricates data.
 * Per-process TTL cache keeps us well under CoinGecko's free rate limit.
 *
 * Note: CoinGecko's free tier is rate-limited (~10-30 req/min). The 60s cache and
 * the fact that we fetch at most one spot + one history per asset per run keep us
 * comfortably inside that. If you ever get HTTP 429, the retry/backoff absorbs it.
 */

import { withRetry } from "../retry.js";
import { annualizeDailyVol, sampleStdev } from "./gbm.js";
import { logger } from "../logger.js";
import type { AssetStats, PriceDataOptions } from "./priceData.js";

/** Maps our canonical asset keys to CoinGecko coin ids. */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  DOGE: "dogecoin",
};

const cache = new Map<string, { at: number; val: AssetStats }>();

/**
 * getSpotAndVol-compatible fetcher. `symbol` here is our canonical asset KEY
 * (e.g. "ETH"), not a Binance pair — the estimator passes the parsed asset key
 * when the CoinGecko source is selected.
 */
export async function getSpotAndVolCoinGecko(
  assetKey: string,
  opts: PriceDataOptions,
): Promise<AssetStats | null> {
  const id = COINGECKO_IDS[assetKey];
  if (!id) {
    logger.warn("quant: no CoinGecko id for asset → abstain", { assetKey });
    return null;
  }

  const ttl = opts.cacheTtlMs ?? 60_000;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < ttl) return hit.val;

  try {
    const spot = await fetchSpot(id, opts);
    const { sigmaAnnual, samples } = await fetchRealizedVol(id, opts);
    if (!(spot > 0) || !(sigmaAnnual > 0)) {
      logger.warn("quant: got non-positive spot/vol, abstaining", { assetKey, spot, sigmaAnnual });
      return null;
    }
    const val: AssetStats = { spot, sigmaAnnual, samples, source: `coingecko:${id}` };
    cache.set(id, { at: Date.now(), val });
    return val;
  } catch (err) {
    logger.warn("quant: CoinGecko fetch failed after retries → baseline", {
      assetKey,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function fetchSpot(id: string, opts: PriceDataOptions): Promise<number> {
  const url = `${opts.apiBase}/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const json = (await withRetry(() => getJson(url), { ...opts.retry, label: `cg-spot:${id}` })) as
    | Record<string, { usd?: number }>
    | undefined;
  const price = Number(json?.[id]?.usd);
  if (!Number.isFinite(price)) throw new Error(`bad CoinGecko spot payload for ${id}`);
  return price;
}

async function fetchRealizedVol(
  id: string,
  opts: PriceDataOptions,
): Promise<{ sigmaAnnual: number; samples: number }> {
  // days = volDays+1 closes → volDays returns. `interval=daily` yields one point/day.
  const days = Math.max(2, opts.volDays + 1);
  const url = `${opts.apiBase}/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const json = (await withRetry(() => getJson(url), { ...opts.retry, label: `cg-hist:${id}` })) as
    | { prices?: [number, number][] }
    | undefined;

  const prices = json?.prices;
  if (!Array.isArray(prices) || prices.length < 2) {
    throw new Error(`insufficient CoinGecko history for ${id}`);
  }
  const closes = prices
    .map((p) => (Array.isArray(p) ? Number(p[1]) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 2) throw new Error(`no valid CoinGecko closes for ${id}`);

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));

  const sigmaDaily = sampleStdev(logReturns);
  if (!Number.isFinite(sigmaDaily)) throw new Error(`vol calc failed for ${id}`);

  return { sigmaAnnual: annualizeDailyVol(sigmaDaily), samples: logReturns.length };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Test hook: clear the module cache. */
export function _clearCoinGeckoCache(): void {
  cache.clear();
}
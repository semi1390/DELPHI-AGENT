/**
 * Live price/volatility data for the quant estimator.
 *
 * Source: Binance public market-data endpoint (default `data-api.binance.vision`,
 * no API key). We use Binance because the markets themselves settle on Binance
 * prices, and this particular host is not geoblocked (important on Railway's US
 * IPs, where `api.binance.com` returns 451). Override with BINANCE_API_BASE, or
 * point it at CoinGecko-style infra by swapping this module.
 *
 * Computes realized volatility from daily closes (log returns → sample stdev →
 * annualized ×√365) and reads a fresh spot from the ticker endpoint.
 *
 * Safety: both fetches go through the shared retry layer. If data is unavailable
 * after retries (network, geoblock, malformed response), we return null — the
 * estimator then abstains and the pipeline stays flat. We NEVER fabricate a price.
 *
 * A tiny per-process TTL cache avoids re-fetching the same asset for every outcome
 * in a run (Yes + No + other ETH markets all reuse one fetch).
 */

import { withRetry, type RetryOptions } from "../retry.js";
import { annualizeDailyVol, sampleStdev } from "./gbm.js";
import { logger } from "../logger.js";

export interface AssetStats {
  spot: number;
  sigmaAnnual: number;
  samples: number; // number of daily returns used
  source: string;
}

export interface PriceDataOptions {
  apiBase: string;
  volDays: number;
  retry: Partial<RetryOptions>;
  cacheTtlMs?: number;
}

const cache = new Map<string, { at: number; val: AssetStats }>();

export async function getSpotAndVol(
  symbol: string,
  opts: PriceDataOptions,
): Promise<AssetStats | null> {
  const ttl = opts.cacheTtlMs ?? 60_000;
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < ttl) return hit.val;

  try {
    const spot = await fetchSpot(symbol, opts);
    const { sigmaAnnual, samples } = await fetchRealizedVol(symbol, opts);
    if (!(spot > 0) || !(sigmaAnnual > 0)) {
      logger.warn("quant: got non-positive spot/vol, abstaining", { symbol, spot, sigmaAnnual });
      return null;
    }
    const val: AssetStats = { spot, sigmaAnnual, samples, source: opts.apiBase };
    cache.set(symbol, { at: Date.now(), val });
    return val;
  } catch (err) {
    logger.warn("quant: price/vol fetch failed after retries → baseline", {
      symbol,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function fetchSpot(symbol: string, opts: PriceDataOptions): Promise<number> {
  const url = `${opts.apiBase}/api/v3/ticker/price?symbol=${symbol}`;
  const json = await withRetry(() => getJson(url), { ...opts.retry, label: `spot:${symbol}` });
  const price = Number((json as { price?: string }).price);
  if (!Number.isFinite(price)) throw new Error(`bad spot payload for ${symbol}`);
  return price;
}

async function fetchRealizedVol(
  symbol: string,
  opts: PriceDataOptions,
): Promise<{ sigmaAnnual: number; samples: number }> {
  // Need volDays returns → volDays+1 closes.
  const limit = Math.max(2, opts.volDays + 1);
  const url = `${opts.apiBase}/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const rows = (await withRetry(() => getJson(url), {
    ...opts.retry,
    label: `klines:${symbol}`,
  })) as unknown[];

  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`insufficient klines for ${symbol}`);
  }
  // Kline row: [openTime, open, high, low, close, volume, ...]. Close = index 4.
  const closes = rows
    .map((r) => (Array.isArray(r) ? Number(r[4]) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 2) throw new Error(`no valid closes for ${symbol}`);

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));

  const sigmaDaily = sampleStdev(logReturns);
  if (!Number.isFinite(sigmaDaily)) throw new Error(`vol calc failed for ${symbol}`);

  return { sigmaAnnual: annualizeDailyVol(sigmaDaily), samples: logReturns.length };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Test hook: clear the module cache. */
export function _clearPriceCache(): void {
  cache.clear();
}
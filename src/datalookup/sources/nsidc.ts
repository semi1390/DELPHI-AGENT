/**
 * NSIDC daily Arctic sea-ice extent source (N_seaice_extent_daily_v3.0.csv).
 * Columns: Year, Month, Day, Extent(10^6 km²), Missing, Source. 2 header lines.
 * Returns recent daily {date, value}. Abstain-safe: null on any failure.
 */
import { withRetry, type RetryOptions } from "../../retry.js";
import { logger } from "../../logger.js";
import type { DailyPoint, SeriesResult } from "./silso.js";

const cache = new Map<string, { at: number; val: SeriesResult }>();

export async function fetchSeaIce(opts: { url: string; retry: Partial<RetryOptions>; cacheTtlMs?: number }): Promise<SeriesResult | null> {
  const ttl = opts.cacheTtlMs ?? 6 * 60 * 60 * 1000;
  const hit = cache.get(opts.url);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  try {
    const text = await withRetry(() => getText(opts.url), { ...opts.retry, label: "nsidc" });
    const points: DailyPoint[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || /year/i.test(t) || /^-+/.test(t)) continue; // skip headers
      const cols = t.split(",").map((c) => c.trim());
      if (cols.length < 4) continue;
      const y = +cols[0], mo = +cols[1], d = +cols[2], ext = parseFloat(cols[3]);
      if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d) || !Number.isFinite(ext)) continue;
      if (ext <= 0) continue;
      points.push({ date: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`, value: ext });
    }
    if (points.length === 0) { logger.warn("nsidc: no valid rows parsed → abstain"); return null; }
    const val: SeriesResult = { points, source: "NSIDC/G02135", asOf: new Date().toISOString() };
    cache.set(opts.url, { at: Date.now(), val });
    return val;
  } catch (err) {
    logger.warn("nsidc: fetch failed → abstain", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "text/csv, text/plain, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
export function _clearNsidcCache(): void { cache.clear(); }
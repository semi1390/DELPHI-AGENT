/**
 * SILSO daily sunspot source (EISN_current.csv).
 * Columns: Year, Month, Day, DecimalDate, EISN, StdDev, NbCalc, NbAvail.
 * Returns recent daily {date, value} points. Abstain-safe: null on any failure.
 */
import { withRetry, type RetryOptions } from "../../retry.js";
import { logger } from "../../logger.js";

export interface DailyPoint { date: string; value: number; }
export interface SeriesResult { points: DailyPoint[]; source: string; asOf: string; }

const cache = new Map<string, { at: number; val: SeriesResult }>();

export async function fetchSunspots(opts: { url: string; retry: Partial<RetryOptions>; cacheTtlMs?: number }): Promise<SeriesResult | null> {
  const ttl = opts.cacheTtlMs ?? 6 * 60 * 60 * 1000;
  const hit = cache.get(opts.url);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  try {
    const text = await withRetry(() => getText(opts.url), { ...opts.retry, label: "silso" });
    const points: DailyPoint[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const cols = t.split(/[;,]/).map((c) => c.trim());
      if (cols.length < 5) continue;
      const y = +cols[0], mo = +cols[1], d = +cols[2], val = parseFloat(cols[4]);
      if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d) || !Number.isFinite(val)) continue;
      if (val < 0) continue; // -1 = no value yet
      points.push({ date: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`, value: val });
    }
    if (points.length === 0) { logger.warn("silso: no valid rows parsed → abstain"); return null; }
    const val: SeriesResult = { points, source: "SILSO/EISN", asOf: new Date().toISOString() };
    cache.set(opts.url, { at: Date.now(), val });
    return val;
  } catch (err) {
    logger.warn("silso: fetch failed → abstain", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "text/csv, text/plain, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
export function _clearSilsoCache(): void { cache.clear(); }
/**
 * Data-lookup estimator (src=datalookup).
 *
 * Prices markets resolvable by a published number (sunspots/SILSO, sea ice/NSIDC).
 *   1. parse type, comparator, threshold, target date
 *   2. fetch recent daily values from the authoritative source
 *   3. if the target date is ALREADY published → near-deterministic (0.95/0.05)
 *      else → project from recent level + trend, with variance growing over the
 *      days-to-settle horizon, and integrate a normal to get P(threshold)
 *   4. map to the outcome; abstain on any fetch/parse failure (never guess)
 *
 * Logs the fetched value, projection, and probability for audit. Read-only.
 */
import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";
import { outcomePolarity } from "../quant/parseMarket.js";
import { parseLookupMarket, type ParsedLookup } from "../datalookup/parse.js";
import { fetchSunspots, type SeriesResult, type DailyPoint } from "../datalookup/sources/silso.js";
import { fetchSeaIce } from "../datalookup/sources/nsidc.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

export class DataLookupEstimator implements ProbabilityEstimator {
  readonly name = "datalookup";
  private readonly cfg = loadConfig();

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const parsed = parseLookupMarket(market);
    if (!parsed) return null;

    const outcomeName = market.metadata?.outcomes?.[outcomeIdx] ?? "";
    const polarity = outcomePolarity(outcomeName);
    if (!polarity) return null; // need Yes/No style

    const series = await this.fetchSeries(parsed.type);
    if (!series || series.points.length === 0) {
      logger.debug("datalookup: no series → abstain", { type: parsed.type });
      return null;
    }

    const est = estimateThreshold(parsed, series);
    if (!est) return null;

    const probability = polarity === "aff" ? est.pYes : 1 - est.pYes;
    logger.info("datalookup estimate", {
      market: market.id,
      type: parsed.type,
      source: series.source,
      comparator: parsed.comparator,
      threshold: parsed.threshold,
      targetDate: parsed.targetDate,
      latest: est.latest,
      projected: round(est.projected, 3),
      basis: est.basis,
      daysAhead: est.daysAhead,
      pYes: round(est.pYes, 4),
      probability: round(probability, 4),
    });

    return {
      probability,
      confidence: est.confidence,
      rationale: `${parsed.type} ${parsed.comparator} ${parsed.threshold} on ${parsed.targetDate}: ${est.basis} (proj ${round(est.projected, 2)}) → P(Yes)=${round(est.pYes, 3)}`,
    };
  }

  private async fetchSeries(type: ParsedLookup["type"]): Promise<SeriesResult | null> {
    const retry = { retries: this.cfg.retries, baseDelayMs: this.cfg.retryBaseMs, maxDelayMs: this.cfg.retryMaxMs };
    const cacheTtlMs = this.cfg.dataLookupCacheHours * 3_600_000;
    if (type === "sunspot") return fetchSunspots({ url: this.cfg.silsoUrl, retry, cacheTtlMs });
    if (type === "seaice") return fetchSeaIce({ url: this.cfg.nsidcUrl, retry, cacheTtlMs });
    return null;
  }
}

interface ThresholdEstimate { pYes: number; latest: number; projected: number; daysAhead: number; basis: string; confidence: number; }

function estimateThreshold(p: ParsedLookup, series: SeriesResult): ThresholdEstimate | null {
  const pts = [...series.points].sort((a, b) => a.date.localeCompare(b.date));
  const latest = pts[pts.length - 1];
  if (!latest) return null;

  // Already published for the target date? → near-deterministic.
  const exact = pts.find((x) => x.date === p.targetDate);
  if (exact) {
    const met = meets(exact.value, p.comparator, p.threshold);
    return { pYes: met ? 0.95 : 0.05, latest: exact.value, projected: exact.value, daysAhead: 0, basis: "published value", confidence: 0.9 };
  }

  // Otherwise project from recent values.
  const recent = pts.slice(-14);
  const values = recent.map((x) => x.value);
  const mean = avg(values);
  const daysAhead = Math.max(0, daysBetween(latest.date, p.targetDate));

  // Trend: least-squares slope per day over the recent window.
  const slope = linregSlope(recent);
  const projected = latest.value + slope * daysAhead;

  // Volatility: std of day-to-day changes; horizon variance ∝ daysAhead (+1).
  const dailyStd = stdOfDiffs(values) || Math.max(1, mean * 0.1);
  const sd = dailyStd * Math.sqrt(daysAhead + 1);

  const pAbove = 1 - normCdf((p.threshold - projected) / sd); // P(value > threshold)
  const pYes = p.comparator === "ge" || p.comparator === "gt" ? pAbove : 1 - pAbove;

  // Confidence: high when target is today/at latest, tapering with horizon.
  const confidence = daysAhead <= 1 ? 0.75 : daysAhead <= 5 ? 0.55 : 0.4;
  return { pYes: clamp01(pYes), latest: latest.value, projected, daysAhead, basis: `projected from ${recent.length}d (slope ${round(slope,3)}/d, sd ${round(sd,2)})`, confidence };
}

function meets(v: number, c: ParsedLookup["comparator"], t: number): boolean {
  return c === "ge" ? v >= t : c === "gt" ? v > t : c === "lt" ? v < t : v <= t;
}
function avg(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdOfDiffs(xs: number[]): number {
  if (xs.length < 3) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i - 1]);
  const m = avg(diffs);
  return Math.sqrt(diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (diffs.length - 1));
}
function linregSlope(pts: DailyPoint[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  const xs = pts.map((_, i) => i);
  const ys = pts.map((p) => p.value);
  const mx = avg(xs), my = avg(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}
function normCdf(z: number): number {
  // Abramowitz-Stegun erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}
function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }
function round(n: number, dp = 2): number { const f = 10 ** dp; return Math.round(n * f) / f; }
/**
 * Count / frequency-over-window market parser.
 *
 * Detects "how many times [entity] does [X] over [window]" markets and extracts:
 *   - the count constraint: a band [low, high] or an open threshold
 *   - the time window length in days
 *   - the entity (matched against your base-rates.json entries)
 *
 * Built against the ACTUAL phrasing in this competition, which is a RANGE band,
 * not "more than N":
 *   "Will Donald Trump post 180–199 times on Truth Social between Aug 4 ... and Aug 11 ...?"
 *   "Will Elon Musk post 300-319 times on X ... from 12PM ET Aug 7 to 12PM ET Aug 14, 2026?"
 *   "Will Elon Musk post between 120 and 139 times on X from July 31 ... to August 7 ...?"
 * We also support open forms ("more than N", "at least N", "fewer than N").
 *
 * Abstain-by-default: no count phrasing, no parseable window, or no base-rate
 * entity → { ok:false, reason }. We never guess.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { EntityConfig } from "./rates.js";

export interface ParsedCount {
  entityKey: string;
  low: number;
  high: number; // may be Infinity
  windowDays: number;
}

export type CountParseResult =
  | { ok: true; value: ParsedCount }
  | { ok: false; reason: string };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const num = (s: string) => Number(s.replace(/,/g, ""));

/** Extract the count band [low, high] (high may be Infinity), or null. */
export function parseCountConstraint(q: string): { low: number; high: number } | null {
  // 1) "between A and B [times|posts|tweets]"
  let m = q.match(/between\s+(\d[\d,]*)\s+and\s+(\d[\d,]*)\s*(?:times|posts|tweets)/i);
  if (m) return ordered(num(m[1]), num(m[2]));

  // 2) "A-B ... times|posts|tweets"  (en/em dash or hyphen; allow a few words before the noun)
  m = q.match(/(\d[\d,]*)\s*[-–—]\s*(\d[\d,]*)\b[^?.\d]{0,25}?\b(?:times|posts|tweets)/i);
  if (m) return ordered(num(m[1]), num(m[2]));

  // 3) open-ended thresholds
  m = q.match(/(?:more than|greater than|over|above)\s+(\d[\d,]*)\s*(?:times|posts|tweets)?/i);
  if (m) return { low: num(m[1]) + 1, high: Infinity };
  m = q.match(/(?:at least|no fewer than|minimum of)\s+(\d[\d,]*)/i);
  if (m) return { low: num(m[1]), high: Infinity };
  m = q.match(/(\d[\d,]*)\s+or\s+more/i);
  if (m) return { low: num(m[1]), high: Infinity };
  m = q.match(/(?:fewer than|less than|under|below)\s+(\d[\d,]*)/i);
  if (m) return { low: 0, high: num(m[1]) - 1 };
  m = q.match(/(?:at most|no more than)\s+(\d[\d,]*)/i);
  if (m) return { low: 0, high: num(m[1]) };
  m = q.match(/(\d[\d,]*)\s+or\s+fewer/i);
  if (m) return { low: 0, high: num(m[1]) };
  m = q.match(/exactly\s+(\d[\d,]*)/i);
  if (m) return { low: num(m[1]), high: num(m[1]) };

  return null;
}

function ordered(a: number, b: number): { low: number; high: number } {
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

/** Window length in days, parsed from the question, or null. */
export function extractWindowDays(q: string): number | null {
  // Same-month dash range first: "July 24-31, 2026"
  const b = q.match(/([A-Za-z]{3,})\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s*(\d{4})/);
  if (b) {
    const mon = MONTHS[b[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      const d1 = Number(b[2]);
      const d2 = Number(b[3]);
      if (d2 > d1) return d2 - d1;
    }
  }

  // Otherwise: collect the first two "<Month> <day>[, year]" points.
  const re = /([A-Za-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/g;
  const pts: { mon: number; day: number; year?: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) && pts.length < 2) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon === undefined) continue;
    pts.push({ mon, day: Number(m[2]), year: m[3] ? Number(m[3]) : undefined });
  }
  if (pts.length >= 2) {
    const yr = pts.find((p) => p.year !== undefined)?.year ?? new Date().getUTCFullYear();
    const start = Date.UTC(pts[0].year ?? yr, pts[0].mon, pts[0].day);
    const end = Date.UTC(pts[1].year ?? yr, pts[1].mon, pts[1].day);
    const days = (end - start) / 86_400_000;
    if (days > 0 && days <= 366) return days;
  }
  return null;
}

/** Match the question to a base-rate entity, or null. */
export function detectEntity(q: string, entities: EntityConfig[]): EntityConfig | null {
  const lower = q.toLowerCase();
  for (const e of entities) {
    const allOk = (e.match.all ?? []).every((s) => lower.includes(s.toLowerCase()));
    const anyOk = !e.match.any || e.match.any.length === 0 || e.match.any.some((s) => lower.includes(s.toLowerCase()));
    if (allOk && anyOk) return e;
  }
  return null;
}

/**
 * Parse a market into a count spec, or explain why it can't.
 * Order: count phrasing → time window → base-rate entity.
 */
export function parseCountMarket(market: Market, entities: EntityConfig[]): CountParseResult {
  const q = market.metadata?.question;
  if (!q) return { ok: false, reason: "no question text" };

  const count = parseCountConstraint(q);
  if (!count) return { ok: false, reason: "not a count/threshold-over-window question" };
  if (!(count.high >= count.low)) return { ok: false, reason: "degenerate count band" };

  const windowDays = extractWindowDays(q);
  if (windowDays === null) return { ok: false, reason: "could not parse time window" };

  const entity = detectEntity(q, entities);
  if (!entity) return { ok: false, reason: "no base rate for entity" };

  return {
    ok: true,
    value: {
      entityKey: entity.key,
      low: count.low,
      high: count.high,
      windowDays,
    },
  };
}
/**
 * Parse a data-lookup market: a question resolvable by looking up a published
 * number. Detects the data TYPE (sunspot | seaice), the COMPARATOR and THRESHOLD,
 * and the TARGET DATE. Returns null (→ estimator abstains) on anything it can't
 * confidently parse. Read-only, pure.
 */
import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";

export type DataType = "sunspot" | "seaice";
export type Comparator = "ge" | "gt" | "lt" | "le";

export interface ParsedLookup {
  type: DataType;
  comparator: Comparator;
  threshold: number;
  targetDate: string; // YYYY-MM-DD (UTC)
}

export function parseLookupMarket(market: Market): ParsedLookup | null {
  const q = (market.metadata?.question ?? "").toLowerCase();
  if (!q) return null;

  const type: DataType | null =
    /sunspot/.test(q) ? "sunspot" : /sea ice|sea-ice|seaice/.test(q) ? "seaice" : null;
  if (!type) return null;

  const targetDate = extractDate(q);
  if (!targetDate) return null;

  const comparator = extractComparator(q);
  if (!comparator) return null;

  const threshold = extractThreshold(q, type);
  if (threshold === null) return null;

  return { type, comparator, threshold, targetDate };
}

function extractDate(q: string): string | null {
  // ISO form: 2026-08-12
  const iso = q.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "Aug 12, 2026" style
  const months: Record<string, string> = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
  const m = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) return `${m[3]}-${months[m[1]]}-${m[2].padStart(2, "0")}`;
  return null;
}

function extractComparator(q: string): Comparator | null {
  if (/\b(or higher|or above|or more|at least|>=|≥|40 or higher)\b/.test(q) || /higher|above|exceed|greater/.test(q)) return "ge";
  if (/\b(below|under|less than|lower than|<)\b/.test(q)) return "lt";
  if (/\b(or lower|or below|at most|<=|≤)\b/.test(q)) return "le";
  if (/\bgreater than\b|\bmore than\b/.test(q)) return "gt";
  return null;
}

function extractThreshold(q: string, type: DataType): number | null {
  // Remove date tokens first so we never grab the year (e.g. 2026) as the threshold.
  const cleaned = q
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ");
  if (type === "seaice") {
    const m = cleaned.match(/(\d+(?:\.\d+)?)\s*million/);
    if (m) return parseFloat(m[1]);
    const any = cleaned.match(/(\d+(?:\.\d+)?)/);
    return any ? parseFloat(any[1]) : null;
  }
  // sunspot: prefer the number attached to the comparator phrase, else first number.
  const near = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:or higher|or above|or more)/);
  if (near) return parseFloat(near[1]);
  const be = cleaned.match(/be\s+(\d+(?:\.\d+)?)/);
  if (be) return parseFloat(be[1]);
  const any = cleaned.match(/(\d+(?:\.\d+)?)/);
  return any ? parseFloat(any[1]) : null;
}
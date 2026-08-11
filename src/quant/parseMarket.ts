/**
 * Threshold-market parser.
 *
 * Detects crypto/macro "will [asset] be above/below [price] by [date]" markets and
 * extracts the pieces the quant model needs. Built against the ACTUAL question
 * formats seen in this competition, e.g.:
 *   "Will ETH be >$1,900 at 7:15pm PDT Wed Aug 5, 2026?"
 *   "Will BTC spot be above $64,600 when this market closes?"
 *   "Will Coinbase BTC-USD spot be above $64,650 at 22:29 UTC on August 5, 2026?"
 *   "Will ETH spot price be above $1,880 USD when this market closes?"
 *   "Will Ethereum (ETH/USDT on Binance) be above $X ...?"
 *
 * Design rule: parse only what we can extract *confidently* AND only for
 * questions that are clearly TERMINAL threshold bets — "will [asset] be
 * above/below $X at settlement / on [date] / by close". The GBM model computes a
 * *terminal* probability (price at the settlement instant), so it is only valid
 * for those. We ABSTAIN (→ baseline, zero edge) on:
 *   - barrier/touch questions ("at any point", "ever", "touches/reaches/hits")
 *     — terminal prob understates the true touch prob, so pricing them terminally
 *     would fabricate an edge and a losing trade
 *   - date-window questions ("between Aug 3 and Aug 9")
 *   - price-range questions ("$1,400–$1,500", "inclusive")
 *   - TWAP/average/VWAP questions
 *   - relative-to-another-price questions ("at or above the 17:00 price")
 *   - anything without a clear terminal marker, or otherwise unparseable
 * Every abstention returns { ok:false, reason } so the decision is auditable.
 * We never guess.
 *
 * Built against the ACTUAL question formats seen in this competition, e.g.
 * terminal (priced): "Will ETH be >$1,900 at 7:15pm PDT Wed Aug 5, 2026?",
 * "Will BTC spot be above $64,600 when this market closes?"; and abstained:
 * "Will Ethereum ... trade at or above $2,200 at any point between Aug 3 and Aug 9?"
 * (barrier), "Will Binance ETH/USDT 1h candle close ... be $1,400-$1,500 inclusive?"
 * (range), "Will the Chainlink ETH/USD TWAP ... be at or above the 20:15 price?" (TWAP).
 *
 * Time-to-settlement comes from the Market's own `settlesAt`/`resolvesAt` fields
 * (reliable, timezone-safe) with a narrow UTC-text fallback — NOT from parsing
 * localized "7:15pm PDT" strings.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Direction } from "./gbm.js";

export interface AssetSpec {
  key: string; // canonical, e.g. "ETH"
  symbol: string; // Binance symbol, e.g. "ETHUSDT"
  aliases: string[]; // lowercase match tokens
}

/** Assets we can price. Extend freely — an asset only fires if it has a symbol. */
export const ASSETS: AssetSpec[] = [
  { key: "BTC", symbol: "BTCUSDT", aliases: ["btc", "bitcoin", "xbt"] },
  { key: "ETH", symbol: "ETHUSDT", aliases: ["eth", "ethereum", "ether"] },
  { key: "SOL", symbol: "SOLUSDT", aliases: ["sol", "solana"] },
  { key: "BNB", symbol: "BNBUSDT", aliases: ["bnb"] },
  { key: "XRP", symbol: "XRPUSDT", aliases: ["xrp", "ripple"] },
  { key: "DOGE", symbol: "DOGEUSDT", aliases: ["doge", "dogecoin"] },
];

export interface ParsedThreshold {
  asset: string;
  symbol: string;
  direction: Direction; // "gt" = proposition is price ABOVE strike
  threshold: number;
  settlementMs: number;
  settlementSource: string; // "settlesAt" | "resolvesAt" | "text:UTC"
}

export type ParseResult =
  | { ok: true; value: ParsedThreshold }
  | { ok: false; reason: string };

const GT_WORDS = /(>=|>|above|over|greater than|at least|exceeds?|higher than)/i;
const LT_WORDS = /(<=|<|below|under|less than|at most|lower than)/i;

/** Find the asset named in the question (first alias/ticker hit wins). */
function detectAsset(q: string): AssetSpec | null {
  const lower = q.toLowerCase();
  let best: { spec: AssetSpec; idx: number } | null = null;
  for (const spec of ASSETS) {
    for (const alias of [spec.key.toLowerCase(), ...spec.aliases]) {
      const idx = lower.search(new RegExp(`\\b${alias}\\b`));
      if (idx >= 0 && (best === null || idx < best.idx)) best = { spec, idx };
    }
  }
  return best?.spec ?? null;
}

/** Extract comparator + the numeric threshold that immediately follows it. */
function detectThreshold(q: string): { direction: Direction; threshold: number } | null {
  // Comparator followed by an optional $ and a number (handles "$1,900", "64,600", "1880.5").
  const m = q.match(
    /(>=|<=|>|<|above|below|over|under|greater than|less than|at least|at most|higher than|lower than|exceeds?)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  );
  if (!m) return null;
  const word = m[1];
  const num = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  const direction: Direction = GT_WORDS.test(word) ? "gt" : LT_WORDS.test(word) ? "lt" : "gt";
  // Guard: if a comparator word matched neither list (shouldn't happen), bail.
  if (!GT_WORDS.test(word) && !LT_WORDS.test(word)) return null;
  return { direction, threshold: num };
}

/** Settlement time from the market fields, with a narrow UTC-text fallback. */
function detectSettlement(market: Market): { ms: number; source: string } | null {
  for (const [source, raw] of [
    ["settlesAt", market.settlesAt],
    ["resolvesAt", market.resolvesAt],
  ] as const) {
    if (raw) {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) return { ms: t, source };
    }
  }
  // Fallback: explicit "... UTC on <Month> <D>, <YYYY>" or "<Month> <D>, <YYYY>".
  const q = market.metadata?.question ?? "";
  const utc = q.match(
    /(\d{1,2}):(\d{2})\s*UTC\s*on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  if (utc) {
    const [, hh, mm, mon, day, year] = utc;
    const month = MONTHS[mon.toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const ms = Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm));
      if (!Number.isNaN(ms)) return { ms, source: "text:UTC" };
    }
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// ── Question classification ─────────────────────────────────────────────────
// Disqualifiers: phrasings the GBM *terminal* model must NOT price.

/** Barrier/touch: resolves on the path, not the endpoint. */
const BARRIER_RE =
  /\b(at any (?:point|time|moment)|at some point|ever|touch(?:es|ed|ing)?|reach(?:es|ed|ing)?|hit(?:s|ting)?|surpass(?:es|ed)?|cross(?:es|ed)?|any time during|during the|throughout|intraday|high of|low of|peak|trough)\b/i;

/** A window spanning two calendar dates ("between Aug 3 and Aug 9"). */
const DATE_WINDOW_RE =
  /between\s+(?:[A-Za-z]+\.?\s+\d{1,2}|\d{1,2}\s+[A-Za-z]+)(?:st|nd|rd|th)?(?:,?\s*\d{4})?\s+and\s+(?:[A-Za-z]+\.?\s+\d{1,2}|\d{1,2}\s+[A-Za-z]+)/i;

/** A numeric price band, e.g. "$1,400-$1,500" or "$1,400 to $1,500". Requires a
 *  $ on the second operand so calendar/date ranges don't match. */
const PRICE_RANGE_RE = /\$\s*[\d,]+(?:\.\d+)?\s*(?:-|–|—|to|and)\s*\$\s*[\d,]+/;
const INCLUSIVE_RE = /\binclusive\b/i;

/** Time/volume-weighted or averaged levels. */
const TWAP_RE = /\b(twap|vwap|time[-\s]?weighted|volume[-\s]?weighted|average|mean|median)\b/i;

/** Compared to another (non-fixed) reference price, e.g. "at or above the 17:00 price". */
const RELATIVE_RE =
  /\b(?:at or above|at or below|above|below|higher than|lower than|greater than|less than|≥|≤|>=|<=)\s+the\b[^.?]*\bprice\b/i;

// Positive terminal markers: at least one must be present.
const TERMINAL_TIME_RE = /\bat\s+\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.|utc|[a-z]{2,4})?\b/i;
const TERMINAL_CLOSE_RE =
  /\b(when\s+(?:this|the)\s+market\s+closes?|at\s+(?:the\s+)?close|at\s+settlement|at\s+expir\w*|at\s+market\s+close|by\s+(?:the\s+)?close)\b/i;
const TERMINAL_DATE_ON_RE = /\bon\s+[A-Z][a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}\b/;
const TERMINAL_BY_RE = /\bby\s+(?:\d{1,2}:\d{2}|[A-Z][a-z]+\.?\s+\d{1,2})/;

/** Returns a disqualification reason for non-terminal question shapes, else null. */
function disqualify(q: string): string | null {
  if (BARRIER_RE.test(q)) return "barrier/touch phrasing";
  if (DATE_WINDOW_RE.test(q)) return "spans a date window (barrier-style)";
  if (INCLUSIVE_RE.test(q) || PRICE_RANGE_RE.test(q)) return "price-range question";
  if (TWAP_RE.test(q)) return "TWAP/average question";
  if (RELATIVE_RE.test(q)) return "relative-to-another-price question";
  return null;
}

/** True if the question clearly settles at a single terminal instant. */
function isTerminal(q: string): boolean {
  return (
    TERMINAL_TIME_RE.test(q) ||
    TERMINAL_CLOSE_RE.test(q) ||
    TERMINAL_DATE_ON_RE.test(q) ||
    TERMINAL_BY_RE.test(q)
  );
}

/**
 * Parse a market into a terminal threshold spec, or explain why it can't.
 * Order: asset → disqualifiers → terminal marker → comparator+number → settlement.
 * Strict and abstain-by-default: only clearly-terminal threshold questions parse.
 */
export function parseThresholdMarket(market: Market): ParseResult {
  const q = market.metadata?.question;
  if (!q) return { ok: false, reason: "no question text" };

  const asset = detectAsset(q);
  if (!asset) return { ok: false, reason: "no recognized asset" };

  const dq = disqualify(q);
  if (dq) return { ok: false, reason: `abstain: ${dq}` };

  if (!isTerminal(q)) {
    return { ok: false, reason: "abstain: no clear terminal settlement phrasing" };
  }

  const thr = detectThreshold(q);
  if (!thr) return { ok: false, reason: "no comparator + numeric threshold" };

  const settle = detectSettlement(market);
  if (!settle) return { ok: false, reason: "no settlement timestamp" };

  return {
    ok: true,
    value: {
      asset: asset.key,
      symbol: asset.symbol,
      direction: thr.direction,
      threshold: thr.threshold,
      settlementMs: settle.ms,
      settlementSource: settle.source,
    },
  };
}

/**
 * Map an outcome label to the side of the proposition it represents.
 * "aff" = proposition TRUE (Yes/Above/Over/Higher/Up), "neg" = FALSE. null = can't tell.
 */
export function outcomePolarity(name: string): "aff" | "neg" | null {
  const n = name.trim().toLowerCase();
  if (/^(yes|above|over|higher|up|true)\b/.test(n)) return "aff";
  if (/^(no|below|under|lower|down|false)\b/.test(n)) return "neg";
  return null;
}
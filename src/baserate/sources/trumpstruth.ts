/**
 * Trump Truth Social posting-rate source (trumpstruth.org RSS).
 *
 * Fetches a trailing window of the date-filterable RSS feed, parses each item's
 * <pubDate> and <title>, buckets into per-day counts (America/New_York), and
 * returns the daily series → mean/day + over-dispersion for the NB model.
 *
 * Two input-semantics controls (both audited in the returned model):
 *   - dropZeroDays: treat 0-count days as MISSING (dropped from mean/variance)
 *     rather than genuine quiet days. A compulsive poster showing 0 is more likely
 *     a fetch/date-boundary artifact. Default on; we report mean with AND without
 *     zeros so you can see the impact.
 *   - countMode "all" | "original": if the feed marks reposts (ReTruths), count
 *     originals only. IMPORTANT: whether the RSS actually distinguishes reposts
 *     could NOT be verified from the build environment — the model reports how many
 *     items were classified as reposts and a few sample titles so you can confirm
 *     detection works. If repostsDetected is 0, "original" == "all" (no filtering).
 *
 * Robust to the feed ignoring date params or capping responses: items are
 * de-duplicated by id and filtered to the requested window, and over-long windows
 * are subdivided. Any failure/empty → null → estimator abstains. Never guesses.
 */

import { withRetry, type RetryOptions } from "../../retry.js";
import { logger } from "../../logger.js";

export interface RateModel {
  meanPerDay: number;
  variancePerDay: number;
  lookbackDays: number; // days used in the stats calc (after any zero-drop)
  dailyCounts: number[]; // full per-day series incl. zeros (for display)
  source: string;
  asOf: string;
  // Audit fields:
  countMode: "all" | "original";
  totalItems: number;
  repostsDetected: number;
  droppedZeroDays: number;
  meanWithZeros: number;
  meanWithoutZeros: number;
  sampleTitles: { title: string; isRepost: boolean }[];
}

export interface TrumpsTruthOptions {
  baseUrl: string;
  lookbackDays: number;
  retry: Partial<RetryOptions>;
  cacheTtlMs?: number;
  dropZeroDays: boolean;
  countMode: "all" | "original";
  repostPattern: RegExp;
}

interface Item {
  id: string;
  date: Date;
  title: string;
  isRepost: boolean;
}

const cache = new Map<string, { at: number; val: RateModel }>();
const MAX_DEPTH = 6;
const SUSPECT_MIN_ITEMS = 25;

export async function fetchTrumpTruthRate(opts: TrumpsTruthOptions): Promise<RateModel | null> {
  const ttl = opts.cacheTtlMs ?? 12 * 60 * 60 * 1000;
  const key = `${opts.baseUrl}|${opts.lookbackDays}|${opts.countMode}|${opts.dropZeroDays}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;

  try {
    const end = new Date();
    const start = new Date(end.getTime() - opts.lookbackDays * 86_400_000);
    let requests = 0;
    const items = new Map<string, Item>(); // de-dup by id

    const fetchRange = async (s: Date, e: Date, depth: number): Promise<void> => {
      if (requests > 40) return;
      requests++;
      const url = `${opts.baseUrl}/feed?start_date=${etDay(s)}&end_date=${etDay(e)}`;
      const xml = await withRetry(() => getText(url), { ...opts.retry, label: "trumpstruth" });
      const parsed = parseItems(xml, opts.repostPattern);
      if (parsed.length === 0) return;

      for (const it of parsed) items.set(it.id, it);

      const earliest = parsed.reduce((a, b) => (a.date < b.date ? a : b)).date;
      const spanDays = Math.round((e.getTime() - s.getTime()) / 86_400_000);
      const looksTruncated = earliest.getTime() > s.getTime() + 86_400_000;
      if (depth < MAX_DEPTH && spanDays > 1 && looksTruncated && parsed.length >= SUSPECT_MIN_ITEMS) {
        const mid = new Date((s.getTime() + e.getTime()) / 2);
        await fetchRange(s, mid, depth + 1);
        await fetchRange(new Date(mid.getTime() + 86_400_000), e, depth + 1);
      }
    };

    await fetchRange(start, end, 0);

    // Keep only items inside the requested window (guards against ignored params).
    const all = [...items.values()].filter((i) => i.date >= start && i.date <= end);
    const repostsDetected = all.filter((i) => i.isRepost).length;
    const included = opts.countMode === "original" ? all.filter((i) => !i.isRepost) : all;

    // Per-day counts across the full window (missing days = 0).
    const counts = new Map<string, number>();
    for (const it of included) {
      const day = etDay(it.date);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const dailyCounts: number[] = [];
    for (let i = 0; i < opts.lookbackDays; i++) {
      dailyCounts.push(counts.get(etDay(new Date(start.getTime() + i * 86_400_000))) ?? 0);
    }

    const total = dailyCounts.reduce((a, b) => a + b, 0);
    if (total === 0) {
      logger.warn("trumpstruth: 0 posts in window → abstain", { baseUrl: opts.baseUrl, countMode: opts.countMode });
      return null;
    }

    const nonzero = dailyCounts.filter((c) => c > 0);
    const meanWithZeros = total / dailyCounts.length;
    const meanWithoutZeros = nonzero.length > 0 ? nonzero.reduce((a, b) => a + b, 0) / nonzero.length : NaN;

    // Choose the stats basis per the zero-handling flag (fall back if too few days).
    const useNonzero = opts.dropZeroDays && nonzero.length >= 2;
    const statDays = useNonzero ? nonzero : dailyCounts;
    const mean = statDays.reduce((a, b) => a + b, 0) / statDays.length;
    const variance =
      statDays.length > 1
        ? statDays.reduce((a, c) => a + (c - mean) ** 2, 0) / (statDays.length - 1)
        : mean;

    const val: RateModel = {
      meanPerDay: mean,
      variancePerDay: variance,
      lookbackDays: statDays.length,
      dailyCounts,
      source: "trumpstruth.org/feed",
      asOf: new Date().toISOString(),
      countMode: opts.countMode,
      totalItems: all.length,
      repostsDetected,
      droppedZeroDays: useNonzero ? dailyCounts.length - nonzero.length : 0,
      meanWithZeros,
      meanWithoutZeros,
      sampleTitles: all.slice(0, 6).map((i) => ({ title: i.title.slice(0, 80), isRepost: i.isRepost })),
    };
    cache.set(key, { at: Date.now(), val });
    return val;
  } catch (err) {
    logger.warn("trumpstruth: fetch failed → abstain (baseline)", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Parse RSS <item> blocks into {id, date, title, isRepost}. */
export function parseItems(xml: string, repostRe: RegExp): Item[] {
  const out: Item[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const dateStr = tag(block, "pubDate") ?? tag(block, "dc:date") ?? tag(block, "published") ?? tag(block, "updated");
    if (!dateStr) continue;
    const t = Date.parse(dateStr.trim());
    if (Number.isNaN(t)) continue;
    const title = decode(tag(block, "title") ?? "");
    const description = tag(block, "description") ?? "";
    const category = tag(block, "category") ?? "";
    const guid = tag(block, "guid") ?? "";
    const hay = `${title} ${category} ${description}`;
    const isRepost = repostRe.test(hay);
    const id = guid || `${dateStr}|${title}`;
    out.push({ id, date: new Date(t), title, isRepost });
  }
  // Atom fallback if no <item> blocks.
  if (out.length === 0) {
    const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
    for (const block of entries) {
      const dateStr = tag(block, "updated") ?? tag(block, "published");
      if (!dateStr) continue;
      const t = Date.parse(dateStr.trim());
      if (Number.isNaN(t)) continue;
      const title = decode(tag(block, "title") ?? "");
      const isRepost = repostRe.test(title);
      out.push({ id: tag(block, "id") || `${dateStr}|${title}`, date: new Date(t), title, isRepost });
    }
  }
  return out;
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function etDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function _clearTrumpTruthCache(): void {
  cache.clear();
}
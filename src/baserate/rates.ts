/**
 * Base-rate entity config loader.
 *
 * `base-rates.json` now maps each entity to MATCH rules plus a `source` — the id
 * of a live rate fetcher (see ./sources) — instead of a hand-entered rate. This
 * is the "never hand-research" change: rates are fetched dynamically.
 *
 * An optional `rate_per_day` is still honored as a manual OVERRIDE if you ever
 * want to pin one, but the default path is `source`. An entity with neither a
 * registered source nor a manual rate cannot be priced → the estimator abstains
 * (this is how Musk/X stays flat: no source, no guess).
 *
 * Missing/malformed file → no entities → abstain everywhere. Never throws.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";

export interface EntityMatch {
  all?: string[];
  any?: string[];
}

export interface EntityConfig {
  key: string;
  match: EntityMatch;
  /** Live rate source id (e.g. "trumpstruth"). Preferred. */
  source?: string;
  /** Manual override rate (posts/day). Used only if set; otherwise `source` is used. */
  ratePerDay?: number;
  note?: string;
}

interface RawEntry {
  match?: EntityMatch;
  source?: string;
  rate_per_day?: number;
  note?: string;
}

export function loadRates(path = "base-rates.json"): EntityConfig[] {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), path), "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") logger.warn("base-rates.json unreadable; ignoring", { message: e.message });
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, RawEntry>;
    const entities: EntityConfig[] = [];
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry.match || (!entry.match.all && !entry.match.any)) {
        logger.warn("base-rates: skipping entity with no match rules", { key });
        continue;
      }
      const hasSource = typeof entry.source === "string" && entry.source.length > 0;
      const rate = Number(entry.rate_per_day);
      const hasManual = Number.isFinite(rate) && rate > 0;
      if (!hasSource && !hasManual) {
        logger.warn("base-rates: entity has neither source nor rate_per_day → will abstain", { key });
      }
      entities.push({
        key,
        match: entry.match,
        source: hasSource ? entry.source : undefined,
        ratePerDay: hasManual ? rate : undefined,
        note: entry.note,
      });
    }
    if (entities.length > 0) logger.info("Loaded base-rate entities", { entities: entities.length });
    return entities;
  } catch (err) {
    logger.warn("base-rates.json invalid JSON; ignoring", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
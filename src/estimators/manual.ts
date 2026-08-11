/**
 * Manual override estimator.
 *
 * Lets you inject your own probability for specific market outcomes. Reads
 * `manual-overrides.json` from the project root on construction (copy
 * `manual-overrides.example.json` to start). If the file is missing or malformed
 * it simply abstains everywhere — never throws into the pipeline.
 *
 * File shape (market id = the market's on-chain address, lowercased):
 * {
 *   "0x909629ec1e8167e48c2fa58a550513e32d4789b0": {
 *     "note": "Jason Day — I think the market underrates him",
 *     "outcomes": { "0": 0.08 }        // outcomeIdx -> probability in [0,1]
 *   }
 * }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Estimate, ProbabilityEstimator } from "./types.js";
import { logger } from "../logger.js";

interface OverrideEntry {
  note?: string;
  outcomes: Record<string, number>;
}
type OverrideFile = Record<string, OverrideEntry>;

export class ManualOverrideEstimator implements ProbabilityEstimator {
  readonly name = "manual";
  private readonly overrides: OverrideFile;

  constructor(path = "manual-overrides.json") {
    this.overrides = ManualOverrideEstimator.load(path);
    const count = Object.keys(this.overrides).length;
    if (count > 0) logger.info("Loaded manual overrides", { markets: count });
  }

  private static load(path: string): OverrideFile {
    try {
      const raw = readFileSync(resolve(process.cwd(), path), "utf8");
      const parsed = JSON.parse(raw) as OverrideFile;
      // Normalize keys to lowercase so address casing never matters.
      const normalized: OverrideFile = {};
      for (const [id, entry] of Object.entries(parsed)) {
        normalized[id.toLowerCase()] = entry;
      }
      return normalized;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Missing file is the normal case — abstain silently.
      if (e.code !== "ENOENT") {
        logger.warn("manual-overrides.json present but unreadable; ignoring", {
          message: e.message,
        });
      }
      return {};
    }
  }

  async estimate(market: Market, outcomeIdx: number): Promise<Estimate | null> {
    const entry = this.overrides[market.id.toLowerCase()];
    const value = entry?.outcomes?.[String(outcomeIdx)];
    if (value === undefined) return null;
    if (value < 0 || value > 1 || Number.isNaN(value)) {
      logger.warn("Ignoring out-of-range manual override", { market: market.id, outcomeIdx, value });
      return null;
    }
    return {
      probability: value,
      confidence: 1,
      rationale: entry?.note ? `manual: ${entry.note}` : "manual override",
    };
  }
}
/**
 * Trade planner (READ-ONLY).
 *
 * Turns the signal layer's output into INTENDED orders with disciplined sizing and
 * hard risk guards. It places nothing — it computes and returns a plan.
 *
 * The central correctness rule: a position must be justified by the price you'd
 * ACTUALLY fill at for that size, not the 1-share probe price. On thin LMSR books
 * a large order walks the price up (high avgFill), which shrinks the real edge. So
 * for each candidate we search — via read-only quoteBuy simulations — for the
 * LARGEST size whose SIZE-ADJUSTED edge (estimate − avgFill) still clears
 * minEdgeToTrade AND whose avg-fill slippage stays under maxSlippagePct, capped by
 * the per-market and total exposure limits. Then a portfolio pass enforces a
 * concentration cap so no single market dominates.
 *
 * Guards, all enforced here:
 *   - candidate screen: 1-share edgeAfterSlippage ≥ minEdgeToTrade
 *   - size-adjusted edge: estimate − avgFill(size) ≥ minEdgeToTrade at the chosen size
 *   - max slippage: avgFill slippage ≤ maxSlippagePct
 *   - exposure caps: ≤ maxPositionPerMarket and ≤ maxTotalExposure (on priced cost)
 *   - concentration: no market > maxConcentration of total (min feasible = 1/n)
 * Every skip/shrink records a reason.
 */

import { parseUnits, formatUnits } from "viem";
import type { Signal } from "../signal.js";
import type { QuoteProvider } from "../slippage.js";
import { targetStake } from "./sizing.js";
import { logger } from "./../logger.js";

export type ShrinkReason = "edge" | "slippage" | "cap" | "concentration";

export interface IntendedOrder {
  marketId: string;
  marketAddress: `0x${string}`;
  question: string;
  outcomeIdx: number;
  outcomeName: string;
  source: string;
  estimate: number; // q
  spot: number;
  impliedProb: number;
  confidence: number;
  oneShareEdge: number; // edgeAfterSlippage from the 1-share probe
  sizeAdjustedEdge: number; // estimate − avgFill at the FINAL size
  shares: number;
  sharesOut: bigint; // 18-decimals
  expectedCostTst: number; // realistic cost at this size (from quoteBuy)
  avgFillPrice: number;
  expectedSlippagePct: number;
  maxTokensIn: bigint; // slippage guard for the (future) live buy
  shrunk: boolean;
  shrinkReason?: ShrinkReason;
  exposureAfter: number; // running total after this order
}

export interface Skip {
  marketId: string;
  outcomeName: string;
  source: string;
  oneShareEdge: number | null;
  reason: string;
}

export interface Plan {
  orders: IntendedOrder[];
  skips: Skip[];
  portfolio: {
    bankroll: number;
    totalExposure: number;
    utilizationPct: number;
    marketsCount: number;
    byMarket: { marketId: string; question: string; exposure: number }[];
    largestMarketSharePct: number;
    concentrationCapPct: number; // the effective cap applied (max(config, 1/n))
  };
}

export interface PlannerConfig {
  bankroll: number;
  kellyFraction: number;
  maxPositionPerMarket: number;
  maxTotalExposure: number;
  minEdgeToTrade: number;
  slippageTolerance: number; // for maxTokensIn (live guard)
  minOrderTst: number;
  maxSlippagePct: number;
  maxConcentration: number;
  tokenDecimals: number;
  /** If > 0, aim each order into [targetOrderMin, targetOrderMax] TST, shrinking
   *  below the min only when the book can't absorb it under the slippage cap. */
  targetOrderMin: number;
  targetOrderMax: number;
}

interface Priced {
  sharesOut: bigint;
  tokensIn: bigint;
  shares: number;
  cost: number;
  avgFill: number;
  slipFrac: number;
}

export async function planTrades(
  quotes: QuoteProvider,
  signals: Signal[],
  cfg: PlannerConfig,
): Promise<Plan> {
  const maxSlipFrac = cfg.maxSlippagePct / 100;

  // Candidate screen: real estimator, positive, clears the 1-share threshold.
  const candidates = signals
    .filter(
      (s) =>
        s.estimate !== null &&
        s.edgeAfterSlippage !== null &&
        s.avgProbePrice !== null &&
        s.spotPrice !== null &&
        s.estimatorSource !== "baseline" &&
        s.edgeAfterSlippage >= cfg.minEdgeToTrade,
    )
    .sort((a, b) => (b.edgeAfterSlippage ?? 0) - (a.edgeAfterSlippage ?? 0));

  const orders: IntendedOrder[] = [];
  const skips: Skip[] = [];
  const perMarket = new Map<string, number>();
  let totalExposure = 0;

  for (const s of candidates) {
    const q = s.estimate as number;
    const spot = s.spotPrice as number;
    const cEff = s.avgProbePrice as number;
    const confidence = s.confidence ?? 0.5;
    const oneShareEdge = s.edgeAfterSlippage as number;
    const marketAddress = s.marketId as `0x${string}`;
    const skip = (reason: string) =>
      skips.push({ marketId: s.marketId, outcomeName: s.outcomeName, source: s.estimatorSource ?? "?", oneShareEdge, reason });

    // Sizing. When a target range is set, aim for targetOrderMax (capped by room),
    // and keep the SLIPPAGE guard so a thin book can pull the fill below the range
    // rather than blowing past your slippage limit. Edge-shrink is bypassed in range
    // mode (you want participation at size, not Kelly's tiny bet on a weak edge).
    const rangeMode = cfg.targetOrderMax > 0;
    const desiredStake = rangeMode
      ? cfg.targetOrderMax
      : targetStake({ q, cEff, confidence, kellyFraction: cfg.kellyFraction }, cfg.bankroll);
    const perMarketRoom = cfg.maxPositionPerMarket - (perMarket.get(s.marketId) ?? 0);
    const totalRoom = cfg.maxTotalExposure - totalExposure;
    const maxStake = Math.min(desiredStake, cfg.maxPositionPerMarket, perMarketRoom, totalRoom);
    if (maxStake < cfg.minOrderTst) {
      if (totalRoom < cfg.minOrderTst) skip("total exposure cap reached");
      else if (perMarketRoom < cfg.minOrderTst) skip("per-market cap reached");
      else skip("kelly size below min order");
      continue;
    }

    const found = await largestFeasibleOrder(quotes, marketAddress, s.outcomeIdx, {
      q, spot, decimals: cfg.tokenDecimals,
      maxStake, minOrder: cfg.minOrderTst,
      minEdge: rangeMode ? -1e9 : cfg.minEdgeToTrade,
      maxSlipFrac,
    });
    if ("reason" in found) {
      skip(found.reason);
      continue;
    }
    const priced = found.priced;

    totalExposure += priced.cost;
    perMarket.set(s.marketId, (perMarket.get(s.marketId) ?? 0) + priced.cost);

    orders.push({
      marketId: s.marketId,
      marketAddress,
      question: s.question,
      outcomeIdx: s.outcomeIdx,
      outcomeName: s.outcomeName,
      source: s.estimatorSource ?? "?",
      estimate: q,
      spot,
      impliedProb: s.impliedProb ?? cEff,
      confidence,
      oneShareEdge,
      sizeAdjustedEdge: q - priced.avgFill,
      shares: priced.shares,
      sharesOut: priced.sharesOut,
      expectedCostTst: priced.cost,
      avgFillPrice: priced.avgFill,
      expectedSlippagePct: priced.slipFrac * 100,
      maxTokensIn: withTolerance(priced.tokensIn, cfg.slippageTolerance),
      shrunk: priced.cost < desiredStake * 0.99,
      shrinkReason: priced.cost < desiredStake * 0.99 ? found.binding : undefined,
      exposureAfter: totalExposure,
    });
  }

  // Portfolio pass: enforce concentration (no market > cap of total).
  // Skipped in range mode — you want the per-market size to hold in the target band.
  if (cfg.targetOrderMax <= 0) {
    await enforceConcentration(quotes, orders, skips, cfg);
  }

  // Recompute running exposure after any concentration changes.
  let running = 0;
  for (const o of orders) {
    running += o.expectedCostTst;
    o.exposureAfter = running;
  }

  return { orders, skips, portfolio: summarize(orders, cfg) };
}

/**
 * Find the largest order size (within [minOrder, maxStake]) whose size-adjusted
 * edge clears minEdge and whose slippage stays under maxSlipFrac. Uses read-only
 * quotes; both constraints are monotone in size, so a bounded binary search finds
 * the boundary.
 */
async function largestFeasibleOrder(
  quotes: QuoteProvider,
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  o: { q: number; spot: number; decimals: number; maxStake: number; minOrder: number; minEdge: number; maxSlipFrac: number },
): Promise<{ priced: Priced; binding: ShrinkReason } | { reason: string }> {
  const price = (shares: number) => priceAtShares(quotes, marketAddress, outcomeIdx, shares, o.spot, o.decimals);
  const feasible = (p: Priced) =>
    o.q - p.avgFill >= o.minEdge && p.slipFrac <= o.maxSlipFrac && p.cost <= o.maxStake * 1.001 && p.cost >= o.minOrder;

  // Feasibility floor: the smallest order we'd place.
  const minShares = o.minOrder / o.spot;
  const atMin = await price(minShares);
  if (!atMin) return { reason: "quote failed (thin/unquotable)" };
  if (o.q - atMin.avgFill < o.minEdge) return { reason: "size-adjusted edge below threshold even at min size" };
  if (atMin.slipFrac > o.maxSlipFrac) return { reason: `slippage ${(atMin.slipFrac * 100).toFixed(0)}% exceeds cap even at min size` };

  // Upper bound: shares that cost ≈ maxStake (shrink if slippage overshoots).
  let hiShares = o.maxStake / atMin.avgFill;
  let hi = await price(hiShares);
  for (let i = 0; i < 6 && hi && hi.cost > o.maxStake && hi.cost > 0; i++) {
    hiShares *= (o.maxStake / hi.cost) * 0.999;
    hi = await price(hiShares);
  }
  if (!hi) return { reason: "quote failed at size" };

  // If the cap-limited size is already feasible, take it (cap-bound).
  if (feasible(hi)) return { priced: hi, binding: "cap" };

  // Otherwise binary-search the boundary between min (feasible) and hi (infeasible).
  let lo = minShares;
  let hiB = hiShares;
  let best = atMin;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hiB) / 2;
    const p = await price(mid);
    if (p && feasible(p)) {
      best = p;
      lo = mid;
    } else {
      hiB = mid;
    }
  }

  // Which constraint is binding at the chosen size (smallest relative slack)?
  const edgeSlack = (o.q - best.avgFill) - o.minEdge;
  const slipSlack = o.maxSlipFrac - best.slipFrac;
  const capSlack = o.maxStake - best.cost;
  const binding: ShrinkReason =
    edgeSlack <= slipSlack && edgeSlack <= capSlack ? "edge" : slipSlack <= capSlack ? "slippage" : "cap";
  return { priced: best, binding };
}

/** Enforce the concentration cap by shrinking (or dropping) over-weight markets. */
async function enforceConcentration(
  quotes: QuoteProvider,
  orders: IntendedOrder[],
  skips: Skip[],
  cfg: PlannerConfig,
): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const n = orders.length;
    if (n <= 1) return; // can't reduce concentration with 0 or 1 positions
    const eff = Math.max(cfg.maxConcentration, 1 / n);
    let total = orders.reduce((a, o) => a + o.expectedCostTst, 0);
    let changed = false;

    for (const o of [...orders].sort((a, b) => b.expectedCostTst - a.expectedCostTst)) {
      if (o.expectedCostTst / total <= eff + 1e-6) continue;
      const restTotal = total - o.expectedCostTst;
      const target = eff >= 1 ? o.expectedCostTst : (eff / (1 - eff)) * restTotal;
      if (target < cfg.minOrderTst) {
        // Drop it — can't hold even a min order without breaching concentration.
        skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, source: o.source, oneShareEdge: o.oneShareEdge, reason: "dropped by concentration cap (below min after shrink)" });
        orders.splice(orders.indexOf(o), 1);
        changed = true;
        break; // restart pass with new n
      }
      const repriced = await priceForTargetCost(quotes, o, target, cfg);
      if (repriced) {
        total = total - o.expectedCostTst + repriced.cost;
        applyReprice(o, repriced, cfg, "concentration");
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/** Re-price an order down toward a target cost (proportional iteration). */
async function priceForTargetCost(
  quotes: QuoteProvider,
  o: IntendedOrder,
  targetCost: number,
  cfg: PlannerConfig,
): Promise<Priced | null> {
  let shares = o.shares * (targetCost / o.expectedCostTst);
  let last: Priced | null = null;
  for (let i = 0; i < 5; i++) {
    const p = await priceAtShares(quotes, o.marketAddress, o.outcomeIdx, shares, o.spot, cfg.tokenDecimals);
    if (!p) break;
    last = p;
    if (Math.abs(p.cost - targetCost) / targetCost < 0.03) break;
    shares *= targetCost / p.cost;
  }
  return last;
}

function applyReprice(o: IntendedOrder, p: Priced, cfg: PlannerConfig, reason: ShrinkReason): void {
  o.shares = p.shares;
  o.sharesOut = p.sharesOut;
  o.expectedCostTst = p.cost;
  o.avgFillPrice = p.avgFill;
  o.expectedSlippagePct = p.slipFrac * 100;
  o.sizeAdjustedEdge = o.estimate - p.avgFill;
  o.maxTokensIn = withTolerance(p.tokensIn, cfg.slippageTolerance);
  o.shrunk = true;
  o.shrinkReason = reason;
}

async function priceAtShares(
  quotes: QuoteProvider,
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  shares: number,
  spot: number,
  decimals: number,
): Promise<Priced | null> {
  if (!(shares > 0)) return null;
  try {
    const sharesOut = parseUnits(shares.toFixed(18), 18);
    const { tokensIn } = await quotes.quoteBuy({ marketAddress, outcomeIdx, sharesOut });
    const cost = Number(formatUnits(tokensIn, decimals));
    const avgFill = cost / shares;
    const slipFrac = spot > 0 ? (avgFill - spot) / spot : NaN;
    return { sharesOut, tokensIn, shares, cost, avgFill, slipFrac };
  } catch (err) {
    logger.debug("planner: quote failed", { marketAddress, outcomeIdx, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function withTolerance(tokensIn: bigint, tol: number): bigint {
  const bps = BigInt(10_000 + Math.round(tol * 10_000));
  return (tokensIn * bps) / 10_000n;
}

function summarize(orders: IntendedOrder[], cfg: PlannerConfig): Plan["portfolio"] {
  const byMarketMap = new Map<string, { question: string; exposure: number }>();
  let total = 0;
  for (const o of orders) {
    total += o.expectedCostTst;
    const cur = byMarketMap.get(o.marketId) ?? { question: o.question, exposure: 0 };
    cur.exposure += o.expectedCostTst;
    byMarketMap.set(o.marketId, cur);
  }
  const byMarket = [...byMarketMap.entries()]
    .map(([marketId, v]) => ({ marketId, question: v.question, exposure: v.exposure }))
    .sort((a, b) => b.exposure - a.exposure);
  const largest = byMarket[0]?.exposure ?? 0;
  const n = byMarket.length;
  return {
    bankroll: cfg.bankroll,
    totalExposure: total,
    utilizationPct: cfg.maxTotalExposure > 0 ? (total / cfg.maxTotalExposure) * 100 : 0,
    marketsCount: n,
    byMarket,
    largestMarketSharePct: total > 0 ? (largest / total) * 100 : 0,
    concentrationCapPct: (n >= 1 ? Math.max(cfg.maxConcentration, 1 / Math.max(1, n)) : cfg.maxConcentration) * 100,
  };
}
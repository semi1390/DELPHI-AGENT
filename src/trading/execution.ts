/**
 * Live execution engine (only runs when DRY_RUN=false).
 *
 * Safety model — read carefully, this spends real TST:
 *   - Writes (buyShares, ensureTokenApproval, redeemPositions) run on the RAW
 *     client, never the retry `reader`, so a submitted tx is NEVER auto-resubmitted.
 *   - Idempotency: buyShares simulates→submits→waits for receipt. On SUCCESS the
 *     buy is confirmed. On THROW the outcome is ambiguous (the write may have
 *     landed but the receipt read failed), so we DO NOT resubmit — we re-read the
 *     position and only count it if shares actually increased. A double-buy is
 *     thereby impossible from an error path.
 *   - Reconciliation: each cycle reads real positions via listPositions and skips
 *     any market/outcome already held (no re-buying what we own).
 *   - Balance ceiling: never spend more than the wallet holds.
 *   - MAX_LIVE_EXPOSURE: a hard ceiling on total capital deployed across all open
 *     positions (mark-to-market), enforced on top of the planner's caps.
 *   - Redemption: settled winning positions are redeemed first each cycle to free
 *     capital before new buys.
 *
 * A per-order failure is logged and the loop continues; nothing here throws the
 * worker down.
 */

import { formatUnits } from "viem";
import type { DelphiClient, Market, Position } from "@gensyn-ai/gensyn-delphi-sdk";
import type { ResilientReader } from "../resilientClient.js";
import { withRetry } from "../retry.js";
import type { Plan, IntendedOrder } from "./planner.js";
import { logger } from "../logger.js";

export interface LiveExecConfig {
  maxTotalExposure: number;
  maxLiveExposure: number;
  minOrderTst: number;
  slippageTolerance: number;
  tokenDecimals: number;
  redeemEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPct: number;
}

export interface Fill {
  marketId: string;
  outcomeIdx: number;
  outcomeName: string;
  source: string;
  costTst: number;
  txHash: string;
  note?: string;
}

export interface ExecReport {
  wallet: string;
  balanceBefore: number;
  currentLiveExposureBefore: number;
  redeemedMarkets: number;
  redeemedTokens: number;
  soldPositions: number;
  sellProceeds: number;
  stuckNeedingLiquidation: number;
  fills: Fill[];
  skips: { marketId: string; outcomeName: string; reason: string }[];
  errors: { marketId: string; outcomeName: string; message: string; reconciled: string }[];
  spent: number;
}

const key = (market: string, outcomeIdx: number | string) => `${market.toLowerCase()}:${outcomeIdx}`;

export async function executeLivePlan(args: {
  client: DelphiClient;
  reader: ResilientReader;
  plan: Plan;
  markets: Market[];
  config: LiveExecConfig;
  dryRun: boolean;
}): Promise<ExecReport> {
  const { client, reader, plan, markets, config } = args;

  // HARD kill switch: refuse to execute unless explicitly live.
  if (args.dryRun) throw new Error("executeLivePlan called while dryRun=true — refusing to execute.");

  const { address: wallet } = await reader.getSigner();
  const report: ExecReport = {
    wallet, balanceBefore: 0, currentLiveExposureBefore: 0,
    redeemedMarkets: 0, redeemedTokens: 0, soldPositions: 0, sellProceeds: 0,
    stuckNeedingLiquidation: 0,
    fills: [], skips: [], errors: [], spent: 0,
  };

  // 1) Reconcile: read actual positions.
  let positions = await listAllPositions(reader, wallet);

  // 2) Redeem settled winners first (frees capital before buying).
  if (config.redeemEnabled) {
    const { redeemedMarkets, redeemedTokens, stuck } = await redeemSettledWinners(client, reader, positions, config.tokenDecimals);
    report.redeemedMarkets = redeemedMarkets;
    report.redeemedTokens = redeemedTokens;
    report.stuckNeedingLiquidation = stuck;
    if (redeemedMarkets > 0) positions = await listAllPositions(reader, wallet); // refresh after redemption
  }

  // 2b) Take-profit: sell OPEN positions whose value is ≥ takeProfitPct over cost.
  if (config.takeProfitEnabled) {
    const sells = await takeProfitSells(client, reader, positions, markets, config);
    report.soldPositions = sells.sold;
    report.sellProceeds = sells.proceeds;
    if (sells.sold > 0) positions = await listAllPositions(reader, wallet); // refresh after sells
  }

  // 3) Balance + current live exposure (mark-to-market on open positions).
  const { balance, decimals } = await reader.getErc20BalanceWithDecimals();
  const balanceTst = Number(formatUnits(balance, decimals));
  const heldMap = buildHeldMap(positions);
  const currentLiveExposure = markToMarket(positions, markets);
  report.balanceBefore = balanceTst;
  report.currentLiveExposureBefore = currentLiveExposure;

  // 4) Budget = tightest of: planner cap, live-exposure ceiling headroom, wallet balance.
  const remainingBudget = Math.min(
    config.maxTotalExposure,
    Math.max(0, config.maxLiveExposure - currentLiveExposure),
    balanceTst,
  );
  logger.info("live: budget", {
    wallet, balanceTst: round(balanceTst), currentLiveExposure: round(currentLiveExposure),
    maxLiveExposure: config.maxLiveExposure, remainingBudget: round(remainingBudget),
  });
  if (remainingBudget < config.minOrderTst) {
    logger.warn("live: no budget for new orders (ceiling/balance) — buying nothing this cycle", {
      remainingBudget: round(remainingBudget),
    });
    for (const o of plan.orders) report.skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, reason: "no remaining live budget (ceiling/balance)" });
    return report;
  }

  // 5) Execute orders best-first with all guards.
  for (const o of plan.orders as IntendedOrder[]) {
    const k = key(o.marketId, o.outcomeIdx);

    if ((heldMap.get(k) ?? 0n) > 0n) {
      report.skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, reason: "already holding this outcome (reconciled)" });
      continue;
    }
    if (report.spent + o.expectedCostTst > remainingBudget) {
      report.skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, reason: "would exceed remaining live budget" });
      continue;
    }
    if (o.expectedCostTst > balanceTst - report.spent) {
      report.skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, reason: "insufficient balance" });
      continue;
    }

    const marketAddress = o.marketId as `0x${string}`;
    const preShares = heldMap.get(k) ?? 0n;

    try {
      // Fresh re-quote so maxTokensIn reflects the CURRENT price (+ tolerance).
      const { tokensIn } = await reader.quoteBuy({ marketAddress, outcomeIdx: o.outcomeIdx, sharesOut: o.sharesOut });
      const maxTokensIn = withTolerance(tokensIn, config.slippageTolerance);
      const costActual = Number(formatUnits(tokensIn, config.tokenDecimals));

      // Re-check budget/balance against the fresh cost.
      if (report.spent + costActual > remainingBudget || costActual > balanceTst - report.spent) {
        report.skips.push({ marketId: o.marketId, outcomeName: o.outcomeName, reason: "fresh quote exceeds budget/balance" });
        continue;
      }

      // Approve (write, no retry). Idempotent: only sends if allowance insufficient.
      await client.ensureTokenApproval({ marketAddress, minimumAmount: maxTokensIn });

      // Buy (write, no retry). Simulates + waits for receipt internally.
      const { transactionHash } = await client.buyShares({
        marketAddress, outcomeIdx: o.outcomeIdx, sharesOut: o.sharesOut, maxTokensIn,
      });

      report.fills.push({ marketId: o.marketId, outcomeIdx: o.outcomeIdx, outcomeName: o.outcomeName, source: o.source, costTst: round(costActual), txHash: transactionHash });
      report.spent += costActual;
      heldMap.set(k, preShares + o.sharesOut);
      logger.info("live: FILLED", { market: o.marketId, outcome: o.outcomeName, costTst: round(costActual), txHash: transactionHash });
    } catch (err) {
      // IDEMPOTENCY: never resubmit. Re-read the position to learn the truth.
      const message = err instanceof Error ? err.message : String(err);
      let reconciled = "no position change — safe, not resubmitting";
      try {
        const postShares = await sharesHeldFor(reader, wallet, o.marketId, o.outcomeIdx);
        if (postShares > preShares) {
          reconciled = "buy LANDED despite error — counted, not resubmitting";
          report.fills.push({ marketId: o.marketId, outcomeIdx: o.outcomeIdx, outcomeName: o.outcomeName, source: o.source, costTst: round(o.expectedCostTst), txHash: "unknown (reconciled)", note: reconciled });
          report.spent += o.expectedCostTst;
          heldMap.set(k, postShares);
        }
      } catch (reErr) {
        reconciled = `reconcile read failed (${reErr instanceof Error ? reErr.message : String(reErr)}) — NOT resubmitting`;
      }
      report.errors.push({ marketId: o.marketId, outcomeName: o.outcomeName, message, reconciled });
      logger.error("live: order error (not resubmitting)", { market: o.marketId, outcome: o.outcomeName, message, reconciled });
    }
  }

  return report;
}

// ── Positions / reconciliation ────────────────────────────────────────────────

async function listAllPositions(reader: ResilientReader, wallet: string): Promise<Position[]> {
  const all: Position[] = [];
  const pageSize = 50;
  for (let page = 0; page < 20; page++) {
    const { positions } = await reader.listPositions({ wallet, skip: page * pageSize, limit: pageSize });
    const batch = positions ?? [];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

function buildHeldMap(positions: Position[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    let shares: bigint;
    try { shares = BigInt(p.shares); } catch { continue; }
    if (shares <= 0n) continue;
    m.set(key(p.marketProxy, p.outcomeIdx), shares);
  }
  return m;
}

async function sharesHeldFor(reader: ResilientReader, wallet: string, market: string, outcomeIdx: number): Promise<bigint> {
  const positions = await listAllPositions(reader, wallet);
  const want = key(market, outcomeIdx);
  let total = 0n;
  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    if (key(p.marketProxy, p.outcomeIdx) === want) {
      try { total += BigInt(p.shares); } catch { /* ignore */ }
    }
  }
  return total;
}

/** Mark-to-market TST value of open-market positions (for the exposure ceiling). */
function markToMarket(positions: Position[], markets: Market[]): number {
  const byId = new Map(markets.map((m) => [m.id.toLowerCase(), m]));
  let total = 0;
  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    const m = byId.get(p.marketProxy.toLowerCase());
    if (!m || m.status !== "open") continue;
    const idx = Number(p.outcomeIdx);
    const price = m.spotPrices?.[idx];
    if (price === undefined) continue;
    const shares = Number(p.shares) / 1e18;
    if (Number.isFinite(shares) && shares > 0) total += shares * price;
  }
  return total;
}

// ── Take-profit sells ───────────────────────────────────────────────────────

/**
 * Sell OPEN positions whose current sellable value is ≥ takeProfitPct over what
 * was paid (cost basis from the subgraph). Sells the full position with
 * minTokensOut slippage protection. Idempotent: sellShares waits for the receipt;
 * on error we re-read shares and only count a sale if shares actually decreased —
 * never resell. Losers are left to ride to settlement (no stop-loss).
 */
async function takeProfitSells(
  client: DelphiClient,
  reader: ResilientReader,
  positions: Position[],
  markets: Market[],
  config: LiveExecConfig,
): Promise<{ sold: number; proceeds: number }> {
  const byId = new Map(markets.map((m) => [m.id.toLowerCase(), m]));
  const subgraph = client.getSubgraph();
  const wallet = (await reader.getSigner()).address.toLowerCase();

  let sold = 0;
  let proceeds = 0;

  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    if (p.marketStatus !== "open") continue; // settled → redeem path; not sold here
    let shares: bigint;
    try { shares = BigInt(p.shares); } catch { continue; }
    if (shares <= 0n) continue;

    const market = p.marketProxy as `0x${string}`;
    const outcomeIdx = Number(p.outcomeIdx);

    // Cost basis from on-chain trades (restart-safe).
    const cb = await costBasis(subgraph, wallet, market, outcomeIdx);
    if (!cb || cb.netShares <= 0n || cb.netCostTokens <= 0n) continue;

    // Current value if we sold everything now.
    let tokensOut: bigint;
    try {
      const q = await reader.quoteSell({ marketAddress: market, outcomeIdx, sharesIn: shares });
      tokensOut = q.tokensOut;
    } catch {
      continue; // unquotable (thin) → skip
    }
    if (tokensOut <= 0n) continue;

    const cost = Number(formatUnits(cb.netCostTokens, config.tokenDecimals));
    const value = Number(formatUnits(tokensOut, config.tokenDecimals));
    const profitPct = (value - cost) / cost;

    if (profitPct < config.takeProfitPct) continue; // hold — not enough gain
    if (value < config.minOrderTst) continue; // dust — not worth gas

    const minTokensOut = withDownwardTolerance(tokensOut, config.slippageTolerance);
    const preShares = shares;
    try {
      const { transactionHash } = await client.sellShares({ marketAddress: market, outcomeIdx, sharesIn: shares, minTokensOut });
      sold++;
      proceeds += value;
      logger.info("live: TOOK PROFIT (sold)", {
        market, outcomeIdx, cost: round(cost), value: round(value), profitPct: round(profitPct, 3), txHash: transactionHash,
      });
    } catch (err) {
      // IDEMPOTENCY: re-read; only count if shares actually fell. Never resell.
      const message = err instanceof Error ? err.message : String(err);
      try {
        const postShares = await sharesHeldFor(reader, wallet, market, outcomeIdx);
        if (postShares < preShares) {
          sold++;
          proceeds += value;
          logger.info("live: sell LANDED despite error — counted, not reselling", { market, outcomeIdx, message });
        } else {
          logger.error("live: sell error (not reselling)", { market, outcomeIdx, message, reconciled: "no share change — safe" });
        }
      } catch (reErr) {
        logger.error("live: sell error + reconcile failed (NOT reselling)", { market, outcomeIdx, message, reErr: reErr instanceof Error ? reErr.message : String(reErr) });
      }
    }
  }

  return { sold, proceeds };
}

/** Net cost basis for (market, outcomeIdx) from the wallet's subgraph trades. */
async function costBasis(
  subgraph: ReturnType<DelphiClient["getSubgraph"]>,
  wallet: string,
  market: string,
  outcomeIdx: number,
): Promise<{ netShares: bigint; netCostTokens: bigint } | null> {
  try {
    let buysTokens = 0n, buysShares = 0n, sellsTokens = 0n, sellsShares = 0n;
    const pageSize = 100;
    for (let page = 0; page < 5; page++) {
      const { buys, sells } = await withRetry(
        () => subgraph.getMarketTrades(market, { first: pageSize, skip: page * pageSize }),
        { label: "getMarketTrades" },
      );
      for (const b of buys) {
        if ((b.buyer ?? "").toLowerCase() !== wallet) continue;
        if (Number(b.outcomeIdx) !== outcomeIdx) continue;
        buysTokens += safeBig(b.tokensIn);
        buysShares += safeBig(b.sharesOut);
      }
      for (const s of sells) {
        if ((s.seller ?? "").toLowerCase() !== wallet) continue;
        if (Number(s.outcomeIdx) !== outcomeIdx) continue;
        sellsTokens += safeBig(s.tokensOut);
        sellsShares += safeBig(s.sharesIn);
      }
      if (buys.length < pageSize && sells.length < pageSize) break;
    }
    const netShares = buysShares - sellsShares;
    const netCostTokens = buysTokens - sellsTokens;
    return { netShares, netCostTokens };
  } catch {
    return null;
  }
}

function safeBig(s: string | null): bigint {
  if (!s) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}

function withDownwardTolerance(tokensOut: bigint, tol: number): bigint {
  const bps = BigInt(10_000 - Math.round(tol * 10_000));
  return (tokensOut * bps) / 10_000n;
}

// ── Redemption ────────────────────────────────────────────────────────────────

async function redeemSettledWinners(
  client: DelphiClient,
  reader: ResilientReader,
  positions: Position[],
  decimals: number,
): Promise<{ redeemedMarkets: number; redeemedTokens: number; stuck: number }> {
  // Candidate settled markets we still hold and haven't redeemed.
  const settled = new Set<string>();
  let stuck = 0;
  for (const p of positions) {
    if (p.redeemedOrLiquidated) continue;
    let shares = 0n;
    try { shares = BigInt(p.shares); } catch { continue; }
    if (shares <= 0n) continue;
    if (p.marketStatus === "settled") settled.add(p.marketProxy.toLowerCase());
    else if (p.marketStatus === "expired" || p.marketStatus === "failed") stuck++;
  }
  if (settled.size === 0) return { redeemedMarkets: 0, redeemedTokens: 0, stuck };

  // Only redeem markets where WE are a winner (quoteRedeem tokensOut > 0).
  const winners: `0x${string}`[] = [];
  for (const market of settled) {
    try {
      const { tokensOut } = await reader.quoteRedeem({ marketAddress: market as `0x${string}` });
      if (tokensOut > 0n) winners.push(market as `0x${string}`);
    } catch {
      // Not redeemable / reverts (e.g. losing side or not settled yet) → skip.
    }
  }
  if (winners.length === 0) {
    if (stuck > 0) logger.info("live: positions in expired/failed markets need liquidation (not handled here)", { stuck });
    return { redeemedMarkets: 0, redeemedTokens: 0, stuck };
  }

  logger.info("live: redeeming settled winners", { markets: winners.length });
  const res = await client.redeemPositions({ marketAddresses: winners });
  const okCount = res.results.filter((r) => r.success).length;
  const tokens = Number(formatUnits(res.totalTokensOut, decimals));
  for (const r of res.results) {
    if (r.success) logger.info("live: REDEEMED", { market: r.marketAddress, txHash: r.transactionHash });
    else logger.warn("live: redeem failed for market (continuing)", { market: r.marketAddress, error: r.error });
  }
  return { redeemedMarkets: okCount, redeemedTokens: tokens, stuck };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function withTolerance(tokensIn: bigint, tol: number): bigint {
  const bps = BigInt(10_000 + Math.round(tol * 10_000));
  return (tokensIn * bps) / 10_000n;
}
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
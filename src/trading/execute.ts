/**
 * Live execution path — GATED AND UNUSED in this prompt.
 *
 * This is the ONLY place that would ever place a real order. It is wired to the
 * SDK's verified methods (ensureTokenApproval → buyShares), but it hard-refuses to
 * run unless `dryRun === false` is explicitly passed. The trade script defaults to
 * dry-run, so as delivered this code path is never invoked and no order is placed.
 *
 * When you later flip DRY_RUN=false, the script will call this per intended order:
 *   1. ensureTokenApproval(marketAddress, minimumAmount = maxTokensIn)
 *   2. buyShares(marketAddress, outcomeIdx, sharesOut, maxTokensIn)
 * `maxTokensIn` (from the planner, = expected cost × (1+slippageTolerance)) is the
 * on-chain slippage guard: the tx reverts rather than overpaying.
 *
 * NOTE for the live path (not needed for dry-run): retrying a write is unsafe —
 * a submitted buy must not be blindly re-sent (double-spend risk). Wrap these in
 * idempotency-aware logic (check receipt / position before re-send), NOT the
 * blanket read-retry. That belongs in the execution prompt, not here.
 */

import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type { IntendedOrder } from "./planner.js";
import { logger } from "../logger.js";

export interface ExecuteOptions {
  /** Must be explicitly false to place a real order. Anything else refuses. */
  dryRun: boolean;
}

export interface ExecutionResult {
  marketId: string;
  outcomeIdx: number;
  transactionHash: `0x${string}`;
  approvalTxHash?: `0x${string}`;
}

/**
 * Place ONE real order. Guarded: throws unless dryRun === false. Not called by the
 * dry-run script. Present so the live path is ready and type-checked against the
 * real SDK, per the "wire it but leave it gated" requirement.
 */
export async function executeOrder(
  client: DelphiClient,
  order: IntendedOrder,
  opts: ExecuteOptions,
): Promise<ExecutionResult> {
  if (opts.dryRun !== false) {
    throw new Error("executeOrder refused: DRY_RUN gate is on. Set DRY_RUN=false to enable live trading.");
  }

  logger.warn("LIVE ORDER: submitting", {
    market: order.marketId,
    outcomeIdx: order.outcomeIdx,
    sharesOut: order.sharesOut.toString(),
    maxTokensIn: order.maxTokensIn.toString(),
  });

  const approval = await client.ensureTokenApproval({
    marketAddress: order.marketAddress,
    minimumAmount: order.maxTokensIn,
  });

  const res = await client.buyShares({
    marketAddress: order.marketAddress,
    outcomeIdx: order.outcomeIdx,
    sharesOut: order.sharesOut,
    maxTokensIn: order.maxTokensIn,
  });

  logger.warn("LIVE ORDER: confirmed", { market: order.marketId, tx: res.transactionHash });
  return {
    marketId: order.marketId,
    outcomeIdx: order.outcomeIdx,
    transactionHash: res.transactionHash,
    approvalTxHash: approval.transactionHash,
  };
}
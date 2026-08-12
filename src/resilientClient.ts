/**
 * Resilient reader.
 *
 * Wraps the DelphiClient read methods this project uses so every RPC/REST call
 * goes through bounded retry + backoff. Callers use the reader instead of the raw
 * client, so retry behavior is uniform and in one place. Method signatures are
 * inherited from the client itself (via .bind), so this stays in lockstep with the
 * SDK — no hand-copied types to drift.
 *
 * Read-only surface only. Write methods (buyShares, approveToken, redeem, …) are
 * deliberately NOT exposed here — there is no execution in this project yet.
 */

import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { withRetry, type RetryOptions } from "./retry.js";
import type { QuoteProvider } from "./slippage.js";

/** Wrap one async client method so each call retries under `opts`. */
function retryify<A extends unknown[], T>(
  label: string,
  method: (...args: A) => Promise<T>,
  opts: Partial<RetryOptions>,
): (...args: A) => Promise<T> {
  return (...args: A) => withRetry(() => method(...args), { ...opts, label });
}

export function wrapClient(client: DelphiClient, opts: Partial<RetryOptions> = {}) {
  const reader = {
    // Synchronous, no network → no retry.
    getTokenAddress: (): `0x${string}` => client.getTokenAddress(),

    // REST
    health: retryify("health", client.health.bind(client), opts),
    listMarkets: retryify("listMarkets", client.listMarkets.bind(client), opts),

    // RPC
    getSigner: retryify("getSigner", client.getSigner.bind(client), opts),
    getEthBalance: retryify("getEthBalance", client.getEthBalance.bind(client), opts),
    getErc20BalanceWithDecimals: retryify(
      "getErc20BalanceWithDecimals",
      client.getErc20BalanceWithDecimals.bind(client),
      opts,
    ),
    quoteBuy: retryify("quoteBuy", client.quoteBuy.bind(client), opts),
    quoteSell: retryify("quoteSell", client.quoteSell.bind(client), opts),
    quoteRedeem: retryify("quoteRedeem", client.quoteRedeem.bind(client), opts),
    listPositions: retryify("listPositions", client.listPositions.bind(client), opts),
  };

  // The wrapped quoteBuy satisfies the slippage layer's QuoteProvider contract.
  reader satisfies QuoteProvider;
  return reader;
}

export type ResilientReader = ReturnType<typeof wrapClient>;
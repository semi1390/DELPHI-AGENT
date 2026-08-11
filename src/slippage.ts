/**
 * Slippage sensitivity probe.
 *
 * "If I bought a small size, how much worse than spot would my fill be?" We answer
 * it with a READ-ONLY `quoteBuy` (the SDK's `quoteBuyExactOut` eth_call — a
 * simulation, no transaction, no gas, works on an unfunded wallet). We ask for a
 * fixed small number of shares and compute the average price paid, then compare it
 * to the current spot price.
 *
 * A fixed probe size lets you compare markets on equal footing: a market where a
 * 1-share buy barely moves the price is deep/liquid; one where it jumps a lot is
 * thin, and an apparent edge there may not survive execution.
 *
 * Units: outcome shares are 18-decimal; `tokensIn` is in the collateral token's
 * own decimals (TST). We convert both to human numbers before dividing.
 */

import { formatUnits, parseUnits } from "viem";

/** Minimal read-only surface we need — DelphiClient satisfies this structurally. */
export interface QuoteProvider {
  quoteBuy(params: {
    marketAddress: `0x${string}`;
    outcomeIdx: number;
    sharesOut: bigint;
  }): Promise<{ tokensIn: bigint }>;
}

export interface SlippageProbe {
  /** Shares probed (human units). */
  probeShares: number;
  /** Average price per share for the probe buy (human tokens/share). */
  avgPrice: number;
  /** Current spot price for reference. */
  spotPrice: number;
  /** (avgPrice − spot) / spot, as a percentage. Higher = thinner / more slippage. */
  slippagePct: number;
}

export async function probeBuySlippage(
  quotes: QuoteProvider,
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  spotPrice: number,
  probeShares: number,
  tokenDecimals: number,
): Promise<SlippageProbe | null> {
  try {
    const sharesOut = parseUnits(String(probeShares), 18); // shares are 18-decimal
    const { tokensIn } = await quotes.quoteBuy({ marketAddress, outcomeIdx, sharesOut });

    const tokensHuman = Number(formatUnits(tokensIn, tokenDecimals));
    const avgPrice = tokensHuman / probeShares;
    const slippagePct = spotPrice > 0 ? ((avgPrice - spotPrice) / spotPrice) * 100 : NaN;

    return { probeShares, avgPrice, spotPrice, slippagePct };
  } catch {
    // Market may be too thin, closed between list and quote, or otherwise unquotable.
    return null;
  }
}
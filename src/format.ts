/**
 * Small formatting helpers shared by the CLI scripts.
 */

import { formatEther, formatUnits } from "viem";

/** Native gas balance (ETH, 18 decimals) as a trimmed human string. */
export function formatGas(wei: bigint): string {
  return trimZeros(formatEther(wei));
}

/** ERC-20 balance given its decimals, as a trimmed human string. */
export function formatToken(raw: bigint, decimals: number): string {
  return trimZeros(formatUnits(raw, decimals));
}

/** A price/probability float rendered to a fixed width, or "n/a" if missing. */
export function formatPrice(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "n/a";
  return value.toFixed(4);
}

/** A 0..1 probability rendered as a percentage, or "n/a" if missing. */
export function formatPct(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/**
 * Price-source selector.
 *
 * Abstracts the two providers behind one call. They key data differently —
 * Binance by trading pair (ETHUSDT), CoinGecko by asset key (ETH) — so this
 * returns a single `fetch(assetKey, symbol, opts)` that routes to the right one
 * with the right identifier. Default is CoinGecko (reachable where Binance DNS is
 * blocked, and works from Railway); set PRICE_SOURCE=binance to switch back.
 */

import type { AppConfig } from "../config.js";
import type { AssetStats, PriceDataOptions } from "./priceData.js";
import { getSpotAndVol } from "./priceData.js";
import { getSpotAndVolCoinGecko } from "./coingecko.js";

export interface PriceSource {
  name: "coingecko" | "binance";
  apiBase: string;
  /** Fetch spot+vol for an asset, given both its canonical key and Binance symbol. */
  fetch: (assetKey: string, symbol: string, opts: PriceDataOptions) => Promise<AssetStats | null>;
}

export function selectPriceSource(cfg: AppConfig): PriceSource {
  if (cfg.priceSource === "binance") {
    return {
      name: "binance",
      apiBase: cfg.binanceApiBase,
      fetch: (_assetKey, symbol, opts) => getSpotAndVol(symbol, opts),
    };
  }
  return {
    name: "coingecko",
    apiBase: cfg.coingeckoApiBase,
    fetch: (assetKey, _symbol, opts) => getSpotAndVolCoinGecko(assetKey, opts),
  };
}
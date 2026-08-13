/**
 * Central configuration.
 *
 * The Delphi SDK loads `.env` itself, but we also import dotenv here so this
 * module's own reads (log level, heartbeat, scan limit) work regardless of import
 * order. Constructor options we pass to DelphiClient still take precedence over env.
 *
 * We keep secrets (WALLET_PRIVATE_KEY, DELPHI_API_ACCESS_KEY) out of this object on
 * purpose — the SDK reads them straight from the environment and handles the 0x
 * prefix. We only surface *whether* they are present, plus friendly asserts, so a
 * missing key fails with a clear message instead of a cryptic SDK error.
 */

import "dotenv/config";

export type Network = "testnet" | "mainnet" | "competition-testnet";
export type SignerType = "private_key" | "cdp_server_wallet";

export interface AppConfig {
  network: Network;
  signerType: SignerType;
  /** True if WALLET_PRIVATE_KEY is set (value itself stays in env). */
  hasPrivateKey: boolean;
  /** True if DELPHI_API_ACCESS_KEY is set (value itself stays in env). */
  hasApiKey: boolean;
  /** Max markets to pull in a scan. */
  marketScanLimit: number;
  /** Heartbeat interval (minutes) for the long-running index.ts process. */
  heartbeatMinutes: number;
  /** Fixed probe size (shares) for the read-only slippage quote. */
  probeShares: number;
  /** Edge threshold (in probability terms) for flagging a buy candidate. */
  minEdge: number;
  /** Optional JSONL file to append signals to (for scheduled-run history). */
  signalLogFile?: string;
  /** Dedicated RPC URL (GENSYN_RPC_URL). Undefined = SDK uses the public endpoint. */
  rpcUrl?: string;
  /** Retry attempts after the first try for each read. */
  retries: number;
  /** First backoff delay (ms). */
  retryBaseMs: number;
  /** Max single backoff delay (ms). */
  retryMaxMs: number;
  /** Quant: annualized drift assumption for the GBM model (default 0 = no view). */
  quantDrift: number;
  /** Quant: days of daily closes used for realized-vol (default 30). */
  quantVolDays: number;
  /** Quant: Binance public data API base URL. */
  binanceApiBase: string;
  /** Quant: which price source to use — "coingecko" (default) or "binance". */
  priceSource: "coingecko" | "binance";
  /** Quant: CoinGecko API base URL. */
  coingeckoApiBase: string;
  /** Trading: HARD dry-run gate. True unless DRY_RUN=false. No orders when true. */
  dryRun: boolean;
  /** Trading: capital (TST) that Kelly sizes against. */
  bankroll: number;
  /** Trading: fraction of Kelly to apply (e.g. 0.25 = quarter Kelly). */
  kellyFraction: number;
  /** Trading: max exposure (TST) in any single market. */
  maxPositionPerMarket: number;
  /** Trading: max exposure (TST) across all positions. */
  maxTotalExposure: number;
  /** Trading: minimum post-slippage edge required to intend an order. */
  minEdgeToTrade: number;
  /** Trading: slippage tolerance for the (future) live buy's maxTokensIn guard. */
  slippageTolerance: number;
  /** Trading: minimum order size (TST); smaller intended orders are skipped. */
  minOrderTst: number;
  /** Trading: skip an order whose avg-fill slippage exceeds this (%). */
  maxSlippagePct: number;
  /** Trading: max share of total exposure any single market may hold (fraction). */
  maxConcentration: number;
  /** Base-rate: trailing days of daily counts to fetch for rate + dispersion. */
  baseRateLookbackDays: number;
  /** Base-rate: hours to cache a fetched rate before refetching. */
  baseRateCacheHours: number;
  /** Base-rate: trumpstruth.org base URL (override for testing/mirrors). */
  trumpsTruthBaseUrl: string;
  /** Base-rate: treat 0-count days as missing (drop from mean/variance). */
  baseRateDropZeroDays: boolean;
  /** Base-rate: count "all" items or "original" (exclude detected reposts). */
  baseRateCountMode: "all" | "original";
  /** Base-rate: regex (source string) used to detect reposts/ReTruths. */
  baseRateRepostPattern: string;
  /** Worker: minutes between scheduled plan cycles. */
  planIntervalMinutes: number;
  /** Worker: optional JSONL file to append intended orders to (for later review). */
  planLogFile?: string;
  /** If > 0, force this flat order size (TST) per market, bypassing edge/slippage/concentration shrink. */
  targetOrderMin: number;
  targetOrderMax: number;
  /** LIVE: hard ceiling (TST) on total capital deployed across all live positions. */
  maxLiveExposure: number;
  /** LIVE: redeem settled winning positions each cycle to free capital. */
  redeemEnabled: boolean;
  /** Mean-reversion: only fire when |price − 0.5| ≥ this (skip true coin-flips). */
  meanrevMinSkew: number;
  /** Mean-reversion: fraction of the distance to 0.5 to nudge back. */
  meanrevPull: number;
  /** Mean-reversion: hard cap on the probability shift. */
  meanrevMaxNudge: number;
  /** LIVE: take profit by selling positions up ≥ this fraction over cost. */
  takeProfitEnabled: boolean;
  /** LIVE: profit threshold (fraction) that triggers a take-profit sell. */
  takeProfitPct: number;
  /** LIVE: sell-side slippage tolerance for take-profit exits (0..1; higher = looser). */
  sellSlippageTolerance: number;
  /** LIVE: add to existing positions up to target size. */
  topUpEnabled: boolean;
  /** LIVE: skip top-up if current price exceeds cost basis by more than this fraction. */
  topUpMaxWorse: number;
  /** Data-lookup: SILSO daily sunspot CSV URL. */
  silsoUrl: string;
  /** Data-lookup: NSIDC daily Arctic sea-ice extent CSV URL. */
  nsidcUrl: string;
  /** Data-lookup: hours to cache a fetched series. */
  dataLookupCacheHours: number;
}

function parseNetwork(raw: string | undefined): Network {
  // Default to the competition network — that's the whole point of this project.
  const value = (raw ?? "competition-testnet").trim();
  if (value === "testnet" || value === "mainnet" || value === "competition-testnet") {
    return value;
  }
  throw new Error(
    `Invalid DELPHI_NETWORK="${value}". Use one of: testnet | mainnet | competition-testnet.`,
  );
}

function parseSignerType(raw: string | undefined): SignerType {
  const value = (raw ?? "private_key").trim();
  if (value === "private_key" || value === "cdp_server_wallet") return value;
  throw new Error(
    `Invalid DELPHI_SIGNER_TYPE="${value}". Use one of: private_key | cdp_server_wallet.`,
  );
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseSignedFloatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  return {
    network: parseNetwork(process.env.DELPHI_NETWORK),
    signerType: parseSignerType(process.env.DELPHI_SIGNER_TYPE),
    hasPrivateKey: Boolean(process.env.WALLET_PRIVATE_KEY?.trim()),
    hasApiKey: Boolean(process.env.DELPHI_API_ACCESS_KEY?.trim()),
    marketScanLimit: parseIntEnv(process.env.MARKET_SCAN_LIMIT, 50),
    heartbeatMinutes: parseIntEnv(process.env.HEARTBEAT_MINUTES, 15),
    probeShares: parseFloatEnv(process.env.PROBE_SHARES, 1),
    minEdge: parseFloatEnv(process.env.MIN_EDGE, 0.05),
    signalLogFile: process.env.SIGNAL_LOG_FILE?.trim() || undefined,
    rpcUrl: process.env.GENSYN_RPC_URL?.trim() || undefined,
    retries: parseIntEnv(process.env.RETRY_MAX, 4),
    retryBaseMs: parseIntEnv(process.env.RETRY_BASE_MS, 300),
    retryMaxMs: parseIntEnv(process.env.RETRY_MAX_MS, 5000),
    quantDrift: parseSignedFloatEnv(process.env.QUANT_DRIFT, 0),
    quantVolDays: parseIntEnv(process.env.QUANT_VOL_DAYS, 30),
    binanceApiBase: process.env.BINANCE_API_BASE?.trim() || "https://data-api.binance.vision",
    priceSource: process.env.PRICE_SOURCE?.trim() === "binance" ? "binance" : "coingecko",
    coingeckoApiBase: process.env.COINGECKO_API_BASE?.trim() || "https://api.coingecko.com",
    // Trading — HARD gate: dry-run unless DRY_RUN is exactly "false".
    dryRun: process.env.DRY_RUN?.trim() !== "false",
    bankroll: parseFloatEnv(process.env.BANKROLL, 1000),
    kellyFraction: parseFloatEnv(process.env.KELLY_FRACTION, 0.25),
    maxPositionPerMarket: parseFloatEnv(process.env.MAX_POSITION_PER_MARKET, 100),
    maxTotalExposure: parseFloatEnv(process.env.MAX_TOTAL_EXPOSURE, 500),
    minEdgeToTrade: parseFloatEnv(process.env.MIN_EDGE_TO_TRADE, 0.05),
    slippageTolerance: parseFloatEnv(process.env.SLIPPAGE_TOLERANCE, 0.02),
    minOrderTst: parseFloatEnv(process.env.MIN_ORDER_TST, 1),
    maxSlippagePct: parseFloatEnv(process.env.MAX_SLIPPAGE_PCT, 12),
    maxConcentration: parseFloatEnv(process.env.MAX_CONCENTRATION, 0.35),
    baseRateLookbackDays: parseIntEnv(process.env.BASERATE_LOOKBACK_DAYS, 30),
    baseRateCacheHours: parseIntEnv(process.env.BASERATE_CACHE_HOURS, 12),
    trumpsTruthBaseUrl: process.env.TRUMPSTRUTH_BASE_URL?.trim() || "https://www.trumpstruth.org",
    baseRateDropZeroDays: process.env.BASERATE_DROP_ZERO_DAYS?.trim().toLowerCase() !== "false",
    baseRateCountMode: process.env.BASERATE_COUNT_MODE?.trim() === "original" ? "original" : "all",
    baseRateRepostPattern: process.env.BASERATE_REPOST_PATTERN?.trim() || "re-?truth(ed)?|repost(ed)?|reposting|shared a",
    planIntervalMinutes: parseIntEnv(process.env.PLAN_INTERVAL_MINUTES, 20),
    planLogFile: process.env.PLAN_LOG_FILE?.trim() || undefined,
    targetOrderMin: parseFloatEnv(process.env.TARGET_ORDER_MIN, 0),
    targetOrderMax: parseFloatEnv(process.env.TARGET_ORDER_MAX, 0),
    maxLiveExposure: parseFloatEnv(process.env.MAX_LIVE_EXPOSURE, 100),
    redeemEnabled: process.env.REDEEM_ENABLED?.trim().toLowerCase() !== "false",
    meanrevMinSkew: parseFloatEnv(process.env.MEANREV_MIN_SKEW, 0.1),
    meanrevPull: parseFloatEnv(process.env.MEANREV_PULL, 0.2),
    meanrevMaxNudge: parseFloatEnv(process.env.MEANREV_MAX_NUDGE, 0.06),
    takeProfitEnabled: process.env.TAKE_PROFIT_ENABLED?.trim().toLowerCase() !== "false",
    takeProfitPct: parseFloatEnv(process.env.TAKE_PROFIT_PCT, 0.4),
    sellSlippageTolerance: parseFloatEnv(process.env.SELL_SLIPPAGE_TOLERANCE, 0.5),
    topUpEnabled: process.env.TOPUP_ENABLED?.trim().toLowerCase() === "true",
    topUpMaxWorse: parseFloatEnv(process.env.TOPUP_MAX_WORSE, 0.05),
    silsoUrl: process.env.SILSO_URL?.trim() || "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv",
    nsidcUrl: process.env.NSIDC_URL?.trim() || "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v3.0.csv",
    dataLookupCacheHours: parseIntEnv(process.env.DATALOOKUP_CACHE_HOURS, 6),
  };
}

/** Throws a friendly error if the private key needed for on-chain reads is missing. */
export function assertPrivateKey(cfg: AppConfig): void {
  if (cfg.signerType === "private_key" && !cfg.hasPrivateKey) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not set. Add it to your .env " +
        "(this is the key that controls your leaderboard identity). " +
        "See README → 'Fill in .env'.",
    );
  }
}

/** Throws a friendly error if the REST API key needed to list markets is missing. */
export function assertApiKey(cfg: AppConfig): void {
  if (!cfg.hasApiKey) {
    throw new Error(
      "DELPHI_API_ACCESS_KEY is not set. Generate a testnet key at " +
        "https://delphi-api-access.gensyn.ai/ and add it to your .env. " +
        "See README → 'Generate your API key'.",
    );
  }
}
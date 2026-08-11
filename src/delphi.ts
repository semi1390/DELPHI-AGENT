/**
 * Delphi connection module.
 *
 * Single place that constructs the SDK client and its resilient reader. We pass
 * `network`, `signerType`, and (if set) a dedicated `rpcUrl` explicitly from our
 * validated config so this module visibly owns the wiring, and let the SDK read
 * the actual secrets — WALLET_PRIVATE_KEY and DELPHI_API_ACCESS_KEY — straight
 * from the environment (it normalizes the private key's 0x prefix too).
 *
 * `reader` is what callers should use for reads: it wraps every RPC/REST method
 * in bounded retry + backoff so transient failures don't kill a run. The raw
 * `client` is still returned for anything that needs it directly.
 *
 * Network defaults (chain id, gateway/factory/token addresses, subgraph, app URL)
 * are baked into the SDK per network. RPC URL falls back to the SDK's public
 * endpoint when GENSYN_RPC_URL is unset. For competition-testnet the client also
 * auto-sends the `X-Delphi-Mode: competition` header on REST calls.
 */

import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { loadConfig, type AppConfig } from "./config.js";
import { wrapClient, type ResilientReader } from "./resilientClient.js";
import { logger } from "./logger.js";

export interface Connection {
  client: DelphiClient;
  reader: ResilientReader;
  config: AppConfig;
}

/**
 * Build a configured DelphiClient, a retry-wrapped reader, and the resolved app
 * config. Construction is cheap and does NOT touch the network or require a
 * private key — the signer is created lazily on the first call that needs it.
 */
export function createDelphiClient(): Connection {
  const config = loadConfig();

  const client = new DelphiClient({
    network: config.network,
    signerType: config.signerType,
    // Pass a dedicated RPC only when provided; otherwise the SDK uses its public
    // endpoint. (The SDK would also read GENSYN_RPC_URL itself; we pass it
    // explicitly so we can log which endpoint is actually in use.)
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    // privateKey + apiKey are intentionally read from env by the SDK.
  });

  const reader = wrapClient(client, {
    retries: config.retries,
    baseDelayMs: config.retryBaseMs,
    maxDelayMs: config.retryMaxMs,
  });

  logger.info("Delphi client initialized", {
    network: config.network,
    signerType: config.signerType,
    tokenAddress: client.getTokenAddress(),
    rpc: config.rpcUrl ? "dedicated (GENSYN_RPC_URL)" : "public (shared fallback)",
    retries: config.retries,
    hasPrivateKey: config.hasPrivateKey,
    hasApiKey: config.hasApiKey,
  });

  if (!config.rpcUrl) {
    logger.warn(
      "Using the shared public RPC. For 24/7 operation set GENSYN_RPC_URL to a " +
        "dedicated endpoint — the public one rate-limits and will intermittently fail.",
    );
  }

  return { client, reader, config };
}
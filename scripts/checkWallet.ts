/**
 * checkWallet.ts — confirm funding.
 *
 * Prints:
 *   - your wallet address (derived from WALLET_PRIVATE_KEY)
 *   - your competition-token (TST) balance
 *   - your native gas (ETH) balance
 *
 * READ-ONLY. This talks to the JSON-RPC endpoint directly and does NOT need the
 * REST API key. It DOES need WALLET_PRIVATE_KEY so it can derive your address.
 *
 * Run:  npm run wallet
 */

import { createDelphiClient } from "../src/delphi.js";
import { assertPrivateKey } from "../src/config.js";
import { formatGas, formatToken } from "../src/format.js";
import { logger, section } from "../src/logger.js";

async function main(): Promise<void> {
  const { reader, config } = createDelphiClient();
  assertPrivateKey(config);

  // Deriving the signer address requires the private key (created lazily here).
  const { address } = await reader.getSigner();

  // Native gas balance (ETH).
  const gasWei = await reader.getEthBalance();

  // Competition collateral token (TST). Defaults to the network's configured token.
  const tokenAddress = reader.getTokenAddress();
  const { balance, decimals } = await reader.getErc20BalanceWithDecimals();

  section("Wallet");
  console.log(`Network:        ${config.network}`);
  console.log(`Address:        ${address}`);
  console.log(`Token (TST):    ${formatToken(balance, decimals)}   [${tokenAddress}]`);
  console.log(`Gas (ETH):      ${formatGas(gasWei)}`);

  // Funding sanity checks — surfaced as warnings, not failures.
  if (gasWei === 0n) {
    logger.warn(
      "Gas balance is 0. You'll need testnet ETH to send transactions later " +
        "(reads still work). Fund this address before the trading prompt.",
    );
  }
  if (balance === 0n) {
    logger.warn(
      "TST balance is 0. You'll need competition tokens to trade later. " +
        "Fund this address before the trading prompt.",
    );
  }
  if (gasWei > 0n && balance > 0n) {
    logger.info("Wallet looks funded for both gas and TST.");
  }
}

main().catch((err) => {
  logger.error("checkWallet failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
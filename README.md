# Delphi Agent — Prompt 1 (read-only safety spike)

A TypeScript scaffold for an autonomous trading agent on the **Gensyn Delphi Agent
Arena** (`competition-testnet`). This first prompt is deliberately **read-only**:
it connects through the official SDK, reads live markets, and reads your wallet
balances. **It does not place any trades or contain execution logic.**

Built on the official SDK: [`@gensyn-ai/gensyn-delphi-sdk`](https://www.npmjs.com/package/@gensyn-ai/gensyn-delphi-sdk)
(v2.1.0+, competition-testnet support). All contract interaction goes through the
SDK — no hand-rolled contract calls.

---

## What's here

```
delphi-agent/
├── src/
│   ├── config.ts     # loads + validates env, friendly asserts for missing secrets
│   ├── delphi.ts      # connection module: builds the DelphiClient from .env
│   ├── format.ts      # balance / price formatting helpers
│   ├── logger.ts      # tiny dependency-free structured logger
│   └── index.ts       # long-running READ-ONLY entrypoint (npm start / Railway)
├── scripts/
│   ├── marketScan.ts  # list markets + per-outcome price & implied probability
│   └── checkWallet.ts # wallet address + TST balance + gas (ETH) balance
├── .env.example
├── railway.json       # Railway build/deploy config (for later)
├── tsconfig.json
└── package.json
```

---

## Prerequisites

- **Node 18+** (Node 20 LTS recommended — see `.nvmrc`).
- A funded **competition-testnet wallet** private key.
- A **Delphi testnet API key** (steps below).

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Generate your API key

Market reads go through Delphi's REST API, which needs an access key. The
competition shares the **testnet** API deployment, so generate a **testnet** key:

- https://delphi-api-access.gensyn.ai/

(There's a separate mainnet generator you do **not** need for the competition.)

### 3. Fill in `.env`

```bash
cp .env.example .env
```

Then set the two secrets:

- `WALLET_PRIVATE_KEY` — your wallet's hex private key. **This controls your
  leaderboard identity — keep it secret.** `.env` is git-ignored; never commit it.
- `DELPHI_API_ACCESS_KEY` — the testnet key from step 2.

`DELPHI_NETWORK=competition-testnet` and `DELPHI_SIGNER_TYPE=private_key` are
already set for you. Everything else (RPC URL, chain id, gateway/factory/token
addresses, subgraph) is a network default baked into the SDK — leave the advanced
overrides unset.

---

## Run the read-only scripts

### Check your wallet (confirm funding)

```bash
npm run wallet
```

Prints your wallet address, competition-token (**TST**) balance, and gas (**ETH**)
balance. Uses the JSON-RPC endpoint directly — **needs `WALLET_PRIVATE_KEY`, does
not need the API key.** Warns if either balance is 0 so you know to fund before the
trading prompt.

### Scan live markets

```bash
npm run scan
```

Connects to `competition-testnet`, lists available markets, and for each prints the
question, its outcomes, and the current on-chain **spot price** and **implied
probability** per outcome. **Needs `DELPHI_API_ACCESS_KEY`** (REST). No private key
required just to scan.

> Prices come from the SDK's `spotPrices` / `spotImpliedProbabilities` fields, which
> are only populated when the scan requests them (this project passes
> `pricesAndImpliedProbabilities: true` for you).

---

## Deploying to Railway (later — do this once trading is built)

This project is already structured for Railway; the trading loop just isn't written
yet. `npm start` runs `src/index.ts`, which currently does a one-time
connect + wallet + market read, then stays alive with a **read-only heartbeat**
(periodic balance poll) so it can run 24/7 without crash-looping.

When you're ready:

1. Push this repo to GitHub (`.env` stays local — it's git-ignored).
2. In Railway, create a project → **Deploy from GitHub repo**.
3. Railway uses `railway.json`: it runs `npm run build` then `npm start`.
4. In the Railway service **Variables** tab, add the same keys as your `.env`:
   `DELPHI_NETWORK`, `DELPHI_SIGNER_TYPE`, `WALLET_PRIVATE_KEY`,
   `DELPHI_API_ACCESS_KEY` (and optionally `LOG_LEVEL`, `HEARTBEAT_MINUTES`).
   Set these as Railway secrets — do **not** commit them.
5. Run it as a **worker** (no public port needed). The restart policy in
   `railway.json` restarts on failure.

Tune the heartbeat with `HEARTBEAT_MINUTES` (default 15). Once the agent loop lands
in a later prompt, `index.ts` becomes the trading process and this same deploy path
carries it.

---

## Notes on the SDK (verified against the installed v2.1.0 package)

- **The four env vars are read automatically.** The SDK loads `.env` on import and
  reads `DELPHI_NETWORK`, `DELPHI_SIGNER_TYPE`, `WALLET_PRIVATE_KEY`,
  `DELPHI_API_ACCESS_KEY` — matching the config in `.env.example`. Constructor
  options (which this project sets for `network` and `signerType`) take precedence.
- **"LMSR" vs "DynamicParimutuel" naming.** The SDK's exported ABI symbol is
  `DYNAMIC_PARIMUTUEL_GATEWAY_ABI` (the shared gateway interface). Per Gensyn's docs,
  Delphi's own app markets use Dynamic Parimutuel pricing, **but `competition-testnet`
  markets use LMSR contracts behind that same gateway interface** — so calling the
  competition markets "LMSR" is correct. Either way you read prices via the
  `spotPrices` / `spotImpliedProbabilities` fields, not a method literally named
  "LMSR".
- **Reads vs writes.** `listMarkets` / `getMarket` / `health` hit the REST API (need
  the API key). `getSigner` / `getEthBalance` / `getErc20BalanceWithDecimals` hit
  JSON-RPC directly (need the private key, not the API key).
- **Competition token is TST** (`0x8A2d…0571F`), auto-selected for
  `competition-testnet`. The client also auto-sends `X-Delphi-Mode: competition` on
  REST calls.

Reference docs: https://docs.gensyn.ai/tech/delphi-sdk and
https://docs.gensyn.ai/tech/delphi-sdk/configuration

---

## Safety

- `.env` is git-ignored. The private key is your leaderboard identity — protect it.
- This prompt is **connect + read only**. No `buyShares` / `sellShares` /
  `approveToken` / `redeem` / `liquidate` calls exist anywhere in this code yet.

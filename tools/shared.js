// shared.js — common helpers for the GMX edge-analytics tools.
//
// Read-only. These tools surface on-chain market state (funding, borrowing,
// open-interest imbalance, fees, liquidation math) so you can trade
// cost-efficiently. They do NOT predict price and cannot guarantee profit.
//
// Usage: require these helpers from the individual tool scripts.

const { GmxSdk } = require("@gmx-io/sdk");

// GMX scales all "factors" (funding, borrowing, fees) and prices by 1e30.
// Verify against @gmx-io/sdk types if a value looks off by orders of magnitude.
const PRECISION = 10n ** 30n;
const SECONDS_PER_YEAR = 31_536_000;

const CHAINS = {
  arbitrum: {
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    oracleUrl: "https://arbitrum-api.gmxinfra.io",
    subsquidUrl: "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql",
  },
  avalanche: {
    chainId: 43114,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    oracleUrl: "https://avalanche-api.gmxinfra.io",
    subsquidUrl: "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql",
  },
  botanix: {
    chainId: 3637,
    rpcUrl: "https://rpc.botanixlabs.com",
    oracleUrl: "https://botanix-api.gmxinfra.io",
    subsquidUrl: "https://gmx.squids.live/gmx-synthetics-botanix:prod/api/graphql",
  },
};

// Read-only SDK instance (no wallet needed for analytics).
function makeSdk(chainName = "arbitrum") {
  const cfg = CHAINS[chainName];
  if (!cfg) throw new Error(`Unknown chain: ${chainName}. Use one of ${Object.keys(CHAINS)}`);
  return new GmxSdk(cfg);
}

// Convert a 1e30-scaled BigInt factor to a JS float fraction (e.g. 0.0006).
function factorToFloat(factor) {
  if (factor == null) return 0;
  // Scale up before Number() to keep small-rate precision.
  return Number((BigInt(factor) * 1_000_000_000n) / PRECISION) / 1e9;
}

// A per-second rate (1e30-scaled fraction of position size) -> annualized %.
function perSecondToApr(factorPerSecond) {
  return factorToFloat(factorPerSecond) * SECONDS_PER_YEAR * 100;
}

// 1e30-scaled USD BigInt -> JS float dollars.
function usd30ToFloat(v) {
  if (v == null) return 0;
  return Number((BigInt(v) * 100n) / PRECISION) / 100;
}

function symbolOf(market, tokensData) {
  return tokensData[market.indexTokenAddress]?.symbol ?? market.indexTokenAddress?.slice(0, 8);
}

function pct(n, digits = 2) {
  return `${n >= 0 ? "" : ""}${n.toFixed(digits)}%`;
}

module.exports = {
  PRECISION,
  SECONDS_PER_YEAR,
  CHAINS,
  makeSdk,
  factorToFloat,
  perSecondToApr,
  usd30ToFloat,
  symbolOf,
  pct,
};

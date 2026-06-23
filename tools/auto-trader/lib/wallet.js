// wallet.js — balance-aware setup. Reads whatever is actually available and
// sizes everything off that. No hardcoded wallet amount anywhere.

const { GmxSdk } = require("@gmx-io/sdk");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum, avalanche } = require("viem/chains");

const CHAINS = {
  arbitrum: {
    chain: arbitrum,
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    oracleUrl: "https://arbitrum-api.gmxinfra.io",
    subsquidUrl: "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql",
  },
  avalanche: {
    chain: avalanche,
    chainId: 43114,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    oracleUrl: "https://avalanche-api.gmxinfra.io",
    subsquidUrl: "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql",
  },
};

// Build an SDK instance. In DRY_RUN we still attach the account (for reads) but
// the sleeves never call write methods.
function makeSdk(cfg) {
  const c = CHAINS[cfg.CHAIN];
  if (!c) throw new Error(`Unsupported CHAIN: ${cfg.CHAIN}`);

  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    // Read-only is fine for paper mode; live mode requires a key.
    if (!cfg.DRY_RUN) throw new Error("PRIVATE_KEY is required for live trading (DRY_RUN=false).");
    return { sdk: new GmxSdk(c), account: null, chainCfg: c };
  }

  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const sdk = new GmxSdk({
    ...c,
    account: account.address,
    walletClient: createWalletClient({ account, chain: c.chain, transport: http(c.rpcUrl) }),
  });
  return { sdk, account, chainCfg: c };
}

const PRECISION = 10n ** 30n;
const usd30 = (v) => (v == null ? 0 : Number((BigInt(v) * 100n) / PRECISION) / 100);

// Snapshot of what the account actually has, right now.
async function readEquity(sdk, account) {
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();

  // Free token balances (the "available to trade" the user asked about).
  let freeUsd = 0;
  let usdc = null;
  try {
    const { balancesData } = await sdk.tokens.getTokensBalances({ account: account?.address });
    for (const [addr, bal] of Object.entries(balancesData || {})) {
      const t = tokensData[addr];
      if (!t || !bal) continue;
      const price = usd30(t.prices?.minPrice);
      const amount = Number(BigInt(bal)) / 10 ** t.decimals;
      freeUsd += amount * price;
      if (t.symbol === "USDC") usdc = { address: addr, balance: BigInt(bal), decimals: t.decimals };
    }
  } catch (_) {
    /* balances unavailable in read-only/no-account mode */
  }

  // Capital already deployed in open perp positions.
  let positionsUsd = 0;
  let positions = [];
  if (account) {
    const info = await sdk.positions.getPositionsInfo({
      marketsInfoData,
      tokensData,
      showPnlInLeverage: false,
    });
    positions = Object.values(info);
    for (const p of positions) positionsUsd += usd30(p.netValue ?? p.collateralUsd);
  }

  // NOTE: GM/GLV LP token value is not summed here yet — querying LP token
  // balances requires the gmx-liquidity contract reads. Treated as a TODO so we
  // never silently over-report equity. See sleeves/lp.js.
  const totalEquity = freeUsd + positionsUsd;

  return { marketsInfoData, tokensData, freeUsd, positionsUsd, totalEquity, usdc, positions };
}

module.exports = { makeSdk, readEquity, usd30, CHAINS };

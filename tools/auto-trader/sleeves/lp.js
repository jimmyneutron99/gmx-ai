// lp.js — the passive liquidity sleeve (GM pools / GLV vaults).
//
// Goal: keep the LP allocation parked in the highest-APR venue, hands-off. GLV
// vaults already auto-rebalance across constituent GM pools, so preferring GLV
// gets most of the "always max APR" behaviour without the bot churning capital
// (and paying entry/exit fees) chasing small APR differences.
//
// ⚠️ Execution status: GM/GLV deposit & withdraw are NOT exposed as @gmx-io/sdk
// convenience methods — they are contract-level operations (see the repo's
// `gmx-liquidity` SKILL for the viem/multicall patterns). This module computes
// the target allocation and the rebalance decision; the actual deposit/withdraw
// calls are intentionally left as a clearly-marked integration point so we never
// pretend to move funds we cannot yet move from the SDK.

const PRECISION = 10n ** 30n;
const usd30 = (v) => (v == null ? 0 : Number((BigInt(v) * 100n) / PRECISION) / 100);

// Estimate a GM pool's fee APR from on-chain data the SDK exposes. This is a
// rough proxy (fees/borrowing scale with utilization & volume); the GMX UI shows
// the authoritative number. Used only to RANK pools, not to promise yield.
function estimatePoolApr(market) {
  const oi = usd30(market.longInterestUsd) + usd30(market.shortInterestUsd);
  const pool = usd30(market.longPoolAmount) + usd30(market.shortPoolAmount);
  if (pool <= 0) return 0;
  const utilization = Math.min(1, oi / pool);
  // Higher utilization → more borrowing fees flow to LPs. Coarse proxy only.
  return utilization * 30; // scaled heuristic %; verify against the UI
}

async function run(ctx) {
  const { sdk, cfg, equity, state, log } = ctx;
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();

  const targetUsd = equity * cfg.ALLOCATION.lp;

  // Rank candidate pools by estimated APR.
  const ranked = Object.values(marketsInfoData)
    .filter((m) => !m.isSpotOnly)
    .map((m) => ({
      market: m.marketTokenAddress,
      symbol: tokensData[m.indexTokenAddress]?.symbol,
      apr: estimatePoolApr(m),
    }))
    .sort((a, b) => b.apr - a.apr);

  const best = ranked[0];
  log(`LP: target allocation ~$${targetUsd.toFixed(2)} (${(cfg.ALLOCATION.lp * 100)}% of equity)`);
  log(`LP: best venue ${cfg.LP.preferGlv ? "(prefer GLV auto-rebalancing) " : ""}${best?.symbol} ~${best?.apr.toFixed(1)}% est. APR`);

  const current = state.lpMarket ? marketsInfoData[state.lpMarket] : null;
  if (current) {
    const currentApr = estimatePoolApr(current);
    const gain = (best?.apr || 0) - currentApr;
    if (gain < cfg.LP.rebalanceThresholdApr) {
      return log(`LP: holding current venue (gain ${gain.toFixed(1)}% < ${cfg.LP.rebalanceThresholdApr}% threshold — churn not worth fees)`);
    }
    log(`LP: better venue by ${gain.toFixed(1)}% APR — rebalance warranted`);
  }

  if (cfg.DRY_RUN) {
    return log("  [dry-run] would deposit/rebalance into the target GM/GLV venue");
  }

  // ── Integration point ──────────────────────────────────────────────────────
  // Real deposit/withdraw goes here using the gmx-liquidity contract patterns
  // (ExchangeRouter.createDeposit / GlvRouter.createGlvDeposit via multicall).
  // Left explicit on purpose — wire it to the gmx-liquidity skill before live LP.
  log("  [live] LP execution not wired — implement via gmx-liquidity contract calls.");
  state.lpMarket = best?.market;
}

module.exports = { run, estimatePoolApr };

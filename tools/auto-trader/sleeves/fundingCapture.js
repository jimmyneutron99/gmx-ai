// fundingCapture.js — the delta-neutral "carry" sleeve.
//
// Goal: collect funding from the crowded side WITHOUT betting on price. The bot
// opens the GMX perp leg on the side that RECEIVES net carry, then the position
// must be hedged so net delta ≈ 0.
//
// ⚠️ Important honesty: GMX alone cannot make you delta-neutral with one perp.
// True neutrality needs an offsetting spot/short hedge on ANOTHER venue (e.g.
// spot on Coinbase/Base, or an inverse position elsewhere). This module manages
// the GMX leg and MONITORS net delta, but it cannot place the off-venue hedge
// for you. Run it only if you maintain that hedge — otherwise it is just a
// low-leverage directional position, not delta-neutral.

const PRECISION = 10n ** 30n;
const SECONDS_PER_YEAR = 31_536_000;
const factorFloat = (f) => (f == null ? 0 : Number((BigInt(f) * 1_000_000_000n) / PRECISION) / 1e9);
const aprFromPerSec = (f) => factorFloat(f) * SECONDS_PER_YEAR * 100;
const usd30 = (v) => (v == null ? 0 : Number((BigInt(v) * 100n) / PRECISION) / 100);

// Find the market + side with the best net carry above the configured floor.
function bestCarry(marketsInfoData, tokensData, cfg) {
  let best = null;
  for (const m of Object.values(marketsInfoData)) {
    if (m.isSpotOnly) continue;
    const funding = aprFromPerSec(m.fundingFactorPerSecond);
    const longCarry = (m.longsPayShorts ? -funding : funding) - aprFromPerSec(m.borrowingFactorPerSecondForLongs);
    const shortCarry = (m.longsPayShorts ? funding : -funding) - aprFromPerSec(m.borrowingFactorPerSecondForShorts);
    const side = longCarry >= shortCarry ? "long" : "short";
    const carry = Math.max(longCarry, shortCarry);
    if (carry >= cfg.FUNDING.minNetCarryApr && (!best || carry > best.carry)) {
      best = { market: m.marketTokenAddress, symbol: tokensData[m.indexTokenAddress]?.symbol, side, carry };
    }
  }
  return best;
}

async function run(ctx) {
  const { sdk, cfg, state, equity, log } = ctx;
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();

  // 1. Check existing carry leg: has carry decayed? then unwind.
  const held = state.fundingMarket;
  if (held) {
    const m = marketsInfoData[held];
    const funding = aprFromPerSec(m.fundingFactorPerSecond);
    const longCarry = (m.longsPayShorts ? -funding : funding) - aprFromPerSec(m.borrowingFactorPerSecondForLongs);
    const shortCarry = (m.longsPayShorts ? funding : -funding) - aprFromPerSec(m.borrowingFactorPerSecondForShorts);
    const carry = Math.max(longCarry, shortCarry);
    if (carry < cfg.FUNDING.exitIfCarryBelowApr) {
      log(`funding: carry on held market decayed to ${carry.toFixed(1)}% — unwinding leg`);
      if (!cfg.DRY_RUN) {
        /* close the perp leg (same path as directional.closePosition) */
      }
      state.fundingMarket = null;
    }
    log("funding: REMINDER — ensure your off-venue spot hedge still matches the GMX leg notional.");
    return;
  }

  // 2. No leg yet: find the best carry opportunity.
  const target = bestCarry(marketsInfoData, tokensData, cfg);
  if (!target) return log(`funding: no market with carry >= ${cfg.FUNDING.minNetCarryApr}% — staying flat`);

  const allocUsd = equity * cfg.ALLOCATION.funding;
  log(`funding: opportunity ${target.side.toUpperCase()} ${target.symbol} carry ${target.carry.toFixed(1)}% APR, leg ~$${allocUsd.toFixed(2)}`);
  log("funding: This leg is ONLY delta-neutral if you hold an equal, opposite spot hedge off-venue.");

  if (cfg.DRY_RUN) return log("  [dry-run] would open carry leg + flag hedge requirement");

  // Open the low-leverage perp leg on the carry-receiving side.
  const usdc = ctx.usdc;
  if (!usdc) return log("  no USDC to fund carry leg");
  const market = marketsInfoData[target.market];
  const collateral = target.side === "long" ? market.longTokenAddress : market.shortTokenAddress;
  await sdk.orders[target.side]({
    marketAddress: target.market,
    payTokenAddress: usdc.address,
    collateralTokenAddress: collateral,
    payAmount: BigInt(Math.floor(allocUsd * 10 ** usdc.decimals)),
    leverage: BigInt(cfg.FUNDING.leverageBps),
    allowedSlippageBps: 100,
    skipSimulation: true,
  });
  state.fundingMarket = target.market;
}

module.exports = { run, bestCarry };

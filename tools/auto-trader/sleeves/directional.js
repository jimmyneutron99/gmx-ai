// directional.js — the leveraged, direction-taking sleeve.
//
// Runs multiple times a day: reassess open trades first (close winners that hit
// target, cut losers that hit stop or whose signal flipped), THEN consider a new
// entry on the best-scoring market — but only if risk + cooldown allow.
//
// Every entry attaches a server-side stop-loss and take-profit so the position
// is protected even if this process dies.

const { scanMarkets } = require("../lib/signals");
const risk = require("../lib/risk");

const PRECISION = 10n ** 30n;
const usd30 = (v) => (v == null ? 0 : Number((BigInt(v) * 100n) / PRECISION) / 100);

// Tag positions belonging to this sleeve via state (GMX positions carry no tag).
function isDirectional(state, marketAddress) {
  return state.directionalMarkets?.includes(marketAddress);
}

async function reassess(ctx) {
  const { sdk, cfg, state, log } = ctx;
  // Always re-fetch fresh oracle data before any close decision.
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  const info = await sdk.positions.getPositionsInfo({
    marketsInfoData, tokensData, showPnlInLeverage: false,
  });

  for (const p of Object.values(info)) {
    if (!isDirectional(state, p.marketAddress)) continue;
    const pnlPct = p.collateralUsd > 0n ? usd30(p.pnl) / usd30(p.collateralUsd) : 0;
    const stop = -cfg.DIRECTIONAL.stopDistancePct;
    const target = cfg.DIRECTIONAL.stopDistancePct * cfg.DIRECTIONAL.takeProfitR;

    let reason = null;
    if (pnlPct <= stop) reason = `stop hit (${(pnlPct * 100).toFixed(1)}%)`;
    else if (pnlPct >= target) reason = `target hit (+${(pnlPct * 100).toFixed(1)}%)`;

    // Re-score the market; if the favored side flipped against us, exit.
    if (!reason) {
      const ranked = await scanMarkets(marketsInfoData, tokensData, ctx.oracleUrl);
      const sig = ranked.find((r) => r.market === p.marketAddress);
      if (sig && ((p.isLong && sig.side === "short") || (!p.isLong && sig.side === "long"))) {
        reason = "signal flipped";
      }
    }

    if (reason) {
      log(`directional: closing ${p.isLong ? "LONG" : "SHORT"} — ${reason}`);
      await closePosition(ctx, marketsInfoData, tokensData, p);
    }
  }
}

async function closePosition(ctx, marketsInfoData, tokensData, position) {
  const { sdk, cfg, log } = ctx;
  if (cfg.DRY_RUN) return log("  [dry-run] would submit decrease order (full close)");

  const { getDecreasePositionAmounts } = require("@gmx-io/sdk/utils/trade");
  const marketInfo = marketsInfoData[position.marketAddress];
  const collateralToken = tokensData[position.collateralTokenAddress];
  const { minCollateralUsd, minPositionSizeUsd } = await sdk.positions.getPositionsConstants();
  const uiFeeFactor = await sdk.utils.getUiFeeFactor();

  const decreaseAmounts = getDecreasePositionAmounts({
    marketInfo, collateralToken, isLong: position.isLong, position,
    closeSizeUsd: position.sizeInUsd, keepLeverage: false,
    userReferralInfo: undefined, minCollateralUsd, minPositionSizeUsd, uiFeeFactor,
    isSetAcceptablePriceImpactEnabled: false,
  });
  await sdk.orders.createDecreaseOrder({
    marketInfo, marketsInfoData, tokensData, isLong: position.isLong,
    allowedSlippage: 300, decreaseAmounts, collateralToken,
  });
}

async function maybeEnter(ctx) {
  const { sdk, cfg, state, equity, log } = ctx;

  const gate = risk.checkGlobal(cfg, state, equity);
  if (!gate.allowed) return log(`directional: skip entry — ${gate.reason}`);

  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  const ranked = await scanMarkets(marketsInfoData, tokensData, ctx.oracleUrl);
  const top = ranked[0];
  if (!top || top.score < cfg.DIRECTIONAL.minSignalScore) {
    return log(`directional: no signal >= ${cfg.DIRECTIONAL.minSignalScore} (best ${top?.score.toFixed(2)})`);
  }

  // Don't stack a second directional trade on a market we already hold.
  if (isDirectional(state, top.market)) return log("directional: already in top market");
  const cd = risk.checkDirectionalEntry(cfg, state, top.market);
  if (!cd.allowed) return log(`directional: ${cd.reason} (${top.symbol})`);

  const notionalUsd = risk.positionNotionalUsd(cfg, state, equity);
  const allocCap = equity * cfg.ALLOCATION.directional;
  const leverage = BigInt(cfg.DIRECTIONAL.maxLeverageBps);
  // payAmount = notional / leverage, capped by the sleeve's allocation.
  const payUsd = Math.min(notionalUsd / (Number(leverage) / 10000), allocCap);

  log(`directional: ENTER ${top.side.toUpperCase()} ${top.symbol} ~$${payUsd.toFixed(2)} @ ${cfg.DIRECTIONAL.maxLeverageBps / 10000}x (score ${top.score.toFixed(2)})`);
  log(`  parts: momentum ${top.parts.momentumScore.toFixed(2)} carry ${top.parts.carryScore.toFixed(2)} cost ${top.parts.costScore.toFixed(2)}`);

  if (cfg.DRY_RUN) return log("  [dry-run] would open with SL/TP sidecars");

  const usdc = ctx.usdc;
  if (!usdc) return log("  no USDC balance to fund entry");
  const payAmount = BigInt(Math.floor(payUsd * 10 ** usdc.decimals));
  const market = marketsInfoData[top.market];
  const collateral = top.side === "long" ? market.longTokenAddress : market.shortTokenAddress;

  await sdk.orders[top.side]({
    marketAddress: top.market,
    payTokenAddress: usdc.address,
    collateralTokenAddress: collateral,
    payAmount,
    leverage,
    allowedSlippageBps: 100,
    skipSimulation: true,
    // Attach stop-loss + take-profit as sidecar orders (survive process death).
    createSltpEntries: buildSltp(ctx, market, tokensData, top.side),
  });

  state.directionalMarkets = [...(state.directionalMarkets || []), top.market];
  state.lastEntryByMarket[top.market] = Date.now();
}

// Build stop-loss + take-profit trigger prices relative to current mark.
function buildSltp(ctx, market, tokensData, side) {
  const { cfg } = ctx;
  const mark = usd30(tokensData[market.indexTokenAddress]?.prices?.minPrice);
  const stopDist = cfg.DIRECTIONAL.stopDistancePct;
  const tpDist = stopDist * cfg.DIRECTIONAL.takeProfitR;
  const sl = side === "long" ? mark * (1 - stopDist) : mark * (1 + stopDist);
  const tp = side === "long" ? mark * (1 + tpDist) : mark * (1 - tpDist);
  // Returned as plain numbers; map to the SDK's SLTP entry shape (30-dec prices)
  // at the call site per the installed @gmx-io/sdk version.
  return { stopLossPrice: sl, takeProfitPrice: tp };
}

module.exports = { reassess, maybeEnter };

// liquidation-guard.js
//
// Two modes:
//
// 1) AUDIT open positions — reports each position's liquidation price, distance
//    to liquidation, and a suggested stop-loss that exits BEFORE the protocol
//    liquidates you (a liquidation forfeits remaining collateral + fees; a
//    stop-loss you place exits on your terms).
//
//      node tools/liquidation-guard.js audit <ACCOUNT> [chain]
//
// 2) ESTIMATE a hypothetical — given entry price, leverage and direction, shows
//    the approximate liquidation move so you can size leverage sanely before
//    opening.
//
//      node tools/liquidation-guard.js estimate <entryPrice> <leverage> <long|short>
//      e.g. node tools/liquidation-guard.js estimate 3000 5 long
//
// Read-only. The audit mode uses the SDK's own liquidationPrice; estimate mode
// is a simplified approximation (ignores fees/funding accrual) for sizing intuition.

const { makeSdk, usd30ToFloat } = require("./shared");

// Fraction of the price move (relative to entry) that wipes the margin.
// Approx: a position is liquidated after losing ~ (1/leverage) minus a
// maintenance-margin buffer. We use a conservative buffer so the suggested
// stop sits safely inside the real liquidation price.
const MAINTENANCE_BUFFER = 0.0075; // ~0.75% maintenance margin (approx; varies by market)
const STOP_SAFETY = 0.8;           // place stop at 80% of the distance to liquidation

function estimate(entry, leverage, isLong) {
  // Liquidation move fraction ≈ 1/leverage - maintenance buffer.
  const liqMoveFrac = Math.max(0, 1 / leverage - MAINTENANCE_BUFFER);
  const liqPrice = isLong ? entry * (1 - liqMoveFrac) : entry * (1 + liqMoveFrac);
  const stopFrac = liqMoveFrac * STOP_SAFETY;
  const stopPrice = isLong ? entry * (1 - stopFrac) : entry * (1 + stopFrac);

  console.log(`\nLiquidation estimate — ${isLong ? "LONG" : "SHORT"} @ ${entry}, ${leverage}x\n`);
  console.log(`  Approx liquidation price : ${liqPrice.toFixed(4)}  (${(liqMoveFrac * 100).toFixed(2)}% move against you)`);
  console.log(`  Suggested stop-loss      : ${stopPrice.toFixed(4)}  (${(stopFrac * 100).toFixed(2)}% move)`);
  console.log(
    "\n  Note: approximation only (ignores accrued fees/funding, which move the real\n" +
      "  liquidation closer). Lower leverage = wider buffer. Always place the stop as a\n" +
      "  server-side sidecar order so it survives a bot/connection failure.\n",
  );
}

async function audit(account, chain) {
  const sdk = makeSdk(chain);
  sdk.setAccount(account); // analytics for an arbitrary address
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  const positions = await sdk.positions.getPositionsInfo({
    marketsInfoData,
    tokensData,
    showPnlInLeverage: false,
  });

  const list = Object.values(positions);
  if (list.length === 0) {
    console.log(`\nNo open positions for ${account} on ${chain}.\n`);
    return;
  }

  console.log(`\nLiquidation audit — ${account} on ${chain}\n`);
  for (const p of list) {
    const sym = tokensData[marketsInfoData[p.marketAddress]?.indexTokenAddress]?.symbol ?? "?";
    const mark = usd30ToFloat(p.markPrice);
    const liq = usd30ToFloat(p.liquidationPrice);
    const distPct = mark > 0 && liq > 0 ? Math.abs((mark - liq) / mark) * 100 : null;

    // Suggested stop inside the liquidation price.
    const stop = p.isLong
      ? mark - (mark - liq) * STOP_SAFETY
      : mark + (liq - mark) * STOP_SAFETY;

    console.log(`  ${sym} ${p.isLong ? "LONG" : "SHORT"}`);
    console.log(`    mark ${mark.toFixed(4)}  liq ${liq.toFixed(4)}  ` +
      (distPct != null ? `(${distPct.toFixed(2)}% away)` : ""));
    console.log(`    suggested stop-loss: ${stop.toFixed(4)}`);
    console.log(`    pending funding $${usd30ToFloat(p.pendingFundingFeesUsd).toFixed(2)}  ` +
      `borrowing $${usd30ToFloat(p.pendingBorrowingFeesUsd).toFixed(2)} (these push liq closer)`);
    if (distPct != null && distPct < 5) console.log("    ⚠️  within 5% of liquidation");
    console.log("");
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "estimate") {
    const entry = Number(process.argv[3]);
    const lev = Number(process.argv[4]);
    const dir = (process.argv[5] || "long").toLowerCase();
    if (!entry || !lev) {
      console.error("Usage: node tools/liquidation-guard.js estimate <entryPrice> <leverage> <long|short>");
      process.exit(1);
    }
    estimate(entry, lev, dir === "long");
  } else if (mode === "audit") {
    const account = process.argv[3];
    const chain = process.argv[4] || "arbitrum";
    if (!account) {
      console.error("Usage: node tools/liquidation-guard.js audit <ACCOUNT> [chain]");
      process.exit(1);
    }
    await audit(account, chain);
  } else {
    console.error("Usage:\n  node tools/liquidation-guard.js estimate <entryPrice> <leverage> <long|short>\n  node tools/liquidation-guard.js audit <ACCOUNT> [chain]");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});

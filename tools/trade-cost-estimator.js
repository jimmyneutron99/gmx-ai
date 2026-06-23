// trade-cost-estimator.js
//
// "Will this trade survive its own costs?" Estimates the all-in cost of opening,
// holding, and closing a position so you know the price move you need just to
// break even.
//
//   node tools/trade-cost-estimator.js <SYMBOL> <sizeUsd> <long|short> <holdHours> [chain]
//   e.g. node tools/trade-cost-estimator.js ETH 10000 long 48
//
// Combines:
//   • open + close position fee (balancing vs imbalancing, based on current OI skew)
//   • borrowing cost over the holding period
//   • funding cost/credit over the holding period
// Read-only. Approximation using current rates (rates change over time).

const { makeSdk, factorToFloat, perSecondToApr, usd30ToFloat, symbolOf } = require("./shared");

async function main() {
  const symbol = (process.argv[2] || "ETH").toUpperCase();
  const sizeUsd = Number(process.argv[3] || 10000);
  const isLong = (process.argv[4] || "long").toLowerCase() === "long";
  const holdHours = Number(process.argv[5] || 24);
  const chain = process.argv[6] || "arbitrum";

  const sdk = makeSdk(chain);
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  const market = Object.values(marketsInfoData).find(
    (m) =>
      !m.isSpotOnly &&
      [symbol, "W" + symbol].includes(tokensData[m.indexTokenAddress]?.symbol?.toUpperCase()),
  );
  if (!market) {
    console.error(`No perp market for ${symbol} on ${chain}.`);
    process.exit(1);
  }

  const oiLong = usd30ToFloat(market.longInterestUsd);
  const oiShort = usd30ToFloat(market.shortInterestUsd);
  // Does opening this side balance the book?
  const balances = isLong ? oiLong < oiShort : oiShort < oiLong;
  const feeFactor = balances
    ? factorToFloat(market.positionFeeFactorForPositiveImpact)
    : factorToFloat(market.positionFeeFactorForNegativeImpact);

  const openFee = sizeUsd * feeFactor;
  const closeFee = sizeUsd * feeFactor; // assume similar regime on exit
  const roundTripFee = openFee + closeFee;

  const borrowApr = perSecondToApr(
    isLong ? market.borrowingFactorPerSecondForLongs : market.borrowingFactorPerSecondForShorts,
  );
  const fundingApr = perSecondToApr(market.fundingFactorPerSecond);
  const longsPay = market.longsPayShorts;
  const fundingSignedApr = isLong ? (longsPay ? -fundingApr : fundingApr) : longsPay ? fundingApr : -fundingApr;

  const holdFrac = holdHours / (365 * 24);
  const borrowCost = sizeUsd * (borrowApr / 100) * holdFrac; // always a cost
  const fundingCost = sizeUsd * (fundingSignedApr / 100) * holdFrac; // signed: + = credit

  const totalCost = roundTripFee + borrowCost - fundingCost; // fundingCost positive = credit
  const breakevenPct = (totalCost / sizeUsd) * 100;

  console.log(`\nTrade cost — ${symbolOf(market, tokensData)} ${isLong ? "LONG" : "SHORT"} ` +
    `$${sizeUsd.toLocaleString()} held ${holdHours}h (${chain})\n`);
  console.log(`  Position fee (${balances ? "balancing" : "imbalancing"}): ${(feeFactor * 100).toFixed(3)}% each side`);
  console.log(`  Open + close fee     : $${roundTripFee.toFixed(2)}`);
  console.log(`  Borrowing (${borrowApr.toFixed(1)}% APR) : $${borrowCost.toFixed(2)}`);
  console.log(`  Funding (${fundingSignedApr >= 0 ? "+" : ""}${fundingSignedApr.toFixed(1)}% APR) : ` +
    `${fundingCost >= 0 ? "-$" + fundingCost.toFixed(2) + " (credit)" : "+$" + Math.abs(fundingCost).toFixed(2) + " (cost)"}`);
  console.log(`  ───────────────────────────────`);
  console.log(`  Total cost           : $${totalCost.toFixed(2)}`);
  console.log(`  Breakeven move       : ${breakevenPct.toFixed(3)}%  ` +
    `(price must move ${breakevenPct >= 0 ? "+" : ""}${breakevenPct.toFixed(3)}% in your favor to net zero)\n`);
  console.log("  Rates are current snapshots and drift over time; longer holds amplify carry.\n");
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});

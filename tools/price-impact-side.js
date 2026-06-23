// price-impact-side.js
//
// Tells you which side of a market is the CHEAP side to trade right now.
//
// GMX charges a lower position fee and gives favorable (or zero) price impact
// when your trade *balances* open interest, and a higher fee + adverse impact
// when it *imbalances* it. Same trade, different cost depending on direction
// and current skew. This tool reports the OI skew and which side is balancing.
//
//   node tools/price-impact-side.js <SYMBOL> [arbitrum|avalanche|botanix]
//   e.g. node tools/price-impact-side.js ETH
//
// Read-only. This estimates the *fee/impact regime*, not the exact impact in
// USD (exact impact needs the market's impact-pool factors from the reader
// contract). Use it to pick the cheaper side, not as a precise quote.

const { makeSdk, factorToFloat, usd30ToFloat, symbolOf } = require("./shared");

async function main() {
  const symbol = (process.argv[2] || "ETH").toUpperCase();
  const chain = process.argv[3] || "arbitrum";
  const sdk = makeSdk(chain);
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();

  // Perp markets use the wrapped symbol as index (e.g. WETH). Match either.
  const market = Object.values(marketsInfoData).find(
    (m) =>
      !m.isSpotOnly &&
      [symbol, "W" + symbol].includes(tokensData[m.indexTokenAddress]?.symbol?.toUpperCase()),
  );
  if (!market) {
    console.error(`No perp market found for ${symbol} on ${chain}.`);
    process.exit(1);
  }

  const oiLong = usd30ToFloat(market.longInterestUsd);
  const oiShort = usd30ToFloat(market.shortInterestUsd);
  const total = oiLong + oiShort;
  const skew = total > 0 ? ((oiLong - oiShort) / total) * 100 : 0;

  // The side that REDUCES the imbalance is the balancing (cheap) side.
  // If longs > shorts, opening a SHORT (or closing a long) balances.
  const balancingSide = oiLong > oiShort ? "SHORT" : oiLong < oiShort ? "LONG" : "EITHER";

  const feePos = factorToFloat(market.positionFeeFactorForPositiveImpact) * 100; // balancing
  const feeNeg = factorToFloat(market.positionFeeFactorForNegativeImpact) * 100; // imbalancing

  console.log(`\n${symbolOf(market, tokensData)} / USD — ${chain}\n`);
  console.log(`  Open interest   long  $${oiLong.toLocaleString()}`);
  console.log(`                  short $${oiShort.toLocaleString()}`);
  console.log(`  OI skew         ${skew >= 0 ? "+" : ""}${skew.toFixed(1)}% (${
    skew >= 0 ? "long-heavy" : "short-heavy"
  })`);
  console.log("");
  console.log(`  Cheap (balancing) side : ${balancingSide}`);
  console.log(`    → position fee ${feePos.toFixed(3)}% + favorable/zero price impact`);
  console.log(`  Expensive (imbalancing) side : ${balancingSide === "LONG" ? "SHORT" : "LONG"}`);
  console.log(`    → position fee ${feeNeg.toFixed(3)}% + adverse price impact`);
  console.log(
    "\n  Tip: if your directional thesis matches the balancing side, you get paid to take it.\n" +
      "  If it matches the imbalancing side, size smaller or split the order to limit impact.\n",
  );
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});

// funding-borrow-scanner.js
//
// Ranks GMX markets by their CARRY — the funding + borrowing cost/credit you
// pay or receive just for holding a position, independent of price direction.
//
// Why this matters: borrowing runs ~45-55% APR at high utilization and funding
// can be several % APR. On a held position these dwarf the 0.04-0.06% open/close
// fee. This tool shows which side (long/short) is *paid* funding and what each
// side's net carry is, so you don't bleed out holding the expensive side.
//
// This is the data behind a funding-capture / delta-neutral strategy: find a
// market where one side receives net positive carry, then hedge the directional
// risk elsewhere so the carry is the edge. (Carry can flip; monitor continuously.)
//
//   node tools/funding-borrow-scanner.js [arbitrum|avalanche|botanix]
//
// Read-only. No wallet, no profit guarantee.

const { makeSdk, perSecondToApr, usd30ToFloat, symbolOf, pct } = require("./shared");

async function main() {
  const chain = process.argv[2] || "arbitrum";
  const sdk = makeSdk(chain);
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();

  const rows = [];
  for (const m of Object.values(marketsInfoData)) {
    if (m.isSpotOnly) continue;

    const longBorrowApr = perSecondToApr(m.borrowingFactorPerSecondForLongs);   // longs always PAY
    const shortBorrowApr = perSecondToApr(m.borrowingFactorPerSecondForShorts); // shorts always PAY
    const fundingApr = perSecondToApr(m.fundingFactorPerSecond);                // magnitude only
    const longsPay = m.longsPayShorts; // true => longs pay funding to shorts

    // Funding is a transfer: the paying side has a negative funding component,
    // the receiving side positive. Borrowing is always a cost (negative).
    const longFunding = longsPay ? -fundingApr : +fundingApr;
    const shortFunding = longsPay ? +fundingApr : -fundingApr;

    // Net carry APR for holding each side (positive = you receive, negative = you pay).
    const longCarry = longFunding - longBorrowApr;
    const shortCarry = shortFunding - shortBorrowApr;

    const oiLong = usd30ToFloat(m.longInterestUsd);
    const oiShort = usd30ToFloat(m.shortInterestUsd);

    rows.push({
      market: symbolOf(m, tokensData),
      longCarry,
      shortCarry,
      bestSide: longCarry >= shortCarry ? "LONG" : "SHORT",
      bestCarry: Math.max(longCarry, shortCarry),
      fundingApr,
      longsPay,
      oiSkew: oiLong + oiShort > 0 ? ((oiLong - oiShort) / (oiLong + oiShort)) * 100 : 0,
    });
  }

  rows.sort((a, b) => b.bestCarry - a.bestCarry);

  console.log(`\nGMX carry scan — ${chain} (annualized, holding cost/credit)\n`);
  console.log(
    "MARKET".padEnd(12),
    "LONG carry".padStart(12),
    "SHORT carry".padStart(12),
    "BEST".padStart(7),
    "funding".padStart(9),
    "OI skew".padStart(9),
  );
  for (const r of rows) {
    console.log(
      r.market.padEnd(12),
      pct(r.longCarry).padStart(12),
      pct(r.shortCarry).padStart(12),
      r.bestSide.padStart(7),
      pct(r.fundingApr).padStart(9),
      `${r.oiSkew >= 0 ? "+" : ""}${r.oiSkew.toFixed(0)}%`.padStart(9),
    );
  }

  console.log(
    "\nNotes:\n" +
      "  • carry > 0 = you are PAID to hold that side; < 0 = it costs you.\n" +
      "  • 'OI skew' positive = more longs than shorts. Funding generally pays the smaller side.\n" +
      "  • Carry is not free money: it can flip, and directional PnL usually dominates. A\n" +
      "    funding-capture trade only isolates carry if you hedge the price exposure elsewhere.\n",
  );
}

main().catch((e) => {
  console.error("Scan failed:", e.message);
  process.exit(1);
});

// signals.js — scans every perp market and ranks them by a composite HEURISTIC
// score in [0,1].
//
// ⚠️ Honest naming: this score is NOT a probability of profit. No data source
// can give that. It blends three *measurable* edges the conversation identified:
//   1. Carry      — is the favored side paid funding net of borrowing?
//   2. Momentum   — is price trending (EMA fast vs slow) on the favored side?
//   3. Cost/side  — does the favored direction also balance OI (cheaper fees)?
// A high score means "structurally favorable right now," not "will win."

const PRECISION = 10n ** 30n;
const SECONDS_PER_YEAR = 31_536_000;
const factorFloat = (f) => (f == null ? 0 : Number((BigInt(f) * 1_000_000_000n) / PRECISION) / 1e9);
const aprFromPerSec = (f) => factorFloat(f) * SECONDS_PER_YEAR * 100;
const usd30 = (v) => (v == null ? 0 : Number((BigInt(v) * 100n) / PRECISION) / 100);

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Pull OHLC candles from the oracle REST API (no key needed).
async function fetchCandles(oracleUrl, symbol, period = "1h", limit = 60) {
  // Strip a leading W (WETH -> ETH) for the candle endpoint's tokenSymbol.
  const sym = symbol.replace(/^W(ETH|BTC|AVAX)$/, "$1");
  const url = `${oracleUrl}/prices/candles?tokenSymbol=${sym}&period=${period}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const rows = json.candles || json;
  // Each candle: [time, open, high, low, close] (oracle format).
  return rows.map((c) => ({ close: Number(Array.isArray(c) ? c[4] : c.close) }));
}

// Score one market. Returns { market, symbol, side, score, parts } or null.
async function scoreMarket(market, tokensData, oracleUrl) {
  const symbol = tokensData[market.indexTokenAddress]?.symbol;
  if (!symbol) return null;

  // ── Carry: which side is paid, and how much (net of borrowing)? ──
  const longBorrow = aprFromPerSec(market.borrowingFactorPerSecondForLongs);
  const shortBorrow = aprFromPerSec(market.borrowingFactorPerSecondForShorts);
  const funding = aprFromPerSec(market.fundingFactorPerSecond);
  const longsPay = market.longsPayShorts;
  const longCarry = (longsPay ? -funding : funding) - longBorrow;
  const shortCarry = (longsPay ? funding : -funding) - shortBorrow;

  // ── Momentum: EMA(12) vs EMA(36) on 1h closes ──
  const candles = await fetchCandles(oracleUrl, symbol).catch(() => null);
  let momentumSide = null;
  let momentumStrength = 0;
  if (candles && candles.length >= 36) {
    const closes = candles.map((c) => c.close);
    const fast = ema(closes.slice(-24), 12);
    const slow = ema(closes.slice(-36), 36);
    momentumSide = fast > slow ? "long" : "short";
    momentumStrength = Math.min(1, Math.abs(fast - slow) / slow / 0.02); // 2% gap = full
  }

  // ── Cost/side: which direction balances OI (cheaper fee + favorable impact)? ──
  const oiLong = usd30(market.longInterestUsd);
  const oiShort = usd30(market.shortInterestUsd);
  const cheapSide = oiLong > oiShort ? "short" : "long";

  // Pick the side momentum favors; fall back to the better-carry side.
  const side = momentumSide || (longCarry >= shortCarry ? "long" : "short");
  const sideCarry = side === "long" ? longCarry : shortCarry;

  // ── Composite score (each part in [0,1], weighted) ──
  const carryScore = Math.max(0, Math.min(1, sideCarry / 10)); // +10% APR carry = full
  const momentumScore = momentumSide === side ? momentumStrength : 0;
  const costScore = cheapSide === side ? 1 : 0.4; // bonus if our side is also the cheap side

  const score = 0.4 * momentumScore + 0.35 * carryScore + 0.25 * costScore;

  return {
    market: market.marketTokenAddress,
    symbol,
    side,
    score,
    parts: { momentumScore, carryScore, costScore, sideCarry, cheapSide },
  };
}

// Rank all non-spot markets. Returns sorted desc by score.
async function scanMarkets(marketsInfoData, tokensData, oracleUrl) {
  const results = [];
  for (const m of Object.values(marketsInfoData)) {
    if (m.isSpotOnly) continue;
    const r = await scoreMarket(m, tokensData, oracleUrl).catch(() => null);
    if (r) results.push(r);
  }
  return results.sort((a, b) => b.score - a.score);
}

module.exports = { scanMarkets, scoreMarket, ema, fetchCandles };

# Automated Trading & Strategies

Patterns for running **systematic, rules-based trading** on GMX V2 unattended — including
funding and triggering trades from a **Base wallet** via GMX Account (multichain), and a
library of well-known strategies wrapped in mandatory risk controls.

> ## ⚠️ Read this first — no strategy guarantees profit
>
> Nobody can "ensure" trades are profitable. Leveraged perpetuals can lose **more than your
> margin**, and a position can be **fully liquidated** by a brief price spike. The strategies
> below are *documented, commonly-used* approaches — they are hypotheses, not guarantees. Any
> edge depends on market regime, fees, funding, slippage, and execution latency, all of which
> change over time.
>
> Treat this as an engineering framework for **risk-managed automation**, not a money printer:
> - **Backtest** on historical candles and **paper-trade** before risking real funds.
> - Only deploy capital you can afford to lose entirely.
> - Always run the [risk-management layer](#risk-management-the-non-negotiable-layer) — it is
>   what keeps an automated system survivable, far more than the entry signal.
> - Start with the smallest size and lowest leverage, and scale only after live results match
>   expectations.

---

## Architecture: the strategy loop

Every automated strategy is the same skeleton: gather data → compute a signal → run it through
risk checks → place/adjust orders → repeat. The signal logic is interchangeable; the risk
layer and execution layer stay constant.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  1. Data     │──▶│  2. Signal   │──▶│  3. Risk     │──▶│  4. Execute  │
│  prices,     │   │  strategy    │   │  sizing,     │   │  open/close, │
│  candles,    │   │  rule →      │   │  SL/TP,      │   │  sidecar     │
│  positions,  │   │  long/short/ │   │  drawdown    │   │  SL/TP,      │
│  funding     │   │  flat        │   │  kill-switch │   │  retries     │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
        ▲                                                        │
        └────────────────────────  loop (e.g. every 1–15m)  ─────┘
```

```typescript
async function runStrategyOnce(sdk, cfg) {
  // 1. DATA — always re-fetch; oracle prices go stale within seconds
  const { marketsInfoData, tokensData } = await sdk.markets.getMarketsInfo();
  const positionsInfo = await sdk.positions.getPositionsInfo({
    marketsInfoData, tokensData, showPnlInLeverage: false,
  });
  const candles = await fetchCandles(cfg.chain, cfg.symbol, cfg.period); // see REST API ref

  // 2. SIGNAL — pure function: data in, intent out ("long" | "short" | "flat")
  const intent = cfg.strategy(candles, positionsInfo, marketsInfoData, tokensData);

  // 3. RISK — gate every intent through the risk layer (may downgrade to "flat")
  const decision = applyRiskControls(intent, positionsInfo, cfg, state);
  if (!decision.allowed) return;

  // 4. EXECUTE — open/close with stop-loss + take-profit attached
  await execute(sdk, decision, marketsInfoData, tokensData, cfg);
}

// Drive the loop on an interval. Keep it idempotent: a missed/duplicate tick must not
// double a position. Reconcile against on-chain state every tick, not local memory.
setInterval(() => runStrategyOnce(sdk, cfg).catch(logError), cfg.intervalMs);
```

**Idempotency is critical for unattended bots.** Decide actions from *on-chain position state*
each tick, not from what you think you did last tick. If the process restarts, it should resume
correctly by reading positions and open orders, not from local variables.

---

## Trading from a Base wallet (GMX Account / multichain)

GMX V2 perp markets settle on **Arbitrum, Avalanche, and Botanix** — there is no perp DEX
deployment on Base itself. To trade "from Base", GMX uses **GMX Account** (multichain): you
deposit funds from a **Base wallet**, they bridge via LayerZero/Stargate into a `MultichainVault`
on the settlement chain, and orders are routed through the `MultichainOrderRouter`. Your Base
wallet remains the signer/owner.

**Flow:**

1. **Fund from Base.** From your Base wallet, deposit a supported token (e.g. USDC) into GMX
   Account. The `LayerZeroProvider` + `MultichainVault` credit your GMX Account balance on the
   destination chain (Arbitrum recommended for deepest liquidity).
2. **Trade on the settlement chain.** Orders execute against Arbitrum/Avalanche markets, paid
   from your GMX Account balance via `MultichainOrderRouter`. No manual bridging per trade.
3. **Withdraw back to Base** when done — funds bridge back to your Base wallet address.

**Addresses** (per chain) are in [contract-addresses.md](contract-addresses.md) under
*Multichain (GMX Account)*: `MultichainOrderRouter`, `MultichainVault`, `LayerZeroProvider`.

> **SDK status:** As of this writing the cross-chain deposit/withdraw and `MultichainOrderRouter`
> flows are driven by the GMX frontend (Express relay) and are **not yet exposed as `@gmx-io/sdk`
> convenience methods**. Two practical options for a Base-funded bot:
>
> - **Recommended:** Pre-fund once from Base into GMX Account / your Arbitrum trading address via
>   the GMX app, then run the automation against Arbitrum using the standard SDK flow below. The
>   capital originates from your Base wallet; the bot trades on Arbitrum.
> - **Contract-level:** Interact with `MultichainOrderRouter` / `LayerZeroProvider` directly with
>   `viem` using the ABIs from
>   [gmx-interface](https://github.com/gmx-io/gmx-interface). This is advanced and unverified by
>   SDK helpers — test on small amounts first.
>
> Verify current multichain support in the SDK before relying on programmatic bridging.

The signer for either path is the Base account:

```typescript
const { privateKeyToAccount } = require("viem/accounts");
const { base } = require("viem/chains");
// Private key ONLY from an env var / secret manager — never hardcode. See Operational safety.
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
```

---

## Risk management: the non-negotiable layer

This is the part that determines whether an automated account survives. Apply **every** rule on
**every** tick, regardless of how confident the signal is.

```typescript
function applyRiskControls(intent, positionsInfo, cfg, state) {
  const block = (reason) => ({ allowed: false, reason });

  // 1. Drawdown kill-switch — stop trading after losing X% of starting equity.
  const equity = currentEquityUsd(positionsInfo, cfg);
  const drawdown = (state.peakEquity - equity) / state.peakEquity;
  if (drawdown >= cfg.maxDrawdownPct) return block("max drawdown hit — halt & alert");
  state.peakEquity = Math.max(state.peakEquity, equity);

  // 2. Daily loss limit — cap realized+unrealized loss per UTC day, then stand down.
  if (state.dayPnlUsd <= -cfg.maxDailyLossUsd) return block("daily loss limit");

  // 3. Leverage cap — never exceed a conservative ceiling (e.g. 2–5x), well under 100x max.
  if (cfg.leverageBps > cfg.maxLeverageBps) return block("leverage above cap");

  // 4. Position cap — bound notional per market and total open exposure.
  if (openNotionalUsd(positionsInfo) >= cfg.maxTotalNotionalUsd) return block("exposure cap");

  // 5. Cooldown — avoid flip-flopping/overtrading; respect a min interval between entries.
  if (Date.now() - state.lastEntryTs < cfg.cooldownMs) return block("cooldown");

  return { allowed: true, intent, sizeUsd: positionSizeUsd(equity, cfg) };
}
```

**Position sizing — risk a fixed fraction, not a fixed size.** Size so that hitting your
stop-loss costs a small, constant % of equity (commonly 0.5–2%). This caps the damage of any
single losing trade and is the single most important survival rule.

```typescript
// Risk `riskPerTradePct` of equity if price moves `stopDistancePct` against you.
// notional = (equity * riskPerTradePct) / stopDistancePct
function positionSizeUsd(equity, cfg) {
  return (equity * cfg.riskPerTradePct) / cfg.stopDistancePct;
}
```

**Always attach a stop-loss and take-profit.** On GMX, attach them as **sidecar orders** when you
open the position so they exist even if your bot goes offline. Use `createSltpEntries` in
`createIncreaseOrder()` (see [order-types.md](order-types.md) → *Sidecar orders*), or place a
`StopLossDecrease` + `LimitDecrease` immediately after entry. A bot without a server-side stop is
one crash away from a liquidation.

| Control | Typical setting | Why |
|---------|-----------------|-----|
| Risk per trade | 0.5–2% of equity | Survive losing streaks |
| Max leverage | 2–5x | Liquidation buffer; GMX allows up to 100x but that is fragile |
| Stop-loss | Every position, server-side (sidecar) | Bounded loss if offline |
| Max drawdown kill-switch | 15–25% of peak equity | Stop a broken strategy bleeding out |
| Daily loss limit | Fixed USD/day | Contain bad regimes |
| Cooldown | Strategy-dependent | Prevent overtrading & fee churn |

---

## Documented strategies

Each is a standard, publicly-known systematic approach. They are starting points to **backtest**,
not guarantees. Fees (0.04–0.06% per side), funding, and borrowing (≈45–55% APR at high
utilization) materially erode high-frequency edges on GMX — favor lower-frequency signals.

### 1. Trend-following — moving-average crossover

Go long when a fast EMA crosses above a slow EMA, short on the reverse; flat otherwise. Classic,
robust in trending regimes, whipsaws (loses) in choppy/ranging markets.

```typescript
function maCrossover(candles, cfg = { fast: 20, slow: 50 }) {
  const closes = candles.map((c) => Number(c.close));
  const fast = ema(closes, cfg.fast);
  const slow = ema(closes, cfg.slow);
  const f = fast.at(-1), s = slow.at(-1);
  if (f > s) return "long";
  if (f < s) return "short";
  return "flat";
}
```

### 2. Momentum / breakout

Enter in the direction of a breakout beyond an N-period high/low. Pairs naturally with GMX
`StopIncrease` orders (open only once price confirms the breakout). Catches strong moves; prone
to false breakouts — a stop-loss is essential.

```typescript
function breakout(candles, cfg = { lookback: 24 }) {
  const window = candles.slice(-cfg.lookback - 1, -1);
  const hi = Math.max(...window.map((c) => Number(c.high)));
  const lo = Math.min(...window.map((c) => Number(c.low)));
  const last = Number(candles.at(-1).close);
  if (last > hi) return "long";
  if (last < lo) return "short";
  return "flat";
}
```

### 3. Mean reversion — RSI

Fade extremes: long when RSI is oversold, short when overbought. Works in ranges, **dangerous in
strong trends** (you fight the move) — gate it with a trend filter and tight stops.

```typescript
function rsiReversion(candles, cfg = { period: 14, low: 30, high: 70 }) {
  const r = rsi(candles.map((c) => Number(c.close)), cfg.period).at(-1);
  if (r < cfg.low) return "long";
  if (r > cfg.high) return "short";
  return "flat";
}
```

### 4. Dollar-cost averaging (DCA) / scheduled

Lowest-complexity, lowest-leverage approach: add a fixed notional on a fixed schedule (e.g.
weekly), optionally only when price is below a long-term MA. Best expressed as low/no-leverage
spot-like exposure. Removes timing risk; does not protect against sustained downtrends.

### 5. Funding-rate aware / delta-neutral

GMX funding flows from the larger open-interest side to the smaller. A delta-neutral structure
(e.g. long perp hedged against spot/another venue, or balancing OI sides) aims to **collect
funding** rather than bet on direction. Lower directional risk, but introduces basis risk,
execution/leg risk, and only pays while funding stays favorable — monitor `marketsInfoData`
funding fields continuously.

> Indicator helpers (`ema`, `rsi`, etc.) are standard TA math — implement them or use a library
> like `technicalindicators`. The skill does not ship them.

---

## Companion analytics tools

The repo ships read-only CLI tools in [`tools/`](../../../tools/) that surface the cost and risk
mechanics these strategies trade against — use them to trade cost-efficiently and avoid
liquidation (they report costs, not price predictions):

| Tool | Answers |
|------|---------|
| `funding-borrow-scanner.js` | Which market/side pays you to hold (net carry)? Basis for funding capture. |
| `price-impact-side.js` | Which side is cheap to trade now (balances open interest)? |
| `trade-cost-estimator.js` | All-in cost of a trade and the breakeven move it needs. |
| `liquidation-guard.js` | Liquidation price + a stop-loss that exits before the protocol does. |

> **On "collecting liquidation fees":** GMX V2 liquidations are run by a permissioned keeper
> network with signed oracle prices — there is no public `liquidate()` bounty to capture. The
> proceeds of liquidations go to **GM pool LPs**, not to whoever triggers them. To earn from
> traders' fees and liquidations, provide liquidity (see the `gmx-liquidity` skill), not by
> running a keeper.

---

## Before going live

1. **Backtest** the signal on historical candles (`/prices/candles`, see
   [api-endpoints.md](api-endpoints.md)) including realistic fees, funding, and slippage.
2. **Paper-trade**: run the full loop computing intended orders but skip execution; log what it
   *would* have done and compare to reality for days/weeks.
3. **Canary live**: deploy with the **minimum** size and lowest leverage. Verify SL/TP sidecars
   actually fire and that the kill-switch halts trading.
4. **Scale gradually**, only while live performance matches the backtest.

---

## Operational safety

- **Secrets:** Load `PRIVATE_KEY` from an env var or secret manager — never hardcode, never log,
  never commit. Consider a **dedicated wallet** holding only trading capital, and a **GMX
  subaccount** (see SKILL.md → *Subaccounts*) so the bot signs with a delegated key that can be
  revoked without moving your main funds.
- **Least privilege:** Fund the bot with only what the strategy needs; keep the rest in a wallet
  the bot cannot touch.
- **Idempotency & restarts:** Reconcile against on-chain positions/orders each tick so a crash or
  duplicate tick never doubles exposure.
- **Error handling:** Wrap each tick in try/catch; on RPC/oracle failure, **do nothing** (hold)
  rather than retry blindly into a bad fill. Use the [fallback oracle URLs](api-endpoints.md).
- **Stale prices:** Re-fetch `marketsInfoData`/`tokensData` immediately before any decrease/close
  order — stale `acceptablePrice` gets rejected by keepers.
- **Monitoring & alerts:** Alert on kill-switch trips, failed orders, liquidation risk, and bot
  downtime. An unmonitored leveraged bot is a liability.
- **Kill-switch you can reach:** Have a manual way to flatten all positions and stop the loop
  immediately.

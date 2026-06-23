# GMX Edge-Analytics Tools

Read-only command-line tools that surface GMX V2's on-chain market mechanics —
**funding, borrowing, price impact, fees, and liquidation math** — so you can
trade **cost-efficiently** and avoid getting liquidated.

> ## What these tools do and don't do
>
> They report **costs and risk parameters**, which are knowable on-chain. They
> **do not predict price** and **cannot guarantee profit** — direction is the
> part no contract or tool can tell you. Use them to keep more of your edge
> (lower fees, avoid liquidation, understand carry), not to manufacture one.

## About "collecting fees from liquidations"

A common idea is to run a keeper that liquidates GMX traders and collects a
bounty (like Aave/Compound liquidation bots). **This does not work on GMX V2:**

- Order execution and liquidations are run by GMX's **permissioned keeper
  network** using signed oracle prices. There is **no public `liquidate()`
  bounty** to race for.
- When a position is liquidated, the remaining collateral and fees go to the
  **GM liquidity pool (LPs)** and protocol — not to whoever triggered it.

The legitimate way to earn from traders' fees and liquidations is to be a
**liquidity provider** (GM pools / GLV vaults). That payoff — trading fees,
borrowing fees, and the losing side of leveraged traders — is exactly what LPs
collect. See the **`gmx-liquidity`** skill in this repo. (LPs also carry the
risk of paying out winning traders, so it is not free money either.)

## Setup

```bash
npm install @gmx-io/sdk viem
node tools/<tool>.js ...
```

No wallet or private key is required — every tool is read-only and uses public
oracle/RPC endpoints. (`liquidation-guard.js audit` takes any account address to
inspect, but never signs anything.)

## Tools

| Tool | What it answers |
|------|-----------------|
| `funding-borrow-scanner.js` | Which markets/side pay you to hold (carry), and which bleed borrowing+funding? |
| `price-impact-side.js` | For a market, which side is *cheap* to trade right now (balances OI)? |
| `trade-cost-estimator.js` | What's the all-in cost of a trade, and the breakeven move it needs? |
| `liquidation-guard.js` | Where's my liquidation price, and where should the stop-loss sit? |

### funding-borrow-scanner.js
```bash
node tools/funding-borrow-scanner.js [arbitrum|avalanche|botanix]
```
Ranks markets by net carry (funding − borrowing) per side. Positive carry = you
are paid to hold; negative = it costs you. This is the raw data behind a
funding-capture / delta-neutral strategy (collect carry, hedge the direction).

### price-impact-side.js
```bash
node tools/price-impact-side.js <SYMBOL> [chain]   # e.g. ETH
```
Shows OI skew and which side is "balancing." Trading the balancing side gets the
lower position fee and favorable/zero price impact; the imbalancing side pays
more and takes adverse impact.

### trade-cost-estimator.js
```bash
node tools/trade-cost-estimator.js <SYMBOL> <sizeUsd> <long|short> <holdHours> [chain]
node tools/trade-cost-estimator.js ETH 10000 long 48
```
Adds open+close fees, borrowing, and funding over a holding period into a single
breakeven figure — the price move you need just to net zero. Useful for killing
trades whose edge is smaller than their cost.

### liquidation-guard.js
```bash
node tools/liquidation-guard.js estimate <entryPrice> <leverage> <long|short>
node tools/liquidation-guard.js audit <ACCOUNT> [chain]
```
`estimate` shows the approximate liquidation move for a hypothetical position so
you can size leverage sanely. `audit` reports each open position's liquidation
price, distance, accrued fees, and a suggested stop-loss that exits *before* the
protocol liquidates you.

## Accuracy notes

- GMX scales factors and prices by `1e30`. Helpers in `shared.js` convert these;
  if a number looks off by orders of magnitude, verify the field's scaling
  against the `@gmx-io/sdk` types.
- Exact price impact in USD requires the market's impact-pool factors from the
  reader contract; `price-impact-side.js` reports the fee/impact *regime* (which
  side is cheaper), not a precise USD quote.
- Funding/borrowing rates are live snapshots and drift over time; longer holds
  amplify the carry component.
- These are estimation aids. Verify against the GMX UI before acting, and
  paper-trade any automation built on them.

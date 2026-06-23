# GMX Auto-Trader

A balance-aware, risk-managed automation that runs the three-sleeve strategy
(LP fee capture + delta-neutral funding + leveraged directional) on a schedule.
It reads whatever your wallet actually holds and sizes everything off that — no
hardcoded amount — and scales position sizes up as the account grows.

> ## ⚠️ Read this before anything else
>
> **This is not a money machine and it does not "ensure profitable trades."** No
> bot can — direction is unknowable, and leveraged perps can be liquidated. What
> this tool does is stack *structural* edges (cheaper side, funding credits, LP
> fees) and **bound the downside** with stop-losses, a daily-loss limit, and a
> drawdown kill-switch. In a bad regime it will lose money; the controls cap how
> much, they do not prevent it.
>
> It **defaults to paper mode** (`DRY_RUN=true`) and sends zero transactions
> until you deliberately set `DRY_RUN=false`. Start there. Run it on paper for
> weeks and read every decision before risking a cent.

## How the flywheel maps to code

```
  GM/GLV pool        Funding capture       Directional
   sleeves/lp.js   sleeves/fundingCapture  sleeves/directional.js
        │                   │                     │
   park LP at the      open the carry-        scan all markets,
   highest-APR         receiving side,        enter the cheap side
   venue (GLV          monitor net delta      with SL/TP, reassess
   auto-rebalances)    (needs off-venue       4x/day, cooldown to
        │              hedge — see below)     avoid re-entering soon
        └───────────────────┴─────────────────────┘
                            │
              lib/risk.js gates every action
              lib/signals.js ranks the market
              lib/state.js  remembers peak/cooldowns
              index.js      schedules daily/weekly/monthly
```

## Setup

```bash
npm install @gmx-io/sdk viem
```

### The wallet question (important)

A bot cannot trade "through the Coinbase exchange app" — the exchange account
can't sign GMX transactions. Automation needs an **EOA private key the bot can
sign with**. Recommended setup:

1. Create a **dedicated hot wallet** (or a **GMX subaccount** delegated from your
   main wallet — revocable, limited authority).
2. Fund it with **only** your trading capital. If your funds are on **Base**
   (Coinbase's L2 / Coinbase Wallet self-custody), bridge into **GMX Account**
   via the GMX app, settling on Arbitrum. The bot then trades on Arbitrum.
3. Provide the key via env var — **never** hardcode or commit it:

```bash
export PRIVATE_KEY=0xYOUR_DEDICATED_HOT_WALLET_KEY
```

The bot reads its balance on startup and every cycle; if you add or remove funds,
it adapts automatically next tick.

## Run

```bash
# Paper mode (default) — logs every decision, trades nothing:
node tools/auto-trader/index.js

# Live — only after you've watched paper mode and understand the risks:
DRY_RUN=false PRIVATE_KEY=0x... node tools/auto-trader/index.js
```

Keep it running (e.g. `pm2`, `systemd`, or a container). It schedules itself:
directional every 4h, funding daily, LP weekly, scale review monthly. It
persists state to `.state.json` and resumes correctly after a restart by
reconciling against on-chain positions.

## Safety controls (all configurable in `config.js`)

| Control | Default | Effect |
|---------|---------|--------|
| `DRY_RUN` | `true` | No real transactions until explicitly disabled |
| `MIN_EQUITY_USD` | `50` | Won't trade a dust account that fees would eat |
| `MAX_DRAWDOWN_PCT` | `20%` | Master kill-switch — latches, needs manual reset |
| `MAX_DAILY_LOSS_PCT` | `5%` | Stands down new risk for the rest of the UTC day |
| `maxLeverageBps` | `3x` | Hard leverage cap (GMX allows 100x; don't) |
| `riskPerTradePct` | `1%` | Each trade risks a fixed small % of equity |
| `cooldownHours` | `6h` | Won't re-enter the same market too soon |
| Sidecar SL/TP | on | Stops live server-side, survive a bot crash |

If the drawdown kill-switch trips, the bot halts and writes the reason to
`.state.json`. It will not resume until you review what happened and clear the
`halted` flag yourself. That manual gate is intentional.

## Honest limitations (what's wired vs. what isn't)

- **LP execution is a marked integration point.** GM/GLV deposit/withdraw are
  contract-level (not SDK convenience methods). `sleeves/lp.js` computes the
  target venue and rebalance decision but does **not** move LP funds until you
  wire it to the `gmx-liquidity` skill's contract calls. It will not silently
  pretend to deposit.
- **Delta-neutral needs an off-venue hedge.** `fundingCapture.js` opens and
  monitors the GMX carry leg, but true neutrality requires an equal, opposite
  spot/short hedge on another venue, which this bot cannot place for you. Without
  that hedge the leg is just a low-leverage directional bet — run it only if you
  maintain the hedge.
- **Signal score ≠ win probability.** `signals.js` ranks markets by a heuristic
  blend of momentum, carry, and cost-side. It identifies *structurally
  favorable* setups, not guaranteed winners.
- **Multichain bridging from Base** isn't in the SDK yet — fund via the GMX app
  first (see Setup).
- **Not financial advice.** Backtest, paper-trade, and only deploy capital you
  can afford to lose entirely.

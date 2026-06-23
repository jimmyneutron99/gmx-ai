// config.js — all tunables for the auto-trader in one place.
//
// Everything is a percentage or a rule, NOT a hardcoded dollar amount. The bot
// reads your live wallet balance at runtime and sizes everything off that, so it
// works whether you have $80 or $80,000 and scales as the account grows.
//
// Override any value with an environment variable (see README).

const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);
const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] !== undefined ? process.env[k] === "true" : d);

module.exports = {
  // ─── Safety (read these first) ─────────────────────────────────────────────
  // DRY_RUN=true  → compute and log every decision, send NO transactions (paper).
  // DRY_RUN=false → live trading with real funds. You must set this deliberately.
  DRY_RUN: bool("DRY_RUN", true),

  // The bot refuses to operate below this equity (dust / fee-floor protection).
  // Perp fees + execution gas make tiny accounts unviable; protect the user.
  MIN_EQUITY_USD: num("MIN_EQUITY_USD", 50),

  // Hard stop: if equity falls this far below its peak, halt ALL new activity
  // and alert. This is the master kill-switch.
  MAX_DRAWDOWN_PCT: num("MAX_DRAWDOWN_PCT", 0.2), // 20%

  // Cap realized+unrealized loss per UTC day, then stand down until next day.
  MAX_DAILY_LOSS_PCT: num("MAX_DAILY_LOSS_PCT", 0.05), // 5% of equity

  // ─── Chain / wallet ────────────────────────────────────────────────────────
  CHAIN: env("CHAIN", "arbitrum"), // settlement chain (perps live here, not Base)
  // PRIVATE_KEY is read from env ONLY (see wallet.js). Never hardcode.
  // Recommended: a dedicated hot wallet or GMX subaccount, funded from Base via
  // GMX Account, holding ONLY trading capital.

  // ─── Capital allocation (fractions of available equity) ────────────────────
  // Must sum to <= 1.0. Remainder stays as idle USDC reserve (gas + buffer).
  ALLOCATION: {
    lp: num("ALLOC_LP", 0.5), // GM/GLV liquidity — passive fee capture
    funding: num("ALLOC_FUNDING", 0.2), // delta-neutral funding capture
    directional: num("ALLOC_DIRECTIONAL", 0.25), // leveraged directional
    // implied reserve: 1 - sum = 0.05
  },

  // ─── Directional sleeve ────────────────────────────────────────────────────
  DIRECTIONAL: {
    maxLeverageBps: num("DIR_MAX_LEV_BPS", 30000), // 3x cap (well under 100x)
    // Risk a fixed fraction of equity per trade (sized so the stop = this loss).
    riskPerTradePct: num("DIR_RISK_PER_TRADE", 0.01), // 1%
    stopDistancePct: num("DIR_STOP_DIST", 0.02), // 2% adverse move = stop
    takeProfitR: num("DIR_TP_R", 2.0), // take-profit at 2x the risked distance
    // Don't re-enter the same market until this cooldown passes (anti-overtrade).
    cooldownHours: num("DIR_COOLDOWN_H", 6),
    // Only act on signals at/above this heuristic score (see signals.js).
    minSignalScore: num("DIR_MIN_SCORE", 0.6),
    reassessEveryHours: num("DIR_REASSESS_H", 4), // re-check open trades 4x/day
  },

  // ─── Funding-capture sleeve (delta-neutral) ────────────────────────────────
  FUNDING: {
    minNetCarryApr: num("FUND_MIN_CARRY", 5), // only engage if net carry >= 5% APR
    leverageBps: num("FUND_LEV_BPS", 20000), // 2x; low leverage for the hedged leg
    // Max net delta (as % of the leg notional) before forcing a rebalance.
    // True neutrality needs a spot hedge on another venue (see sleeves/fundingCapture.js).
    maxNetDeltaPct: num("FUND_MAX_DELTA", 0.1),
    exitIfCarryBelowApr: num("FUND_EXIT_CARRY", 1), // unwind if carry decays under 1%
  },

  // ─── LP sleeve (GM / GLV) ──────────────────────────────────────────────────
  LP: {
    // Prefer GLV vaults (auto-rebalancing across pools) for hands-off max-APR.
    preferGlv: bool("LP_PREFER_GLV", true),
    // Only move LP capital if a better pool beats the current one by this margin,
    // net of entry/exit fees (prevents churn that eats the APR gain).
    rebalanceThresholdApr: num("LP_REBALANCE_THRESHOLD", 3), // +3% APR to justify a move
  },

  // ─── Scaling: stack small wins, then size up as the account grows ──────────
  // Position sizes are % of equity, so they grow automatically. This adds an
  // extra throttle: only raise the per-trade risk after sustained green.
  SCALING: {
    // Start conservative; step risk up after the account makes a new equity high
    // by this fraction, capped at maxRiskPerTradePct.
    baseRiskPerTradePct: num("SCALE_BASE_RISK", 0.01),
    maxRiskPerTradePct: num("SCALE_MAX_RISK", 0.02),
    stepUpOnNewHighPct: num("SCALE_STEP_HIGH", 0.1), // +10% equity high → step up
    riskStep: num("SCALE_RISK_STEP", 0.0025),
  },

  // ─── Schedule (cadence of each job) ────────────────────────────────────────
  SCHEDULE: {
    directionalEveryHours: num("SCHED_DIR_H", 4), // multiple times daily
    fundingEveryHours: num("SCHED_FUND_H", 24), // daily delta/carry check
    lpEveryHours: num("SCHED_LP_H", 168), // weekly LP rebalance
    compoundEveryHours: num("SCHED_COMPOUND_H", 720), // monthly scale review
  },

  // ─── State / ops ───────────────────────────────────────────────────────────
  STATE_FILE: env("STATE_FILE", "./tools/auto-trader/.state.json"),
  LOG_PREFIX: "[gmx-autotrader]",
};

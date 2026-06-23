// risk.js — the central gate. EVERY action from every sleeve passes through
// here before execution. This layer is what keeps an automated account alive;
// it is deliberately stricter than the entry signals.

// Returns { allowed, reason }. When halted, only de-risking (closes) is allowed.
function checkGlobal(cfg, state, equity) {
  if (equity < cfg.MIN_EQUITY_USD) {
    return { allowed: false, reason: `equity $${equity.toFixed(2)} below MIN_EQUITY_USD` };
  }

  // Master drawdown kill-switch — latches until the user manually clears it.
  const dd = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0;
  if (dd >= cfg.MAX_DRAWDOWN_PCT) {
    state.halted = true;
    state.haltReason = `drawdown ${(dd * 100).toFixed(1)}% >= ${(cfg.MAX_DRAWDOWN_PCT * 100)}%`;
    return { allowed: false, reason: state.haltReason };
  }

  // Daily loss limit — stand down new risk for the rest of the UTC day.
  if (state.dayStartEquity > 0) {
    const dayPnlPct = (equity - state.dayStartEquity) / state.dayStartEquity;
    if (dayPnlPct <= -cfg.MAX_DAILY_LOSS_PCT) {
      return { allowed: false, reason: `daily loss ${(dayPnlPct * 100).toFixed(1)}% hit limit` };
    }
  }

  if (state.halted) return { allowed: false, reason: `halted: ${state.haltReason}` };
  return { allowed: true };
}

// Per-trade checks for the directional sleeve.
function checkDirectionalEntry(cfg, state, market) {
  const last = state.lastEntryByMarket[market] || 0;
  const cooledMs = cfg.DIRECTIONAL.cooldownHours * 3600_000;
  if (Date.now() - last < cooledMs) {
    return { allowed: false, reason: "cooldown — re-entry too soon" };
  }
  return { allowed: true };
}

// Fixed-fractional sizing: size so that hitting the stop costs exactly
// riskPerTradePct of equity. notional = equity * risk% / stopDistance%.
function positionNotionalUsd(cfg, state, equity) {
  const risk = state.riskPerTradePct ?? cfg.DIRECTIONAL.riskPerTradePct;
  return (equity * risk) / cfg.DIRECTIONAL.stopDistancePct;
}

// Scaling: step risk up only after a fresh equity high; never above the cap.
function updateRiskTier(cfg, state) {
  const s = cfg.SCALING;
  if (state.riskPerTradePct == null) state.riskPerTradePct = s.baseRiskPerTradePct;
  // (Stepping logic is driven from the monthly compound job in index.js, which
  //  compares peakEquity growth; this just enforces the ceiling.)
  if (state.riskPerTradePct > s.maxRiskPerTradePct) state.riskPerTradePct = s.maxRiskPerTradePct;
  return state.riskPerTradePct;
}

module.exports = {
  checkGlobal,
  checkDirectionalEntry,
  positionNotionalUsd,
  updateRiskTier,
};

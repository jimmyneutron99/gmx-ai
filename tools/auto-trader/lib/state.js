// state.js — durable state across runs. Tracks peak equity (for the drawdown
// kill-switch), per-day PnL, per-market cooldowns, and the current risk tier.
//
// Persisted to disk so a restart resumes correctly. The bot ALSO reconciles
// against on-chain positions every tick — this file is for things chain state
// can't tell us (peaks, timestamps), never the source of truth for positions.

const fs = require("fs");

const DEFAULT = {
  peakEquity: 0,
  dayKey: null, // UTC date string
  dayStartEquity: 0,
  lastEntryByMarket: {}, // marketAddress -> epoch ms
  riskPerTradePct: null, // current scaled risk tier
  halted: false, // set true when kill-switch trips; requires manual reset
  haltReason: null,
};

function load(path) {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(path, "utf8")) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(path, state) {
  try {
    fs.writeFileSync(path, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to persist state:", e.message);
  }
}

// Roll the day bucket over at UTC midnight.
function rollDay(state, equity) {
  const key = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.dayStartEquity = equity;
  }
  if (!state.peakEquity || equity > state.peakEquity) state.peakEquity = equity;
  return state;
}

module.exports = { load, save, rollDay, DEFAULT };

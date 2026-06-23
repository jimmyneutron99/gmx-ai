#!/usr/bin/env node
// index.js — orchestrator. Reads live balance, runs the three sleeves on their
// own cadences, and enforces the global risk gate before anything trades.
//
//   DRY_RUN=true  node tools/auto-trader/index.js        # paper (default, safe)
//   DRY_RUN=false PRIVATE_KEY=0x... node tools/auto-trader/index.js   # LIVE
//
// Cadence (configurable in config.js):
//   directional reassess+enter : every 4h  (multiple times daily)
//   funding-capture check      : daily
//   LP rebalance               : weekly
//   compound / scale review    : monthly
//
// This is NOT a profit guarantee. It is a risk-managed allocator. It will lose
// money in bad regimes; the controls bound how much, they do not prevent it.

const cfg = require("./config");
const stateStore = require("./lib/state");
const { makeSdk, readEquity } = require("./lib/wallet");
const risk = require("./lib/risk");
const directional = require("./sleeves/directional");
const fundingCapture = require("./sleeves/fundingCapture");
const lp = require("./sleeves/lp");

const log = (...a) => console.log(cfg.LOG_PREFIX, ...a);

let sdk, account, chainCfg, state;

// Build a fresh per-run context (fresh oracle data, fresh equity).
async function buildCtx() {
  const snap = await readEquity(sdk, account);
  stateStore.rollDay(state, snap.totalEquity);
  risk.updateRiskTier(cfg, state);
  return {
    sdk, account, cfg, state, log,
    oracleUrl: chainCfg.oracleUrl,
    equity: snap.totalEquity,
    usdc: snap.usdc,
    snap,
  };
}

async function guardedRun(name, fn) {
  try {
    const ctx = await buildCtx();
    const gate = risk.checkGlobal(cfg, state, ctx.equity);
    log(`── ${name} | equity $${ctx.equity.toFixed(2)} | peak $${state.peakEquity.toFixed(2)} | risk ${(state.riskPerTradePct * 100).toFixed(2)}%`);
    if (!gate.allowed && name !== "directional-reassess") {
      // When halted, still allow reassess (it only closes/de-risks).
      log(`   gate closed: ${gate.reason} — skipping ${name}`);
      stateStore.save(cfg.STATE_FILE, state);
      return;
    }
    await fn(ctx);
    stateStore.save(cfg.STATE_FILE, state);
  } catch (e) {
    log(`   ERROR in ${name}: ${e.message}`);
  }
}

// Directional job: close/adjust first, then maybe open.
async function jobDirectional() {
  await guardedRun("directional-reassess", (ctx) => directional.reassess(ctx));
  await guardedRun("directional-enter", (ctx) => directional.maybeEnter(ctx));
}
const jobFunding = () => guardedRun("funding-capture", (ctx) => fundingCapture.run(ctx));
const jobLp = () => guardedRun("lp-rebalance", (ctx) => lp.run(ctx));

// Monthly: step the risk tier up only after a sustained new equity high.
async function jobCompound() {
  await guardedRun("compound-review", async (ctx) => {
    const s = cfg.SCALING;
    const grew = state.lastScaleEquity ? ctx.equity >= state.lastScaleEquity * (1 + s.stepUpOnNewHighPct) : true;
    if (grew && state.riskPerTradePct < s.maxRiskPerTradePct) {
      state.riskPerTradePct = Math.min(s.maxRiskPerTradePct, (state.riskPerTradePct || s.baseRiskPerTradePct) + s.riskStep);
      state.lastScaleEquity = ctx.equity;
      log(`   scaled risk-per-trade up to ${(state.riskPerTradePct * 100).toFixed(2)}% on new equity high`);
    } else {
      log("   no scale-up (equity not at a sufficient new high)");
    }
  });
}

function every(hours, fn) {
  const ms = hours * 3600_000;
  fn(); // run once on startup
  return setInterval(fn, ms);
}

async function main() {
  ({ sdk, account, chainCfg } = makeSdk(cfg));
  state = stateStore.load(cfg.STATE_FILE);

  log("starting GMX auto-trader");
  log(`mode: ${cfg.DRY_RUN ? "DRY-RUN (paper, no transactions)" : "*** LIVE TRADING ***"}`);
  log(`chain: ${cfg.CHAIN} | account: ${account?.address || "(read-only / no key)"}`);
  log(`allocation: LP ${cfg.ALLOCATION.lp * 100}% | funding ${cfg.ALLOCATION.funding * 100}% | directional ${cfg.ALLOCATION.directional * 100}%`);
  log("NOTE: this allocator does not guarantee profit. It bounds risk; it cannot prevent losses.");
  if (state.halted) log(`WARNING: bot is HALTED (${state.haltReason}). Clear .state.json 'halted' to resume.`);

  const timers = [
    every(cfg.SCHEDULE.directionalEveryHours, jobDirectional),
    every(cfg.SCHEDULE.fundingEveryHours, jobFunding),
    every(cfg.SCHEDULE.lpEveryHours, jobLp),
    every(cfg.SCHEDULE.compoundEveryHours, jobCompound),
  ];

  const shutdown = () => {
    log("shutting down — persisting state");
    timers.forEach(clearInterval);
    stateStore.save(cfg.STATE_FILE, state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(cfg.LOG_PREFIX, "fatal:", e.message);
  process.exit(1);
});

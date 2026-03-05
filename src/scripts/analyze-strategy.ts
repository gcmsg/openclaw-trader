/**
 * Strategy Reliability Analysis CLI
 *
 * Usage:
 *   npm run analyze                                     # Full analysis with default strategy
 *   npm run analyze -- --strategy short-trend           # Specify strategy
 *   npm run analyze -- --wf                             # Run Walk-Forward only
 *   npm run analyze -- --sensitivity ma.short           # Parameter sensitivity
 *   npm run analyze -- --mc                             # Run Monte Carlo only
 */

import { loadStrategyConfig, loadStrategyProfile } from "../config/loader.js";
import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import {
  walkForwardSingle,
  runSensitivity,
  runMonteCarlo,
  formatWalkForwardReport,
  formatSensitivityReport,
  formatMonteCarloReport,
} from "../backtest/walk-forward.js";
import type { SensitivityParam } from "../backtest/walk-forward.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─── Argument Parsing ──────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const strategyArg = getArg("strategy");
const runWF     = hasFlag("wf")          || (!hasFlag("sensitivity") && !hasFlag("mc"));
const runSens   = hasFlag("sensitivity") || (!hasFlag("wf")          && !hasFlag("mc"));
const runMC     = hasFlag("mc")          || (!hasFlag("wf")          && !hasFlag("sensitivity"));
const sensParam = getArg("sensitivity") ?? "ma.short";
const days      = parseInt(getArg("days") ?? "120", 10);
const INITIAL   = 1000;

// ─── Config Loading ──────────────────────────────────────────

function buildCfg(): StrategyConfig {
  const base = loadStrategyConfig();
  if (!strategyArg) return base;
  try {
    const profile = loadStrategyProfile(strategyArg);
    return {
      ...base,
      symbols:    profile.symbols    ?? base.symbols,
      timeframe:  (profile.timeframe ?? base.timeframe),
      strategy:   { ...base.strategy, ...profile.strategy } as StrategyConfig["strategy"],
      signals:    { ...base.signals,  ...profile.signals },
      risk:       { ...base.risk,     ...(profile.risk ?? {}) },
    };
  } catch {
    console.warn(`⚠️ Strategy "${strategyArg}" not found, using default config`);
    return base;
  }
}

// ─── Main Function ────────────────────────────────────────────

async function main() {
  const cfg = buildCfg();
  const symbols = cfg.symbols.slice(0, 3); // Max 3, to avoid being too slow

  console.log(`\n🔬 Strategy Reliability Analysis: ${strategyArg ?? "default"} | ${days} days of history\n`);

  // Pre-fetch klines
  console.log("📡 Fetching historical data...");
  const now = Date.now();
  const startMs = now - days * 24 * 3600 * 1000;
  const allKlines: Record<string, Kline[]> = {};

  for (const symbol of symbols) {
    const klines = await fetchHistoricalKlines(symbol, cfg.timeframe, startMs, now);
    allKlines[symbol] = klines;
    console.log(`  ${symbol}: ${klines.length} candlesticks`);
  }

  const sep = "─".repeat(50);

  // ── Walk-Forward ──────────────────────────────────
  if (runWF) {
    console.log(`\n${sep}`);
    console.log("📊 Walk-Forward Validation (5 folds)\n");

    const wfResults = symbols.map((sym) =>
walkForwardSingle(allKlines[sym] ?? [], cfg, sym, 5, 0.7)
    );
    console.log(formatWalkForwardReport(wfResults));

    const robustCount = wfResults.filter((r) => r.robust).length;
    if (robustCount === symbols.length) {
      console.log("✅ All tested symbols show robust strategy, statistically significant\n");
    } else if (robustCount > 0) {
      console.log(`⚠️ ${robustCount}/${symbols.length} symbols robust, others need optimization\n`);
    } else {
      console.log("❌ All out-of-sample returns negative, strategy may be overfitted, not recommended for live trading\n");
    }
  }

  // ── Parameter Sensitivity ────────────────────────────────────
  if (runSens) {
    console.log(`\n${sep}`);
    console.log("📊 Parameter Sensitivity Analysis\n");

    const sym = symbols[0] ?? "";
    const klines = allKlines[sym] ?? [];
    const params = getDefaultParams(sensParam);

    for (const param of params) {
      const report = runSensitivity(klines, cfg, sym, param);
      console.log(formatSensitivityReport(report));
      console.log("");
    }
  }

  // ── Monte Carlo ─────────────────────────────────────
  if (runMC) {
    console.log(`\n${sep}`);
    console.log("🎲 Monte Carlo Risk Simulation (1000 runs)\n");

    const result = runBacktest(allKlines, cfg, { initialUsdt: INITIAL });

    for (const sym of symbols) {
      const trades = result.trades
        .filter((t) => t.symbol === sym && (t.side === "sell" || t.side === "cover"))
        .map((t) => ({ returnPct: t.pnlPercent * 100 }));

      if (trades.length < 5) {
        console.log(`${sym.replace("USDT", "")}: Insufficient trades (${trades.length}), skipping\n`);
        continue;
      }

      console.log(`**${sym.replace("USDT", "")}** (${trades.length} trades)`);
      console.log(formatMonteCarloReport(runMonteCarlo(trades, 1000)));
      console.log("");
    }
  }
}

// ─── Parameter List ─────────────────────────────────────────

function getDefaultParams(focused?: string): SensitivityParam[] {
  if (focused === "ma.long") {
    return [{ name: "MA Long Period", path: "strategy.ma.long", values: [40, 45, 50, 55, 60, 65, 70, 80] }];
  }
  if (focused === "stoploss") {
    return [{ name: "Stop Loss %", path: "risk.stop_loss_percent", values: [3, 4, 5, 6, 7, 8] }];
  }
  if (focused === "rsi") {
    return [{ name: "RSI Period", path: "strategy.rsi.period", values: [9, 10, 12, 14, 16, 18] }];
  }
  // Default: MA short + MA long
  return [
    { name: "MA Short Period", path: "strategy.ma.short", values: [12, 15, 18, 20, 22, 25, 30] },
    { name: "MA Long Period",  path: "strategy.ma.long",  values: [40, 50, 55, 60, 65, 70, 80] },
  ];
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((e: unknown) => {
  console.error("Analysis failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

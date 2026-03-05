/**
 * Long-Cycle Segmented Backtest Analysis
 *
 * Segments historical data by market phases, and for each phase:
 *   1. Backtests with current default parameters (baseline)
 *   2. Uses hyperopt to find optimal parameters for that phase
 *   3. Compares baseline vs optimized
 *
 * Final validation: whether using different strategies+parameters per segment
 * outperforms a single global parameter set.
 *
 * Usage: npm run cycle-analysis
 */

import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest, type BacktestResult } from "../backtest/runner.js";
import { loadStrategyConfig } from "../config/loader.js";
import { BayesianOptimizer } from "../optimization/bayesian.js";
import { evaluateParams, applyParams } from "../optimization/objective.js";
import { DEFAULT_PARAM_SPACE, type ParamSet } from "../optimization/param-space.js";
import type { Kline, StrategyConfig } from "../types.js";

// ── Market Phase Definition ─────────────────────────────────────
interface Phase {
  name: string;
  label: string;       // Market state label
  startDate: string;   // YYYY-MM-DD
  endDate: string;
}

const PHASES: Phase[] = [
  { name: "Accumulation",   label: "accumulation", startDate: "2023-06-01", endDate: "2023-10-15" },
  { name: "Bull Start",     label: "bull_start",   startDate: "2023-10-15", endDate: "2024-03-15" },
  { name: "Consolidation",  label: "consolidation", startDate: "2024-03-15", endDate: "2024-10-15" },
  { name: "Bull Peak",      label: "bull_peak",    startDate: "2024-10-15", endDate: "2025-01-20" },
  { name: "Top Range",      label: "top_range",    startDate: "2025-01-20", endDate: "2025-08-30" },
  { name: "Bear Start",     label: "bear_start",   startDate: "2025-08-30", endDate: "2026-02-26" },
];

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "BNBUSDT"];
const HYPEROPT_TRIALS = 50;

// ── Utilities ─────────────────────────────────────────────
function dateMs(d: string): number { return new Date(d + "T00:00:00Z").getTime(); }

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

async function fetchPhaseData(
  symbols: string[],
  phase: Phase,
  timeframe: string
): Promise<Record<string, Kline[]>> {
  const data: Record<string, Kline[]> = {};
  for (const sym of symbols) {
    const klines = await fetchHistoricalKlines(
      sym, timeframe, dateMs(phase.startDate), dateMs(phase.endDate)
    );
    data[sym] = klines;
  }
  return data;
}

function runPhaseBacktest(
  klines: Record<string, Kline[]>,
  cfg: StrategyConfig,
): BacktestResult {
  return runBacktest(klines, cfg, {
    initialUsdt: 1000,
    feeRate: 0.001,
    slippagePercent: 0.05,
  });
}

// ── Segmented Hyperopt ────────────────────────────────────
async function optimizeForPhase(
  klines: Record<string, Kline[]>,
  baseCfg: StrategyConfig,
): Promise<{ bestParams: ParamSet; bestScore: number }> {
  // Use the first symbol with data for optimization (avoid multi-symbol optimization being too slow)
  const primarySymbol = "BTCUSDT";
  const primaryKlines = klines[primarySymbol];
  if (!primaryKlines || primaryKlines.length < 100) {
    // Insufficient data, skip optimization
    return { bestParams: {}, bestScore: -999 };
  }

  const klineCache = new Map<string, Kline[]>([[primarySymbol, primaryKlines]]);

  const optimizer = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
  for (let i = 0; i < HYPEROPT_TRIALS; i++) {
    const params = optimizer.suggest();
    const res = await evaluateParams(params, primarySymbol, baseCfg, klineCache);
    optimizer.observe(params, res.score);
  }

  const best = optimizer.best();
  if (!best) return { bestParams: {}, bestScore: -999 };
  return { bestParams: best.params, bestScore: best.score };
}

// ── Main Flow ───────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Long-Cycle Segmented Backtest (Cycle Analysis) ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const baseCfg = loadStrategyConfig();

  interface PhaseResult {
    phase: Phase;
    baseline: { return: number; trades: number; winRate: number; sharpe: number; profitFactor: number };
    optimized: { return: number; trades: number; winRate: number; sharpe: number; profitFactor: number; params: ParamSet };
  }

  const results: PhaseResult[] = [];

  for (const phase of PHASES) {
    console.log(`\n━━━ ${phase.name} (${phase.startDate} → ${phase.endDate}) ━━━`);

    // 1. Fetch data
    console.log("  📥 Fetching candlestick data...");
    const klines = await fetchPhaseData(SYMBOLS, phase, "1h");
    const totalBars = Object.values(klines).reduce((s, k) => s + k.length, 0);
    console.log(`  ✓ ${totalBars} candlesticks`);

    if (totalBars < 500) {
      console.log("  ⚠️ Insufficient data, skipping this phase");
      continue;
    }

    // 2. Baseline (current default parameters)
    console.log("  🔄 Baseline backtest...");
    const baseResult = runPhaseBacktest(klines, baseCfg);
    const bm = baseResult.metrics;
    console.log(`  📊 Baseline: ${formatPct(bm.totalReturnPercent)} | ${bm.totalTrades} trades | WR ${(bm.winRate*100).toFixed(1)}% | Sharpe ${bm.sharpeRatio.toFixed(2)} | PF ${bm.profitFactor.toFixed(2)}`);

    // 3. Hyperopt segmented optimization
    console.log(`  🔍 Hyperopt (${HYPEROPT_TRIALS} trials)...`);
    const optResult = await optimizeForPhase(klines, baseCfg);

    // 4. Run all symbols with optimal parameters
    let optMetrics;
    if (optResult.bestScore > -900 && Object.keys(optResult.bestParams).length > 0) {
      const optCfg = applyParams(optResult.bestParams, baseCfg);
      const optBacktest = runPhaseBacktest(klines, optCfg);
      optMetrics = optBacktest.metrics;
      console.log(`  🏆 Optimized: ${formatPct(optMetrics.totalReturnPercent)} | ${optMetrics.totalTrades} trades | WR ${(optMetrics.winRate*100).toFixed(1)}% | Sharpe ${optMetrics.sharpeRatio.toFixed(2)} | PF ${optMetrics.profitFactor.toFixed(2)}`);

      // Print key parameter differences
      const p = optResult.bestParams;
      const diffs: string[] = [];
      if (p["ma_short"] !== undefined) diffs.push(`MA ${Math.round(p["ma_short"])}/${Math.round(p["ma_long"] ?? 60)}`);
      if (p["rsi_period"] !== undefined) diffs.push(`RSI${Math.round(p["rsi_period"])}`);
      if (p["stop_loss_pct"] !== undefined) diffs.push(`SL${p["stop_loss_pct"].toFixed(1)}%`);
      if (p["take_profit_pct"] !== undefined) diffs.push(`TP${p["take_profit_pct"].toFixed(1)}%`);
      console.log(`  ⚙️  Optimal params: ${diffs.join(" | ")}`);
    } else {
      optMetrics = bm;
      console.log("  ⚠️ Optimization did not find better parameters");
    }

    results.push({
      phase,
      baseline: {
        return: bm.totalReturnPercent,
        trades: bm.totalTrades,
        winRate: bm.winRate * 100,
        sharpe: bm.sharpeRatio,
        profitFactor: bm.profitFactor,
      },
      optimized: {
        return: optMetrics.totalReturnPercent,
        trades: optMetrics.totalTrades,
        winRate: optMetrics.winRate * 100,
        sharpe: optMetrics.sharpeRatio,
        profitFactor: optMetrics.profitFactor,
        params: optResult.bestParams,
      },
    });
  }

  // ── Summary Table ──────────────────────────────────────
  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    Segmented Backtest Summary                             ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝\n");

  console.log("Phase           | Baseline        | Optimized       | Improvement");
  console.log("─".repeat(75));

  let totalBaseline = 0;
  let totalOptimized = 0;

  for (const r of results) {
    const bl = `${formatPct(r.baseline.return).padEnd(8)} ${r.baseline.trades}t WR${r.baseline.winRate.toFixed(0)}%`;
    const op = `${formatPct(r.optimized.return).padEnd(8)} ${r.optimized.trades}t WR${r.optimized.winRate.toFixed(0)}%`;
    const diff = r.optimized.return - r.baseline.return;
    const diffStr = diff > 0 ? `✅ +${diff.toFixed(2)}%` : diff < 0 ? `❌ ${diff.toFixed(2)}%` : "─";
    console.log(`${r.phase.name.padEnd(14)} | ${bl.padEnd(15)} | ${op.padEnd(15)} | ${diffStr}`);

    totalBaseline += r.baseline.return;
    totalOptimized += r.optimized.return;
  }

  console.log("─".repeat(75));
  console.log(`Cumulative      | ${formatPct(totalBaseline).padEnd(15)} | ${formatPct(totalOptimized).padEnd(15)} | Δ ${formatPct(totalOptimized - totalBaseline)}`);

  console.log("\n📋 Optimal parameters per phase:\n");
  for (const r of results) {
    const p = r.optimized.params;
    if (Object.keys(p).length === 0) {
      console.log(`  ${r.phase.name}: (default parameters)`);
      continue;
    }
    const parts: string[] = [];
    if (p["ma_short"] !== undefined) parts.push(`MA ${Math.round(p["ma_short"])}/${Math.round(p["ma_long"] ?? 60)}`);
    if (p["rsi_period"] !== undefined) parts.push(`RSI ${Math.round(p["rsi_period"])}`);
    if (p["stop_loss_pct"] !== undefined) parts.push(`SL ${p["stop_loss_pct"].toFixed(1)}%`);
    if (p["take_profit_pct"] !== undefined) parts.push(`TP ${p["take_profit_pct"].toFixed(1)}%`);
    if (p["position_ratio"] !== undefined) parts.push(`Pos ${(p["position_ratio"] * 100).toFixed(0)}%`);
    console.log(`  ${r.phase.name}: ${parts.join(" | ")}`);
  }

  // ── Save Results ────────────────────────────────────
  const fs = await import("fs");
  fs.writeFileSync(
    "logs/cycle-analysis.json",
    JSON.stringify(results, null, 2)
  );
  console.log("\n💾 Results saved: logs/cycle-analysis.json");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch(console.error);

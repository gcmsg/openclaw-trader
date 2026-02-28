/**
 * 大周期分段回测分析
 *
 * 将历史数据按市场阶段分段，在每个阶段分别：
 *   1. 用当前默认参数回测（baseline）
 *   2. 用 hyperopt 找该阶段最优参数
 *   3. 对比 baseline vs optimized
 *
 * 最终验证：分段使用不同策略+参数是否优于全局一套参数。
 *
 * 用法：npm run cycle-analysis
 */

import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest, type BacktestResult } from "../backtest/runner.js";
import { loadStrategyConfig } from "../config/loader.js";
import { BayesianOptimizer } from "../optimization/bayesian.js";
import { evaluateParams, applyParams } from "../optimization/objective.js";
import { DEFAULT_PARAM_SPACE, type ParamSet } from "../optimization/param-space.js";
import type { Kline, StrategyConfig } from "../types.js";

// ── 市场阶段定义 ─────────────────────────────────────
interface Phase {
  name: string;
  label: string;       // 市场状态标签
  startDate: string;   // YYYY-MM-DD
  endDate: string;
}

const PHASES: Phase[] = [
  { name: "谷底积累",   label: "accumulation", startDate: "2023-06-01", endDate: "2023-10-15" },
  { name: "牛市启动",   label: "bull_start",   startDate: "2023-10-15", endDate: "2024-03-15" },
  { name: "高位震荡",   label: "consolidation", startDate: "2024-03-15", endDate: "2024-10-15" },
  { name: "牛市冲顶",   label: "bull_peak",    startDate: "2024-10-15", endDate: "2025-01-20" },
  { name: "顶部震荡",   label: "top_range",    startDate: "2025-01-20", endDate: "2025-08-30" },
  { name: "熊市初期",   label: "bear_start",   startDate: "2025-08-30", endDate: "2026-02-26" },
];

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "BNBUSDT"];
const HYPEROPT_TRIALS = 50;

// ── 工具 ─────────────────────────────────────────────
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

// ── 分段 Hyperopt ────────────────────────────────────
async function optimizeForPhase(
  klines: Record<string, Kline[]>,
  baseCfg: StrategyConfig,
): Promise<{ bestParams: ParamSet; bestScore: number }> {
  // 用第一个有数据的 symbol 做优化（避免多 symbol 优化太慢）
  const primarySymbol = "BTCUSDT";
  const primaryKlines = klines[primarySymbol];
  if (!primaryKlines || primaryKlines.length < 100) {
    // 数据不足，跳过优化
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

// ── 主流程 ───────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        大周期分段回测分析 (Cycle Analysis)        ║");
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

    // 1. 获取数据
    console.log("  📥 获取 K 线数据...");
    const klines = await fetchPhaseData(SYMBOLS, phase, "1h");
    const totalBars = Object.values(klines).reduce((s, k) => s + k.length, 0);
    console.log(`  ✓ ${totalBars} 根 K 线`);

    if (totalBars < 500) {
      console.log("  ⚠️ 数据不足，跳过此阶段");
      continue;
    }

    // 2. Baseline（当前默认参数）
    console.log("  🔄 Baseline 回测...");
    const baseResult = runPhaseBacktest(klines, baseCfg);
    const bm = baseResult.metrics;
    console.log(`  📊 Baseline: ${formatPct(bm.totalReturnPercent)} | ${bm.totalTrades}笔 | 胜率${(bm.winRate*100).toFixed(1)}% | Sharpe ${bm.sharpeRatio.toFixed(2)} | PF ${bm.profitFactor.toFixed(2)}`);

    // 3. Hyperopt 分段优化
    console.log(`  🔍 Hyperopt (${HYPEROPT_TRIALS} trials)...`);
    const optResult = await optimizeForPhase(klines, baseCfg);

    // 4. 用最优参数跑全部 symbol
    let optMetrics;
    if (optResult.bestScore > -900 && Object.keys(optResult.bestParams).length > 0) {
      const optCfg = applyParams(optResult.bestParams, baseCfg);
      const optBacktest = runPhaseBacktest(klines, optCfg);
      optMetrics = optBacktest.metrics;
      console.log(`  🏆 Optimized: ${formatPct(optMetrics.totalReturnPercent)} | ${optMetrics.totalTrades}笔 | 胜率${(optMetrics.winRate*100).toFixed(1)}% | Sharpe ${optMetrics.sharpeRatio.toFixed(2)} | PF ${optMetrics.profitFactor.toFixed(2)}`);

      // 打印关键参数差异
      const p = optResult.bestParams;
      const diffs: string[] = [];
      if (p["ma_short"] !== undefined) diffs.push(`MA ${Math.round(p["ma_short"])}/${Math.round(p["ma_long"] ?? 60)}`);
      if (p["rsi_period"] !== undefined) diffs.push(`RSI${Math.round(p["rsi_period"])}`);
      if (p["stop_loss_pct"] !== undefined) diffs.push(`SL${p["stop_loss_pct"].toFixed(1)}%`);
      if (p["take_profit_pct"] !== undefined) diffs.push(`TP${p["take_profit_pct"].toFixed(1)}%`);
      console.log(`  ⚙️  最优参数: ${diffs.join(" | ")}`);
    } else {
      optMetrics = bm;
      console.log("  ⚠️ 优化未找到更好参数");
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

  // ── 汇总表 ──────────────────────────────────────
  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║                        分段回测汇总                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝\n");

  console.log("阶段            | Baseline        | Optimized       | 提升");
  console.log("─".repeat(75));

  let totalBaseline = 0;
  let totalOptimized = 0;

  for (const r of results) {
    const bl = `${formatPct(r.baseline.return).padEnd(8)} ${r.baseline.trades}笔 WR${r.baseline.winRate.toFixed(0)}%`;
    const op = `${formatPct(r.optimized.return).padEnd(8)} ${r.optimized.trades}笔 WR${r.optimized.winRate.toFixed(0)}%`;
    const diff = r.optimized.return - r.baseline.return;
    const diffStr = diff > 0 ? `✅ +${diff.toFixed(2)}%` : diff < 0 ? `❌ ${diff.toFixed(2)}%` : "─";
    console.log(`${r.phase.name.padEnd(14)} | ${bl.padEnd(15)} | ${op.padEnd(15)} | ${diffStr}`);

    totalBaseline += r.baseline.return;
    totalOptimized += r.optimized.return;
  }

  console.log("─".repeat(75));
  console.log(`累计收益        | ${formatPct(totalBaseline).padEnd(15)} | ${formatPct(totalOptimized).padEnd(15)} | Δ ${formatPct(totalOptimized - totalBaseline)}`);

  console.log("\n📋 各阶段最优参数：\n");
  for (const r of results) {
    const p = r.optimized.params;
    if (Object.keys(p).length === 0) {
      console.log(`  ${r.phase.name}: (默认参数)`);
      continue;
    }
    const parts: string[] = [];
    if (p["ma_short"] !== undefined) parts.push(`MA ${Math.round(p["ma_short"])}/${Math.round(p["ma_long"] ?? 60)}`);
    if (p["rsi_period"] !== undefined) parts.push(`RSI ${Math.round(p["rsi_period"])}`);
    if (p["stop_loss_pct"] !== undefined) parts.push(`SL ${p["stop_loss_pct"].toFixed(1)}%`);
    if (p["take_profit_pct"] !== undefined) parts.push(`TP ${p["take_profit_pct"].toFixed(1)}%`);
    if (p["position_ratio"] !== undefined) parts.push(`仓位 ${(p["position_ratio"] * 100).toFixed(0)}%`);
    console.log(`  ${r.phase.name}: ${parts.join(" | ")}`);
  }

  // ── 保存结果 ────────────────────────────────────
  const fs = await import("fs");
  fs.writeFileSync(
    "logs/cycle-analysis.json",
    JSON.stringify(results, null, 2)
  );
  console.log("\n💾 结果已保存: logs/cycle-analysis.json");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch(console.error);

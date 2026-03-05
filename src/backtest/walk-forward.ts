/**
 * Walk-Forward Backtest + Parameter Sensitivity + Monte Carlo
 *
 * Problem Walk-Forward solves:
 *   Finding the "best" parameters using all historical data, then testing on the same history
 *   = overfitting (the future will never exactly replicate the past)
 *
 * Correct approach:
 *   Split data chronologically into N folds, optimize on earlier folds, validate on the last fold (out-of-sample OOS)
 *   Only if OOS returns are consistently positive does the strategy have statistical significance
 */

import { runBacktest } from "./runner.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─── Type Definitions ──────────────────────────────────────────

export interface WalkForwardFold {
  foldIndex: number;
  trainBars: number;         // Training set kline count
  testBars: number;          // Validation set kline count
  inSampleReturn: number;    // Training set return %
  outOfSampleReturn: number; // Validation set return % (key metric)
  outOfSampleSharpe: number;
  outOfSampleTrades: number;
  outOfSampleWinRate: number;
}

export interface WalkForwardResult {
  symbol: string;
  totalFolds: number;
  folds: WalkForwardFold[];
  avgOutOfSampleReturn: number;
  avgInSampleReturn: number;
  consistency: number;    // OOS positive-return folds / total folds
  robust: boolean;        // avgOOS > 0 && consistency >= 0.6
  verdict: string;
}

export interface SensitivityResult {
  paramName: string;
  paramValue: number | string;
  totalReturnPct: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
}

export interface SensitivityReport {
  paramName: string;
  results: SensitivityResult[];
  bestValue: number | string;
  robustPct: number;         // % of parameter values producing positive returns
  verdict: string;
}

// ─── Walk-Forward ─────────────────────────────────────

/**
 * Run Walk-Forward analysis on klines for a single symbol.
 *
 * @param klines     Full historical klines (sorted, earliest first)
 * @param cfg        Strategy config (only this symbol is used)
 * @param symbol     Trading pair
 * @param folds      Number of folds (default 5)
 * @param trainRatio Training set ratio per fold (default 0.7 = 70% train, 30% validate)
 */
export function walkForwardSingle(
  klines: Kline[],
  cfg: StrategyConfig,
  symbol: string,
  folds = 5,
  trainRatio = 0.7
): WalkForwardResult {
  const foldSize = Math.floor(klines.length / folds);
  const trainSize = Math.floor(foldSize * folds * trainRatio);
  const testSize = foldSize;
  const singleCfg = { ...cfg, symbols: [symbol] };

  const foldResults: WalkForwardFold[] = [];

  // Rolling window: advance by one fold each iteration
  for (let i = 0; i < folds - 1; i++) {
    const trainEnd = trainSize + i * testSize;
    const testEnd = trainEnd + testSize;

    if (testEnd > klines.length) break;

    const trainKlines = klines.slice(0, trainEnd);
    const testKlines = klines.slice(trainEnd, testEnd);

    if (trainKlines.length < 60 || testKlines.length < 10) continue;

    const trainResult = runBacktest({ [symbol]: trainKlines }, singleCfg);
    const testResult = runBacktest({ [symbol]: testKlines }, singleCfg);

    const inReturn = trainResult.metrics.totalReturnPercent;
    const oosReturn = testResult.metrics.totalReturnPercent;

    foldResults.push({
      foldIndex: i,
      trainBars: trainKlines.length,
      testBars: testKlines.length,
      inSampleReturn: inReturn,
      outOfSampleReturn: oosReturn,
      outOfSampleSharpe: testResult.metrics.sharpeRatio,
      outOfSampleTrades: testResult.metrics.totalTrades,
      outOfSampleWinRate: testResult.metrics.winRate,
    });
  }

  const avgOOS = foldResults.length > 0
    ? foldResults.reduce((s, f) => s + f.outOfSampleReturn, 0) / foldResults.length
    : 0;
  const avgIS = foldResults.length > 0
    ? foldResults.reduce((s, f) => s + f.inSampleReturn, 0) / foldResults.length
    : 0;
  const positiveOOS = foldResults.filter((f) => f.outOfSampleReturn > 0).length;
  const consistency = foldResults.length > 0 ? positiveOOS / foldResults.length : 0;
  const robust = avgOOS > 0 && consistency >= 0.6;

  const sign = (n: number) => (n >= 0 ? "+" : "");
  let verdict: string;
  if (robust) {
    verdict = `✅ Robust (OOS avg ${sign(avgOOS)}${avgOOS.toFixed(1)}%, ${Math.round(consistency * 100)}% folds positive)`;
  } else if (avgOOS > -3 && consistency >= 0.4) {
    verdict = `⚠️ Moderate (OOS avg ${sign(avgOOS)}${avgOOS.toFixed(1)}%, needs optimization)`;
  } else {
    verdict = `❌ Possible overfit (IS ${sign(avgIS)}${avgIS.toFixed(1)}% vs OOS ${sign(avgOOS)}${avgOOS.toFixed(1)}%)`;
  }

  return {
    symbol,
    totalFolds: foldResults.length,
    folds: foldResults,
    avgOutOfSampleReturn: avgOOS,
    avgInSampleReturn: avgIS,
    consistency,
    robust,
    verdict,
  };
}

// ─── Parameter Sensitivity ───────────────────────────────────────

export interface SensitivityParam {
  name: string;
  path: string;           // Config path (e.g. "strategy.ma.short")
  values: number[];       // Parameter values to test
}

/**
 * Grid search for a single parameter.
 * @param klines  Full klines (same data for fair comparison)
 * @param baseCfg Base config
 * @param symbol  Trading pair
 * @param param   Parameter to vary
 */
export function runSensitivity(
  klines: Kline[],
  baseCfg: StrategyConfig,
  symbol: string,
  param: SensitivityParam
): SensitivityReport {
  const results: SensitivityResult[] = [];
  const singleCfg = { ...baseCfg, symbols: [symbol] };

  for (const value of param.values) {
    const cfg = deepSetPath(
      JSON.parse(JSON.stringify(singleCfg)) as StrategyConfig,
      param.path,
      value
    );
    try {
      const result = runBacktest({ [symbol]: klines }, cfg);
      results.push({
        paramName: param.name,
        paramValue: value,
        totalReturnPct: result.metrics.totalReturnPercent,
        sharpe: result.metrics.sharpeRatio,
        maxDrawdown: result.metrics.maxDrawdown,
        totalTrades: result.metrics.totalTrades,
      });
    } catch {
      // Invalid parameter, skip
    }
  }

  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
  const best = sorted[0];
  const positiveCount = results.filter((r) => r.totalReturnPct > 0).length;
  const robustPct = results.length > 0 ? Math.round((positiveCount / results.length) * 100) : 0;

  let verdict: string;
  if (robustPct >= 70) {
    verdict = `✅ Parameter robust (${robustPct}% of values profitable, not sensitive)`;
  } else if (robustPct >= 40) {
    verdict = `⚠️ Moderately stable (${robustPct}% profitable, recommend picking mid-range value)`;
  } else {
    verdict = `❌ Parameter sensitive (only ${robustPct}% profitable, possible overfit)`;
  }

  return {
    paramName: param.name,
    results,
    bestValue: best?.paramValue ?? param.values[0] ?? 0,
    robustPct,
    verdict,
  };
}

// ─── Monte Carlo ────────────────────────────────────────

export interface MonteCarloResult {
  iterations: number;
  avgReturn: number;
  medianReturn: number;
  p5Return: number;          // 5th percentile (worst 5% scenario)
  p95Return: number;         // 95th percentile
  p5MaxDrawdown: number;     // Worst 5% scenario max drawdown
  verdict: string;
}

/**
 * Monte Carlo simulation: randomly shuffle trade order N times to assess true risk.
 * @param trades  Trade list (only returnPct field needed)
 * @param iterations  Number of simulations (default 1000)
 */
export function runMonteCarlo(
  trades: { returnPct: number }[],
  iterations = 1000
): MonteCarloResult {
  if (trades.length === 0) {
    return {
      iterations: 0, avgReturn: 0, medianReturn: 0,
      p5Return: 0, p95Return: 0, p5MaxDrawdown: 0,
      verdict: "No trade data, cannot simulate"
    };
  }

  const finalReturns: number[] = [];
  const maxDrawdowns: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const shuffled = [...trades].sort(() => Math.random() - 0.5);

    let equity = 100;
    let peak = 100;
    let maxDD = 0;

    for (const trade of shuffled) {
      equity *= (1 + trade.returnPct / 100);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    finalReturns.push(equity - 100);
    maxDrawdowns.push(maxDD * 100);
  }

  finalReturns.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => b - a);

  const avg = finalReturns.reduce((a, b) => a + b, 0) / finalReturns.length;
  const median = finalReturns[Math.floor(finalReturns.length * 0.5)] ?? 0;
  const p5 = finalReturns[Math.floor(finalReturns.length * 0.05)] ?? 0;
  const p95 = finalReturns[Math.floor(finalReturns.length * 0.95)] ?? 0;
  const p5DD = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.05)] ?? 0;

  const sign = (n: number) => (n >= 0 ? "+" : "");
  let verdict: string;
  if (p5 > -10 && p5DD < 20) {
    verdict = `✅ Risk manageable (worst 5%: ${sign(p5)}${p5.toFixed(1)}%, max drawdown ${p5DD.toFixed(1)}%)`;
  } else if (p5 > -20) {
    verdict = `⚠️ Moderate risk (worst 5%: ${sign(p5)}${p5.toFixed(1)}%, watch position sizing)`;
  } else {
    verdict = `❌ Risk too high (worst 5%: ${sign(p5)}${p5.toFixed(1)}%, not recommended for live trading)`;
  }

  return { iterations, avgReturn: avg, medianReturn: median, p5Return: p5, p95Return: p95, p5MaxDrawdown: p5DD, verdict };
}

// ─── Formatting ───────────────────────────────────────────

export function formatWalkForwardReport(results: WalkForwardResult[]): string {
  const lines: string[] = ["📊 **Walk-Forward Validation Report**\n"];
  const sign = (n: number) => (n >= 0 ? "+" : "");

  for (const r of results) {
    const coin = r.symbol.replace("USDT", "");
    lines.push(`**${coin}** — ${r.verdict}`);
    lines.push(`  IS avg: ${sign(r.avgInSampleReturn)}${r.avgInSampleReturn.toFixed(1)}% | OOS avg: ${sign(r.avgOutOfSampleReturn)}${r.avgOutOfSampleReturn.toFixed(1)}%`);
    for (const f of r.folds) {
      const emoji = f.outOfSampleReturn > 0 ? "✅" : "❌";
      lines.push(`  Fold ${f.foldIndex + 1}: ${emoji} OOS ${sign(f.outOfSampleReturn)}${f.outOfSampleReturn.toFixed(1)}%  (${f.outOfSampleTrades} trades, win rate ${(f.outOfSampleWinRate * 100).toFixed(0)}%)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatSensitivityReport(r: SensitivityReport): string {
  const lines: string[] = [`📊 **Parameter Sensitivity: ${r.paramName}**\n${r.verdict}\nBest value: ${r.bestValue}\n`];
  for (const row of r.results) {
    const emoji = row.totalReturnPct > 0 ? "✅" : "❌";
    const sign = row.totalReturnPct >= 0 ? "+" : "";
    lines.push(`  ${String(row.paramValue).padStart(5)}: ${emoji} ${sign}${row.totalReturnPct.toFixed(1)}%  Sharpe ${row.sharpe.toFixed(2)}  DD ${row.maxDrawdown.toFixed(1)}%`);
  }
  return lines.join("\n");
}

export function formatMonteCarloReport(r: MonteCarloResult): string {
  const sign = (n: number) => (n >= 0 ? "+" : "");
  return [
    `🎲 **Monte Carlo Simulation (${r.iterations} iterations)**`,
    r.verdict,
    `Avg return: ${sign(r.avgReturn)}${r.avgReturn.toFixed(1)}%  Median: ${sign(r.medianReturn)}${r.medianReturn.toFixed(1)}%`,
    `5th->95th range: ${sign(r.p5Return)}${r.p5Return.toFixed(1)}% -> ${sign(r.p95Return)}${r.p95Return.toFixed(1)}%`,
    `Worst 5% max drawdown: ${r.p5MaxDrawdown.toFixed(1)}%`,
  ].join("\n");
}

// ─── Utility Functions ─────────────────────────────────────────

function deepSetPath(obj: StrategyConfig, path: string, value: unknown): StrategyConfig {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1] ?? ""] = value;
  return obj;
}

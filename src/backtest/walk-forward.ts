/**
 * Walk-Forward 回测 + 参数敏感性 + 蒙特卡洛
 *
 * Walk-Forward 解决的问题：
 *   用全部历史数据找到「最好」的参数，然后用这组参数测试同样的历史
 *   = 过拟合（未来永远不会有和历史完全一样的行情）
 *
 * 正确做法：
 *   把数据按时间切成 N 折，前几折优化参数，最后一折验证（折外 OOS）
 *   只有折外收益持续为正，策略才有统计意义
 */

import { runBacktest } from "./runner.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─── 类型定义 ──────────────────────────────────────────

export interface WalkForwardFold {
  foldIndex: number;
  trainBars: number;         // 训练集 K 线数量
  testBars: number;          // 验证集 K 线数量
  inSampleReturn: number;    // 训练集收益率 %
  outOfSampleReturn: number; // 验证集收益率 %（核心指标）
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
  consistency: number;    // 折外正收益折数 / 总折数
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
  robustPct: number;         // % 参数值产生正收益
  verdict: string;
}

// ─── Walk-Forward ─────────────────────────────────────

/**
 * 对单个 symbol 的 klines 执行 Walk-Forward 分析
 *
 * @param klines     完整历史 K 线（已排序，最早在前）
 * @param cfg        策略配置（symbols 中只取该 symbol）
 * @param symbol     交易对
 * @param folds      折数（默认 5）
 * @param trainRatio 每折中训练集比例（默认 0.7 = 70% 训练，30% 验证）
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

  // 滚动窗口：每次向前移动一折
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
    verdict = `✅ 稳健（折外均值 ${sign(avgOOS)}${avgOOS.toFixed(1)}%，${Math.round(consistency * 100)}% 折次正收益）`;
  } else if (avgOOS > -3 && consistency >= 0.4) {
    verdict = `⚠️ 一般（折外均值 ${sign(avgOOS)}${avgOOS.toFixed(1)}%，需优化）`;
  } else {
    verdict = `❌ 疑似过拟合（折内 ${sign(avgIS)}${avgIS.toFixed(1)}% vs 折外 ${sign(avgOOS)}${avgOOS.toFixed(1)}%）`;
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

// ─── 参数敏感性 ───────────────────────────────────────

export interface SensitivityParam {
  name: string;
  path: string;           // 配置路径（如 "strategy.ma.short"）
  values: number[];       // 要测试的参数值
}

/**
 * 对单个参数做网格搜索
 * @param klines  完整 klines（用同一份数据，公平对比）
 * @param baseCfg 基础配置
 * @param symbol  交易对
 * @param param   要变化的参数
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
      // 无效参数，跳过
    }
  }

  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
  const best = sorted[0];
  const positiveCount = results.filter((r) => r.totalReturnPct > 0).length;
  const robustPct = results.length > 0 ? Math.round((positiveCount / results.length) * 100) : 0;

  let verdict: string;
  if (robustPct >= 70) {
    verdict = `✅ 参数稳健（${robustPct}% 参数值正收益，不敏感）`;
  } else if (robustPct >= 40) {
    verdict = `⚠️ 中等稳定（${robustPct}% 正收益，建议选稳定区间中值）`;
  } else {
    verdict = `❌ 参数敏感（只有 ${robustPct}% 正收益，疑似过拟合）`;
  }

  return {
    paramName: param.name,
    results,
    bestValue: best?.paramValue ?? param.values[0]!,
    robustPct,
    verdict,
  };
}

// ─── 蒙特卡洛 ────────────────────────────────────────

export interface MonteCarloResult {
  iterations: number;
  avgReturn: number;
  medianReturn: number;
  p5Return: number;          // 5th percentile（5% 最差情况）
  p95Return: number;         // 95th percentile
  p5MaxDrawdown: number;     // 5% 最差情况的最大回撤
  verdict: string;
}

/**
 * 蒙特卡洛模拟：随机打乱交易顺序 N 次，评估真实风险
 * @param trades  交易列表（只需要 returnPct 字段）
 * @param iterations  模拟次数（默认 1000）
 */
export function runMonteCarlo(
  trades: { returnPct: number }[],
  iterations = 1000
): MonteCarloResult {
  if (trades.length === 0) {
    return {
      iterations: 0, avgReturn: 0, medianReturn: 0,
      p5Return: 0, p95Return: 0, p5MaxDrawdown: 0,
      verdict: "无交易数据，无法模拟"
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
  const median = finalReturns[Math.floor(finalReturns.length * 0.5)]!;
  const p5 = finalReturns[Math.floor(finalReturns.length * 0.05)]!;
  const p95 = finalReturns[Math.floor(finalReturns.length * 0.95)]!;
  const p5DD = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.05)]!;

  const sign = (n: number) => (n >= 0 ? "+" : "");
  let verdict: string;
  if (p5 > -10 && p5DD < 20) {
    verdict = `✅ 风险可控（最坏 5% 场景: ${sign(p5)}${p5.toFixed(1)}%，最大回撤 ${p5DD.toFixed(1)}%）`;
  } else if (p5 > -20) {
    verdict = `⚠️ 风险中等（最坏 5%: ${sign(p5)}${p5.toFixed(1)}%，注意仓位管理）`;
  } else {
    verdict = `❌ 风险过高（最坏 5%: ${sign(p5)}${p5.toFixed(1)}%，不建议实盘）`;
  }

  return { iterations, avgReturn: avg, medianReturn: median, p5Return: p5, p95Return: p95, p5MaxDrawdown: p5DD, verdict };
}

// ─── 格式化 ───────────────────────────────────────────

export function formatWalkForwardReport(results: WalkForwardResult[]): string {
  const lines: string[] = ["📊 **Walk-Forward 验证报告**\n"];
  const sign = (n: number) => (n >= 0 ? "+" : "");

  for (const r of results) {
    const coin = r.symbol.replace("USDT", "");
    lines.push(`**${coin}** — ${r.verdict}`);
    lines.push(`  折内均值: ${sign(r.avgInSampleReturn)}${r.avgInSampleReturn.toFixed(1)}% | 折外均值: ${sign(r.avgOutOfSampleReturn)}${r.avgOutOfSampleReturn.toFixed(1)}%`);
    for (const f of r.folds) {
      const emoji = f.outOfSampleReturn > 0 ? "✅" : "❌";
      lines.push(`  Fold ${f.foldIndex + 1}: ${emoji} OOS ${sign(f.outOfSampleReturn)}${f.outOfSampleReturn.toFixed(1)}%  (${f.outOfSampleTrades} 笔，胜率 ${(f.outOfSampleWinRate * 100).toFixed(0)}%)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatSensitivityReport(r: SensitivityReport): string {
  const lines: string[] = [`📊 **参数敏感性：${r.paramName}**\n${r.verdict}\n最优值: ${r.bestValue}\n`];
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
    `🎲 **蒙特卡洛模拟（${r.iterations} 次）**`,
    r.verdict,
    `平均收益: ${sign(r.avgReturn)}${r.avgReturn.toFixed(1)}%  中位数: ${sign(r.medianReturn)}${r.medianReturn.toFixed(1)}%`,
    `5th→95th 区间: ${sign(r.p5Return)}${r.p5Return.toFixed(1)}% → ${sign(r.p95Return)}${r.p95Return.toFixed(1)}%`,
    `最坏 5% 最大回撤: ${r.p5MaxDrawdown.toFixed(1)}%`,
  ].join("\n");
}

// ─── 工具函数 ─────────────────────────────────────────

function deepSetPath(obj: StrategyConfig, path: string, value: unknown): StrategyConfig {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
  return obj;
}

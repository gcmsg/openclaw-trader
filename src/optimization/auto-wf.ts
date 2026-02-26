/**
 * P6.6 Auto Walk-Forward — 自动 Walk-Forward 优化调度器
 *
 * 定期对每个监控币种运行 Hyperopt，若 OOS 表现显著优于当前参数，
 * 则自动更新配置并返回报告。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse, stringify } from "yaml";
import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { loadStrategyConfig } from "../config/loader.js";
import { BayesianOptimizer, splitKlines } from "../optimization/bayesian.js";
import { evaluateParams, applyParams } from "../optimization/objective.js";
import { DEFAULT_PARAM_SPACE } from "../optimization/param-space.js";
import type { StrategyConfig, Kline } from "../types.js";
import type { ParamSet } from "../optimization/param-space.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../../logs/auto-wf-state.json");
const CONFIG_FILE = path.resolve(__dirname, "../../config/strategy.yaml");

// ─────────────────────────────────────────────────────
// 公开接口
// ─────────────────────────────────────────────────────

export interface AutoWfConfig {
  symbols: string[];
  /** 历史数据天数（默认 90） */
  days: number;
  /** 每次优化轮次（默认 50） */
  trials: number;
  /** 训练集比例（默认 0.7） */
  trainRatio: number;
  /** OOS Sharpe 最小改进阈值（默认 5%，即 +5%） */
  minImprovementPct: number;
  /** true 时不写 config 文件 */
  dryRun: boolean;
  seed?: number;
}

export interface SymbolWfResult {
  symbol: string;
  /** 用当前参数跑 OOS */
  currentSharpe: number;
  /** 用优化后参数跑 OOS */
  newSharpe: number;
  /** (newSharpe - currentSharpe) / |currentSharpe| * 100 */
  improvementPct: number;
  bestParams: ParamSet;
  /** 是否实际更新了配置 */
  updated: boolean;
  /** 如果该币种失败 */
  error?: string;
}

export interface AutoWfReport {
  /** ISO timestamp */
  runAt: string;
  results: SymbolWfResult[];
  updatedCount: number;
  failedCount: number;
}

export interface AutoWfState {
  lastRun: string;
  bySymbol: Record<string, { lastRun: string; bestParams: ParamSet; bestSharpe: number }>;
}

// ─────────────────────────────────────────────────────
// State 管理
// ─────────────────────────────────────────────────────

export function loadAutoWfState(): AutoWfState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as AutoWfState;
  } catch {
    return {
      lastRun: "",
      bySymbol: {},
    };
  }
}

export function saveAutoWfState(state: AutoWfState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────
// 报告格式化
// ─────────────────────────────────────────────────────

export function formatAutoWfReport(report: AutoWfReport): string {
  const lines: string[] = [
    `## 🔄 Auto Walk-Forward 优化报告`,
    `运行时间: ${report.runAt}`,
    `更新: ${report.updatedCount} | 失败: ${report.failedCount}`,
    ``,
  ];

  for (const r of report.results) {
    if (r.error !== undefined) {
      lines.push(`❌ **${r.symbol}**: ${r.error}`);
    } else if (r.updated) {
      lines.push(
        `✅ **${r.symbol}**: Sharpe ${r.currentSharpe.toFixed(3)} → ${r.newSharpe.toFixed(3)} (+${r.improvementPct.toFixed(1)}%)`
      );
    } else {
      lines.push(
        `⏭ **${r.symbol}**: 跳过 Sharpe ${r.currentSharpe.toFixed(3)} → ${r.newSharpe.toFixed(3)} (${r.improvementPct.toFixed(1)}%)`
      );
    }
  }

  lines.push(``, `总计已更新: ${report.updatedCount}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// 配置更新
// ─────────────────────────────────────────────────────

function updateConfigFile(bestParams: ParamSet, baseCfg: StrategyConfig): void {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  const cfg = parse(raw) as Record<string, unknown>;

  const newCfg = applyParams(bestParams, baseCfg);

  const strategy = cfg["strategy"] as Record<string, unknown>;
  const ma = strategy["ma"] as Record<string, unknown>;
  const rsi = strategy["rsi"] as Record<string, unknown>;
  const risk = cfg["risk"] as Record<string, unknown>;

  ma["short"] = newCfg.strategy.ma.short;
  ma["long"] = newCfg.strategy.ma.long;
  rsi["period"] = newCfg.strategy.rsi.period;
  rsi["overbought"] = newCfg.strategy.rsi.overbought;
  rsi["oversold"] = newCfg.strategy.rsi.oversold;
  risk["stop_loss_percent"] = newCfg.risk.stop_loss_percent;
  risk["take_profit_percent"] = newCfg.risk.take_profit_percent;
  risk["position_ratio"] = newCfg.risk.position_ratio;

  fs.writeFileSync(CONFIG_FILE, stringify(cfg));
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

/**
 * 对每个 symbol 运行 Walk-Forward 优化：
 * 1. fetch K 线数据（days 天）
 * 2. splitKlines(klines, trainRatio) → { train, test }
 * 3. 用当前配置参数在 test 集上跑 evaluateParams → currentSharpe
 * 4. 用 BayesianOptimizer 在 train 集上优化（trials 轮）→ bestParams
 * 5. 用 bestParams 在 test 集上跑 → newSharpe
 * 6. 计算 improvementPct
 * 7. 如果 improvementPct >= minImprovementPct 且 newSharpe > 0 且 !dryRun → 更新配置
 */
export async function runAutoWalkForward(
  cfg: AutoWfConfig,
  baseCfg?: StrategyConfig
): Promise<AutoWfReport> {
  const stratCfg = baseCfg ?? loadStrategyConfig();
  const results: SymbolWfResult[] = [];

  for (const symbol of cfg.symbols) {
    try {
      // ── 1. 拉取 K 线数据 ────────────────────────────
      const endMs = Date.now();
      const startMs = endMs - cfg.days * 86_400_000;
      const klines: Kline[] = await fetchHistoricalKlines(
        symbol,
        stratCfg.timeframe,
        startMs,
        endMs
      );

      // ── 2. 数据分割 ──────────────────────────────────
      const { train, test } = splitKlines(klines, cfg.trainRatio);

      // ── 3. 当前参数在测试集上的表现 ─────────────────
      const currentParams: ParamSet = {
        ma_short: stratCfg.strategy.ma.short,
        ma_long: stratCfg.strategy.ma.long,
        rsi_period: stratCfg.strategy.rsi.period,
        rsi_overbought: stratCfg.strategy.rsi.overbought,
        rsi_oversold: stratCfg.strategy.rsi.oversold,
        stop_loss_pct: stratCfg.risk.stop_loss_percent,
        take_profit_pct: stratCfg.risk.take_profit_percent,
        position_ratio: stratCfg.risk.position_ratio,
      };
      const testCache = new Map<string, Kline[]>([[symbol, test]]);
      const { metrics: currentMetrics } = await evaluateParams(
        currentParams,
        symbol,
        stratCfg,
        testCache
      );
      const currentSharpe = currentMetrics.sharpeRatio;

      // ── 4. 在训练集上运行 Bayesian 优化 ─────────────
      const trainCache = new Map<string, Kline[]>([[symbol, train]]);
      const warmup = Math.min(20, Math.floor(cfg.trials * 0.2));
      const optimizer = new BayesianOptimizer(DEFAULT_PARAM_SPACE, cfg.seed, warmup);

      for (let i = 0; i < cfg.trials; i++) {
        const params = optimizer.suggest();
        const { score } = await evaluateParams(params, symbol, stratCfg, trainCache);
        optimizer.observe(params, score);
      }

      const best = optimizer.best();
      const bestParams: ParamSet = best?.params ?? currentParams;

      // ── 5. 用最优参数在测试集上验证 ─────────────────
      const newTestCache = new Map<string, Kline[]>([[symbol, test]]);
      const { metrics: newMetrics } = await evaluateParams(
        bestParams,
        symbol,
        stratCfg,
        newTestCache
      );
      const newSharpe = newMetrics.sharpeRatio;

      // ── 6. 计算改进幅度 ──────────────────────────────
      const denominator = Math.abs(currentSharpe) > 0 ? Math.abs(currentSharpe) : 1;
      const improvementPct = ((newSharpe - currentSharpe) / denominator) * 100;

      // ── 7. 决策：是否更新配置 ────────────────────────
      const shouldUpdate =
        improvementPct >= cfg.minImprovementPct && newSharpe > 0 && !cfg.dryRun;

      if (shouldUpdate) {
        updateConfigFile(bestParams, stratCfg);
      }

      results.push({
        symbol,
        currentSharpe,
        newSharpe,
        improvementPct,
        bestParams,
        updated: shouldUpdate,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        symbol,
        currentSharpe: 0,
        newSharpe: 0,
        improvementPct: 0,
        bestParams: {},
        updated: false,
        error: errorMsg,
      });
    }
  }

  const updatedCount = results.filter((r) => r.updated).length;
  const failedCount = results.filter((r) => r.error !== undefined).length;

  return {
    runAt: new Date().toISOString(),
    results,
    updatedCount,
    failedCount,
  };
}

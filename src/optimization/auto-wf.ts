/**
 * P6.6 Auto Walk-Forward — Automatic Walk-Forward Optimization Scheduler
 *
 * Periodically runs Hyperopt for each monitored symbol. If OOS performance
 * significantly outperforms current parameters, auto-updates config and returns a report.
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
// Public Interface
// ─────────────────────────────────────────────────────

export interface AutoWfConfig {
  symbols: string[];
  /** Historical data days (default 90) */
  days: number;
  /** Optimization trials per run (default 50) */
  trials: number;
  /** Training set ratio (default 0.7) */
  trainRatio: number;
  /** OOS Sharpe minimum improvement threshold (default 5%, i.e. +5%) */
  minImprovementPct: number;
  /** When true, do not write config file */
  dryRun: boolean;
  seed?: number;
}

export interface SymbolWfResult {
  symbol: string;
  /** OOS result with current parameters */
  currentSharpe: number;
  /** OOS result with optimized parameters */
  newSharpe: number;
  /** (newSharpe - currentSharpe) / |currentSharpe| * 100 */
  improvementPct: number;
  bestParams: ParamSet;
  /** Whether the config was actually updated */
  updated: boolean;
  /** Error message if this symbol failed */
  error?: string;
}

export interface AutoWfReport {
  /** ISO timestamp of this run */
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
// State Management
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
// Report Formatting
// ─────────────────────────────────────────────────────

export function formatAutoWfReport(report: AutoWfReport): string {
  const lines: string[] = [
    `## 🔄 Auto Walk-Forward Optimization Report`,
    `Run time: ${report.runAt}`,
    `Updated: ${report.updatedCount} | Failed: ${report.failedCount}`,
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
        `⏭ **${r.symbol}**: Skipped Sharpe ${r.currentSharpe.toFixed(3)} → ${r.newSharpe.toFixed(3)} (${r.improvementPct.toFixed(1)}%)`
      );
    }
  }

  lines.push(``, `Total updated: ${report.updatedCount}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// Config Update
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

  const tmpFile = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmpFile, stringify(cfg));
  fs.renameSync(tmpFile, CONFIG_FILE); // Atomic write to prevent crash from corrupting main config file
}

// ─────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────

/**
 * Run Walk-Forward optimization for each symbol:
 * 1. Fetch kline data (days days)
 * 2. splitKlines(klines, trainRatio) -> { train, test }
 * 3. Evaluate current config params on test set via evaluateParams -> currentSharpe
 * 4. Run BayesianOptimizer on train set (trials rounds) -> bestParams
 * 5. Evaluate bestParams on test set -> newSharpe
 * 6. Calculate improvementPct
 * 7. If improvementPct >= minImprovementPct and newSharpe > 0 and !dryRun -> update config
 */
export async function runAutoWalkForward(
  cfg: AutoWfConfig,
  baseCfg?: StrategyConfig
): Promise<AutoWfReport> {
  const stratCfg = baseCfg ?? loadStrategyConfig();
  const results: SymbolWfResult[] = [];

  for (const symbol of cfg.symbols) {
    try {
      // ── 1. Fetch kline data ────────────────────────────
      const endMs = Date.now();
      const startMs = endMs - cfg.days * 86_400_000;
      const klines: Kline[] = await fetchHistoricalKlines(
        symbol,
        stratCfg.timeframe,
        startMs,
        endMs
      );

      // ── 2. Data split ──────────────────────────────────
      const { train, test } = splitKlines(klines, cfg.trainRatio);

      // ── 3. Current params performance on test set ─────
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

      // ── 4. Run Bayesian optimization on train set ─────
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

      // ── 5. Validate best params on test set ────────────
      const newTestCache = new Map<string, Kline[]>([[symbol, test]]);
      const { metrics: newMetrics } = await evaluateParams(
        bestParams,
        symbol,
        stratCfg,
        newTestCache
      );
      const newSharpe = newMetrics.sharpeRatio;

      // ── 6. Calculate improvement ──────────────────────
      const denominator = Math.abs(currentSharpe) > 0 ? Math.abs(currentSharpe) : 1;
      const improvementPct = ((newSharpe - currentSharpe) / denominator) * 100;

      // ── 7. Decision: whether to update config ─────────
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

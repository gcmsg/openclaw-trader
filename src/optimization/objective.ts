/**
 * P6.1 Hyperopt — 目标函数
 *
 * 给定一组参数，在历史数据上跑回测，返回优化目标分数。
 * 目标：最大化 Sharpe Ratio，惩罚高回撤。
 * score = sharpe - 0.5 * maxDrawdownPct
 */

import { runBacktest } from "../backtest/runner.js";
import type { StrategyConfig, Kline } from "../types.js";
import type { BacktestMetrics } from "../backtest/metrics.js";
import type { ParamSet } from "./param-space.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface EvalResult {
  score: number;
  metrics: BacktestMetrics;
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

/**
 * 对一组参数进行回测评估，返回优化目标分数。
 *
 * @param params       当前候选参数
 * @param symbol       交易对（如 "BTCUSDT"）
 * @param baseCfg      基础配置（来自 strategy.yaml）
 * @param klineCache   预加载的 K 线缓存（key = symbol，value = 全量 K 线）
 * @returns            { score, metrics }
 */
export async function evaluateParams(
  params: ParamSet,
  symbol: string,
  baseCfg: StrategyConfig,
  klineCache: Map<string, Kline[]>
): Promise<EvalResult> {
  // ── 1. 约束检查：ma_short < ma_long ──────────────
  const maShort = params["ma_short"] ?? baseCfg.strategy.ma.short;
  const maLong  = params["ma_long"]  ?? baseCfg.strategy.ma.long;
  if (maShort >= maLong) {
    return { score: -999, metrics: makeDummyMetrics() };
  }

  // ── 2. 将 params 覆盖到 baseCfg ──────────────────
  const cfg = applyParams(params, baseCfg);

  // ── 3. 准备 K 线数据 ─────────────────────────────
  const klines = klineCache.get(symbol);
  if (!klines || klines.length === 0) {
    throw new Error(`klineCache 中没有 ${symbol} 的数据`);
  }

  const klinesBySymbol: Record<string, Kline[]> = { [symbol]: klines };

  // ── 4. 跑回测（同步封装） ────────────────────────
  let result;
  try {
    result = runBacktest(klinesBySymbol, cfg, {
      initialUsdt: 1000,
      feeRate: 0.001,
      slippagePercent: 0.05,
    });
  } catch (_err) {
    return { score: -999, metrics: makeDummyMetrics() };
  }

  const { metrics } = result;

  // ── 5. 计算 score ────────────────────────────────
  // score = sharpe - 0.5 * maxDrawdown%
  // maxDrawdown 已经是百分比（如 12 表示 12%）
  const score = metrics.sharpeRatio - 0.5 * (metrics.maxDrawdown / 100);

  return { score, metrics };
}

// ─────────────────────────────────────────────────────
// 参数覆盖
// ─────────────────────────────────────────────────────

/**
 * 将优化参数覆盖到基础配置，返回新的 StrategyConfig（不修改原始配置）
 */
export function applyParams(params: ParamSet, baseCfg: StrategyConfig): StrategyConfig {
  return {
    ...baseCfg,
    strategy: {
      ...baseCfg.strategy,
      ma: {
        short: Math.round(params["ma_short"] ?? baseCfg.strategy.ma.short),
        long:  Math.round(params["ma_long"]  ?? baseCfg.strategy.ma.long),
      },
      rsi: {
        ...baseCfg.strategy.rsi,
        period:     Math.round(params["rsi_period"]     ?? baseCfg.strategy.rsi.period),
        overbought: params["rsi_overbought"] ?? baseCfg.strategy.rsi.overbought,
        oversold:   params["rsi_oversold"]   ?? baseCfg.strategy.rsi.oversold,
      },
    },
    risk: {
      ...baseCfg.risk,
      stop_loss_percent:   params["stop_loss_pct"]   ?? baseCfg.risk.stop_loss_percent,
      take_profit_percent: params["take_profit_pct"] ?? baseCfg.risk.take_profit_percent,
      position_ratio:      params["position_ratio"]  ?? baseCfg.risk.position_ratio,
    },
  };
}

// ─────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────

function makeDummyMetrics(): BacktestMetrics {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalReturn: 0,
    totalReturnPercent: 0,
    maxDrawdown: 0,
    maxDrawdownUsdt: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    profitFactor: 0,
    avgWinPercent: 0,
    avgLossPercent: 0,
    winLossRatio: 0,
    avgHoldingHours: 0,
    stopLossCount: 0,
    takeProfitCount: 0,
    trailingStopCount: 0,
    signalExitCount: 0,
    endOfDataCount: 0,
    bestTradePct: 0,
    worstTradePct: 0,
    calmarRatio: 0,
    equityCurve: [],
  };
}

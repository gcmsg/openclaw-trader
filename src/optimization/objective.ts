/**
 * P6.1 Hyperopt — Objective Function
 *
 * Given a set of parameters, run backtest on historical data and return optimization score.
 * Objective: Maximize Sharpe Ratio, penalize high drawdown.
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
// Main function
// ─────────────────────────────────────────────────────

/**
 * Evaluate a set of parameters via backtest and return optimization score.
 *
 * @param params       Current candidate parameters
 * @param symbol       Trading pair (e.g. "BTCUSDT")
 * @param baseCfg      Base config (from strategy.yaml)
 * @param klineCache   Pre-loaded kline cache (key = symbol, value = full klines)
 * @returns            { score, metrics }
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function evaluateParams(
  params: ParamSet,
  symbol: string,
  baseCfg: StrategyConfig,
  klineCache: Map<string, Kline[]>
): Promise<EvalResult> {
  // ── 1. Constraint check: ma_short < ma_long ──────────────
  const maShort = params["ma_short"] ?? baseCfg.strategy.ma.short;
  const maLong  = params["ma_long"]  ?? baseCfg.strategy.ma.long;
  if (maShort >= maLong) {
    return { score: -999, metrics: makeDummyMetrics() };
  }

  // ── 2. Apply params override to baseCfg ──────────────────
  const cfg = applyParams(params, baseCfg);

  // ── 3. Prepare kline data ─────────────────────────────
  const klines = klineCache.get(symbol);
  if (!klines || klines.length === 0) {
    throw new Error(`No data for ${symbol} in klineCache`);
  }

  const klinesBySymbol: Record<string, Kline[]> = { [symbol]: klines };

  // ── 4. Run backtest (sync wrapper) ────────────────────────
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

  // ── 5. Calculate score ────────────────────────────────
  // score = sharpe - 0.5 * maxDrawdown%
  // maxDrawdown is already a percentage (e.g. 12 means 12%)
  const score = metrics.sharpeRatio - 0.5 * (metrics.maxDrawdown / 100);

  return { score, metrics };
}

// ─────────────────────────────────────────────────────
// Parameter override
// ─────────────────────────────────────────────────────

/**
 * Apply optimization parameters over base config, returning a new StrategyConfig (does not modify the original).
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
// Utilities
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

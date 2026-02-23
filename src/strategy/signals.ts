import type { Indicators, Signal, StrategyConfig } from "../types.js";

type SignalChecker = (ind: Indicators, cfg: StrategyConfig) => boolean;

/** 所有可用的信号检测函数 */
const SIGNAL_CHECKERS: Record<string, SignalChecker> = {
  /** MA 金叉：短期上穿长期 */
  ma_golden_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort <= ind.prevMaLong && // 前一根：短 <= 长
    ind.maShort > ind.maLong,            // 当前：短 > 长（上穿）

  /** MA 死叉：短期下穿长期 */
  ma_death_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort >= ind.prevMaLong && // 前一根：短 >= 长
    ind.maShort < ind.maLong,            // 当前：短 < 长（下穿）

  /** RSI 超卖 */
  rsi_oversold: (ind, cfg) => ind.rsi < cfg.strategy.rsi.oversold,

  /** RSI 超买 */
  rsi_overbought: (ind, cfg) => ind.rsi > cfg.strategy.rsi.overbought,

  /** MA 短期 > 长期（多头趋势） */
  ma_bullish: (ind) => ind.maShort > ind.maLong,

  /** MA 短期 < 长期（空头趋势） */
  ma_bearish: (ind) => ind.maShort < ind.maLong,
};

/** 检测信号 */
export function detectSignal(
  symbol: string,
  indicators: Indicators,
  cfg: StrategyConfig
): Signal {
  const buyConditions = cfg.signals.buy;
  const sellConditions = cfg.signals.sell;

  // 检查买入条件（需全部满足）
  const buyReasons: string[] = [];
  const buyMet = buyConditions.every((name) => {
    const checker = SIGNAL_CHECKERS[name];
    if (!checker) return false;
    const met = checker(indicators, cfg);
    if (met) buyReasons.push(name);
    return met;
  });

  if (buyMet && buyConditions.length > 0) {
    return {
      symbol,
      type: "buy",
      price: indicators.price,
      indicators,
      reason: buyReasons,
      timestamp: Date.now(),
    };
  }

  // 检查卖出条件（需全部满足）
  const sellReasons: string[] = [];
  const sellMet = sellConditions.every((name) => {
    const checker = SIGNAL_CHECKERS[name];
    if (!checker) return false;
    const met = checker(indicators, cfg);
    if (met) sellReasons.push(name);
    return met;
  });

  if (sellMet && sellConditions.length > 0) {
    return {
      symbol,
      type: "sell",
      price: indicators.price,
      indicators,
      reason: sellReasons,
      timestamp: Date.now(),
    };
  }

  return {
    symbol,
    type: "none",
    price: indicators.price,
    indicators,
    reason: [],
    timestamp: Date.now(),
  };
}

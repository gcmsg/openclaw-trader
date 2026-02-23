import type { Indicators, Signal, StrategyConfig } from "../types.js";

type SignalChecker = (ind: Indicators, cfg: StrategyConfig) => boolean;

/** 所有可用的信号检测函数 */
const SIGNAL_CHECKERS: Record<string, SignalChecker> = {
  // ── MA 趋势 ──────────────────────────────────────
  /** MA 金叉：短期上穿长期 */
  ma_golden_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort <= ind.prevMaLong &&
    ind.maShort > ind.maLong,

  /** MA 死叉：短期下穿长期 */
  ma_death_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort >= ind.prevMaLong &&
    ind.maShort < ind.maLong,

  /** MA 短期 > 长期（多头趋势） */
  ma_bullish: (ind) => ind.maShort > ind.maLong,

  /** MA 短期 < 长期（空头趋势） */
  ma_bearish: (ind) => ind.maShort < ind.maLong,

  // ── RSI ─────────────────────────────────────────
  /** RSI 超卖 */
  rsi_oversold: (ind, cfg) => ind.rsi < cfg.strategy.rsi.oversold,

  /** RSI 超买 */
  rsi_overbought: (ind, cfg) => ind.rsi > cfg.strategy.rsi.overbought,

  // ── MACD ────────────────────────────────────────
  /** MACD 金叉：MACD 线上穿信号线 */
  macd_golden_cross: (ind) =>
    !!ind.macd &&
    ind.macd.prevMacd !== undefined &&
    ind.macd.prevSignal !== undefined &&
    ind.macd.prevMacd <= ind.macd.prevSignal &&
    ind.macd.macd > ind.macd.signal,

  /** MACD 死叉：MACD 线下穿信号线 */
  macd_death_cross: (ind) =>
    !!ind.macd &&
    ind.macd.prevMacd !== undefined &&
    ind.macd.prevSignal !== undefined &&
    ind.macd.prevMacd >= ind.macd.prevSignal &&
    ind.macd.macd < ind.macd.signal,

  /** MACD 多头：MACD 线 > 信号线，且柱状图为正 */
  macd_bullish: (ind) =>
    !!ind.macd &&
    ind.macd.macd > ind.macd.signal &&
    ind.macd.histogram > 0,

  /** MACD 空头：MACD 线 < 信号线，且柱状图为负 */
  macd_bearish: (ind) =>
    !!ind.macd &&
    ind.macd.macd < ind.macd.signal &&
    ind.macd.histogram < 0,

  /** MACD 柱状图扩张（趋势加速） */
  macd_histogram_expanding: (ind) =>
    !!ind.macd &&
    ind.macd.prevHistogram !== undefined &&
    Math.abs(ind.macd.histogram) > Math.abs(ind.macd.prevHistogram),

  // ── 成交量 ──────────────────────────────────────
  /** 成交量放量（当前 > 均量 1.5 倍） */
  volume_surge: (ind, cfg) => {
    const threshold = cfg.strategy.volume?.surge_ratio ?? 1.5;
    return ind.avgVolume > 0 && ind.volume >= ind.avgVolume * threshold;
  },

  /** 成交量萎缩（当前 < 均量 0.5 倍，信号可信度低） */
  volume_low: (ind, cfg) => {
    const threshold = cfg.strategy.volume?.low_ratio ?? 0.5;
    return ind.avgVolume > 0 && ind.volume <= ind.avgVolume * threshold;
  },
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

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
  /** RSI 超卖（RSI < oversold 阈值） */
  rsi_oversold: (ind, cfg) => ind.rsi < cfg.strategy.rsi.oversold,

  /** RSI 超买（RSI > overbought 阈值） */
  rsi_overbought: (ind, cfg) => ind.rsi > cfg.strategy.rsi.overbought,

  /** RSI 未超买（RSI < overbought 阈值）——趋势跟随策略的买入过滤条件 */
  rsi_not_overbought: (ind, cfg) => ind.rsi < cfg.strategy.rsi.overbought,

  /** RSI 未超卖（RSI > oversold 阈值）——避免在深度下跌中追加仓位 */
  rsi_not_oversold: (ind, cfg) => ind.rsi > cfg.strategy.rsi.oversold,

  /** RSI 中性偏多（RSI 40–overbought 区间）——有动能但尚未过热 */
  rsi_bullish_zone: (ind, cfg) => ind.rsi > 40 && ind.rsi < cfg.strategy.rsi.overbought,

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
  macd_bullish: (ind) => !!ind.macd && ind.macd.macd > ind.macd.signal && ind.macd.histogram > 0,

  /** MACD 空头：MACD 线 < 信号线，且柱状图为负 */
  macd_bearish: (ind) => !!ind.macd && ind.macd.macd < ind.macd.signal && ind.macd.histogram < 0,

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

/** 内部辅助：检查一组条件是否全部满足，返回 [是否满足, 满足的条件名列表] */
function checkConditions(
  conditions: string[],
  indicators: Indicators,
  cfg: StrategyConfig,
  label: string
): [boolean, string[]] {
  if (conditions.length === 0) return [false, []];
  const reasons: string[] = [];
  const met = conditions.every((name) => {
    const checker = SIGNAL_CHECKERS[name];
    if (!checker) {
      console.warn(`[signals] 未知${label}条件: "${name}"，请检查策略配置`);
      return false;
    }
    const ok = checker(indicators, cfg);
    if (ok) reasons.push(name);
    return ok;
  });
  return [met, reasons];
}

/**
 * 检测信号
 *
 * 优先级：buy → sell → short → cover
 * - buy/sell 管理多头持仓
 * - short/cover 管理空头持仓（仅 futures/margin 市场有意义）
 *
 * 引擎层负责根据当前持仓状态决定是否执行该信号。
 */
export function detectSignal(symbol: string, indicators: Indicators, cfg: StrategyConfig): Signal {
  const makeSignal = (
    type: Signal["type"],
    reason: string[]
  ): Signal => ({
    symbol,
    type,
    price: indicators.price,
    indicators,
    reason,
    timestamp: Date.now(),
  });

  // 1. 买入（开多）
  const [buyMet, buyReasons] = checkConditions(cfg.signals.buy, indicators, cfg, "买入");
  if (buyMet) return makeSignal("buy", buyReasons);

  // 2. 卖出（平多）
  const [sellMet, sellReasons] = checkConditions(cfg.signals.sell, indicators, cfg, "卖出");
  if (sellMet) return makeSignal("sell", sellReasons);

  // 3. 开空（short，需 signals.short 配置，引擎层还会检查市场类型）
  const shortConditions = cfg.signals.short ?? [];
  const [shortMet, shortReasons] = checkConditions(shortConditions, indicators, cfg, "开空");
  if (shortMet) return makeSignal("short", shortReasons);

  // 4. 平空（cover）
  const coverConditions = cfg.signals.cover ?? [];
  const [coverMet, coverReasons] = checkConditions(coverConditions, indicators, cfg, "平空");
  if (coverMet) return makeSignal("cover", coverReasons);

  return makeSignal("none", []);
}

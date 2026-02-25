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

  /**
   * MACD 柱状图连续收缩（动量衰竭出场）
   * 连续 3 根柱状图绝对值递减 → 趋势动能正在减弱
   * 建议配合 rsi_overbought / rsi_overbought_exit 一起作为出场条件
   */
  macd_histogram_shrinking: (ind) => {
    if (!ind.macd) return false;
    const { histogram, prevHistogram, prevPrevHistogram } = ind.macd;
    if (prevHistogram === undefined) return false;
    const twoBarShrink = Math.abs(histogram) < Math.abs(prevHistogram);
    if (prevPrevHistogram === undefined) return twoBarShrink; // 退化为两根检测
    return twoBarShrink && Math.abs(prevHistogram) < Math.abs(prevPrevHistogram);
  },

  /**
   * RSI 超买离场（动态阈值）
   * RSI 超过 overbought_exit（默认 75）→ 建议减仓/止盈
   * 比 rsi_overbought（通常70）更严格，避免过早出场
   */
  rsi_overbought_exit: (ind, cfg) => {
    const threshold = cfg.strategy.rsi.overbought_exit ?? 75;
    return ind.rsi > threshold;
  },

  // ── CVD 累计成交量差值 ──────────────────────────
  /**
   * CVD 偏多：最近 20 根 K 线净买压为正（买方主导）
   * 用于过滤假突破：价格上涨 + CVD 上升 = 真实买盘支撑
   */
  cvd_bullish: (ind) => (ind.cvd ?? 0) > 0,

  /**
   * CVD 偏空：最近 20 根 K 线净卖压为负（卖方主导）
   * 用于过滤假跌：价格下跌 + CVD 下降 = 真实卖压存在
   */
  cvd_bearish: (ind) => (ind.cvd ?? 0) < 0,

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
 * 检测信号（持仓感知版本）
 *
 * 根据当前持仓方向采用不同优先级，避免出场信号被入场信号抢占：
 *
 * - 持多头：sell（平多）优先，忽略 buy/short/cover
 * - 持空头：cover（平空）优先，忽略 sell/buy/short
 * - 无持仓：buy（开多）→ short（开空）
 *           注意：不检查 sell/cover（无仓位没意义）
 *
 * @param positionSide 当前持仓方向（undefined = 无持仓）
 */
export function detectSignal(
  symbol: string,
  indicators: Indicators,
  cfg: StrategyConfig,
  positionSide?: "long" | "short"
): Signal {
  const makeSignal = (type: Signal["type"], reason: string[]): Signal => ({
    symbol,
    type,
    price: indicators.price,
    indicators,
    reason,
    timestamp: Date.now(),
  });

  const shortConditions = cfg.signals.short ?? [];
  const coverConditions = cfg.signals.cover ?? [];

  if (positionSide === "long") {
    // 持多头：只检查平多信号
    const [sellMet, sellReasons] = checkConditions(cfg.signals.sell, indicators, cfg, "卖出");
    if (sellMet) return makeSignal("sell", sellReasons);
    return makeSignal("none", []);
  }

  if (positionSide === "short") {
    // 持空头：只检查平空信号
    const [coverMet, coverReasons] = checkConditions(coverConditions, indicators, cfg, "平空");
    if (coverMet) return makeSignal("cover", coverReasons);
    return makeSignal("none", []);
  }

  // 无持仓：检查入场信号（多头优先于空头）
  const [buyMet, buyReasons] = checkConditions(cfg.signals.buy, indicators, cfg, "买入");
  if (buyMet) return makeSignal("buy", buyReasons);

  const [shortMet, shortReasons] = checkConditions(shortConditions, indicators, cfg, "开空");
  if (shortMet) return makeSignal("short", shortReasons);

  return makeSignal("none", []);
}

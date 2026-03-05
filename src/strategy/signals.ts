import type { Indicators, Signal, StrategyConfig } from "../types.js";

type SignalChecker = (ind: Indicators, cfg: StrategyConfig) => boolean;

/** All available signal detection functions */
const SIGNAL_CHECKERS: Record<string, SignalChecker> = {
  // ── MA Trend ──────────────────────────────────────
  /** MA golden cross: short-term crosses above long-term */
  ma_golden_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort <= ind.prevMaLong &&
    ind.maShort > ind.maLong,

  /** MA death cross: short-term crosses below long-term */
  ma_death_cross: (ind) =>
    ind.prevMaShort !== undefined &&
    ind.prevMaLong !== undefined &&
    ind.prevMaShort >= ind.prevMaLong &&
    ind.maShort < ind.maLong,

  /** MA short > long (bullish trend) */
  ma_bullish: (ind) => ind.maShort > ind.maLong,

  /** MA short < long (bearish trend) */
  ma_bearish: (ind) => ind.maShort < ind.maLong,

  // ── RSI ─────────────────────────────────────────
  /** RSI oversold (RSI < oversold threshold) */
  rsi_oversold: (ind, cfg) => ind.rsi < cfg.strategy.rsi.oversold,

  /** RSI overbought (RSI > overbought threshold) */
  rsi_overbought: (ind, cfg) => ind.rsi > cfg.strategy.rsi.overbought,

  /** RSI not overbought (RSI < overbought threshold) -- trend-following buy filter */
  rsi_not_overbought: (ind, cfg) => ind.rsi < cfg.strategy.rsi.overbought,

  /** RSI not oversold (RSI > oversold threshold) -- avoid adding positions during deep drops */
  rsi_not_oversold: (ind, cfg) => ind.rsi > cfg.strategy.rsi.oversold,

  /** RSI neutral-bullish (RSI 40-overbought range) -- has momentum but not overheated yet */
  rsi_bullish_zone: (ind, cfg) => ind.rsi > 40 && ind.rsi < cfg.strategy.rsi.overbought,

  // ── MACD ────────────────────────────────────────
  /** MACD golden cross: MACD line crosses above signal line */
  macd_golden_cross: (ind) =>
    !!ind.macd &&
    ind.macd.prevMacd !== undefined &&
    ind.macd.prevSignal !== undefined &&
    ind.macd.prevMacd <= ind.macd.prevSignal &&
    ind.macd.macd > ind.macd.signal,

  /** MACD death cross: MACD line crosses below signal line */
  macd_death_cross: (ind) =>
    !!ind.macd &&
    ind.macd.prevMacd !== undefined &&
    ind.macd.prevSignal !== undefined &&
    ind.macd.prevMacd >= ind.macd.prevSignal &&
    ind.macd.macd < ind.macd.signal,

  /** MACD bullish: MACD line > signal line and histogram positive */
  macd_bullish: (ind) => !!ind.macd && ind.macd.macd > ind.macd.signal && ind.macd.histogram > 0,

  /** MACD bearish: MACD line < signal line and histogram negative */
  macd_bearish: (ind) => !!ind.macd && ind.macd.macd < ind.macd.signal && ind.macd.histogram < 0,

  /** MACD histogram expanding (trend accelerating) */
  macd_histogram_expanding: (ind) =>
    !!ind.macd &&
    ind.macd.prevHistogram !== undefined &&
    Math.abs(ind.macd.histogram) > Math.abs(ind.macd.prevHistogram),

  /**
   * MACD histogram consecutive shrinking (momentum exhaustion exit)
   * 3 consecutive decreasing histogram absolute values -> trend momentum weakening
   * Recommended to combine with rsi_overbought / rsi_overbought_exit as exit conditions
   */
  macd_histogram_shrinking: (ind) => {
    if (!ind.macd) return false;
    const { histogram, prevHistogram, prevPrevHistogram } = ind.macd;
    if (prevHistogram === undefined) return false;
    const twoBarShrink = Math.abs(histogram) < Math.abs(prevHistogram);
    if (prevPrevHistogram === undefined) return twoBarShrink; // Fallback to two-bar detection
    return twoBarShrink && Math.abs(prevHistogram) < Math.abs(prevPrevHistogram);
  },

  /**
   * RSI overbought exit (dynamic threshold)
   * RSI exceeds overbought_exit (default 75) -> suggest reducing position / take profit
   * Stricter than rsi_overbought (usually 70), avoids exiting too early
   */
  rsi_overbought_exit: (ind, cfg) => {
    const threshold = cfg.strategy.rsi.overbought_exit ?? 75;
    return ind.rsi > threshold;
  },

  // ── VWAP (Volume Weighted Average Price) ───────────────────────────
  /**
   * Price above VWAP = bulls dominate
   * Above institutional average daily cost, higher long win rate
   */
  price_above_vwap: (ind) =>
    ind.vwap !== undefined && ind.price > ind.vwap,

  /**
   * Price below VWAP = bears dominate
   * Below institutional average daily cost, higher short win rate
   */
  price_below_vwap: (ind) =>
    ind.vwap !== undefined && ind.price < ind.vwap,

  /**
   * VWAP bounce (bullish): previous kline below VWAP, current kline recovered above VWAP
   * Typical institutional accumulation signal: drops to VWAP then bounces
   */
  vwap_bounce: (ind) =>
    ind.vwap !== undefined &&
    ind.prevPrice !== undefined &&
    ind.prevPrice < ind.vwap &&
    ind.price >= ind.vwap,

  /**
   * VWAP breakdown (bearish): previous kline above VWAP, current kline broke below VWAP
   * Bulls lost the cost line = short entry signal
   */
  vwap_breakdown: (ind) =>
    ind.vwap !== undefined &&
    ind.prevPrice !== undefined &&
    ind.prevPrice >= ind.vwap &&
    ind.price < ind.vwap,

  /**
   * Price overbought (above VWAP + 2 sigma)
   * Statistically price deviated too far from mean, can serve as take-profit or reversal filter
   */
  price_above_vwap_upper2: (ind) =>
    ind.vwapUpper2 !== undefined && ind.price > ind.vwapUpper2,

  /**
   * Price oversold (below VWAP - 2 sigma)
   * Statistically oversold, can serve as bottom-fishing or reversal entry reference
   */
  price_below_vwap_lower2: (ind) =>
    ind.vwapLower2 !== undefined && ind.price < ind.vwapLower2,

  // ── BTC Dominance Trend ────────────────────────────────
  /**
   * BTC dominance rising (7d > +0.5%) -> high altcoin risk
   * Capital flowing from alts to BTC, not ideal for long alts; can short alts or reduce position
   * Typically used as auxiliary condition for sell or cover
   */
  btc_dominance_rising: (ind) =>
    ind.btcDomChange !== undefined && ind.btcDomChange > 0.5,

  /**
   * BTC dominance falling (7d < -0.5%) -> altcoin season signal
   * Capital flowing from BTC to alts, can increase alt exposure
   * Typically used as auxiliary confirmation for buy
   */
  btc_dominance_falling: (ind) =>
    ind.btcDomChange !== undefined && ind.btcDomChange < -0.5,

  // ── Funding Rate Contrarian ─────────────────────────────────
  /**
   * Longs extremely crowded (funding rate very high) -> contrarian short auxiliary condition
   * Default threshold +0.30%/8h (configurable via strategy.funding_rate.long_threshold)
   */
  funding_rate_overlong: (ind, cfg) => {
    if (ind.fundingRate === undefined) return false;
    const threshold = cfg.strategy.funding_rate?.long_threshold ?? 0.30;
    return ind.fundingRate > threshold;
  },

  /**
   * Shorts extremely crowded (funding rate very negative) -> contrarian long auxiliary condition
   * Default threshold -0.15%/8h (configurable via strategy.funding_rate.short_threshold)
   */
  funding_rate_overshort: (ind, cfg) => {
    if (ind.fundingRate === undefined) return false;
    const threshold = cfg.strategy.funding_rate?.short_threshold ?? 0.15;
    return ind.fundingRate < -threshold;
  },

  // ── CVD (Cumulative Volume Delta) ──────────────────────────
  /**
   * CVD bullish: net buying pressure positive over last 20 klines (buyers dominate)
   * Used to filter false breakouts: price rising + CVD rising = genuine buying support
   */
  cvd_bullish: (ind) => (ind.cvd ?? 0) > 0,

  /**
   * CVD bearish: net selling pressure negative over last 20 klines (sellers dominate)
   * Used to filter false drops: price falling + CVD falling = genuine selling pressure
   */
  cvd_bearish: (ind) => (ind.cvd ?? 0) < 0,

  // ── Volume ──────────────────────────────────────
  /** Volume surge (current > avg volume x 1.5) */
  volume_surge: (ind, cfg) => {
    const threshold = cfg.strategy.volume?.surge_ratio ?? 1.5;
    return ind.avgVolume > 0 && ind.volume >= ind.avgVolume * threshold;
  },

  /** Volume dry-up (current < avg volume x 0.5, low signal reliability) */
  volume_low: (ind, cfg) => {
    const threshold = cfg.strategy.volume?.low_ratio ?? 0.5;
    return ind.avgVolume > 0 && ind.volume <= ind.avgVolume * threshold;
  },

  // ── Derivatives / On-chain Data ────────────────────────────────

  /**
   * PCR extreme bearish (options Put > Call, market sentiment at extreme pessimism)
   *
   * When Put/Call Ratio > threshold (default 1.5), indicates extreme pessimism.
   * Reversal logic: extreme pessimism -> short-selling force exhausted -> potential rebound.
   * Usage: combine with rsi_oversold / ma_bullish as one of the long confirmation conditions.
   *
   * Configurable via strategy.pcr.bearish_threshold (default 1.5)
   */
  pcr_extreme_bearish: (ind, cfg) => {
    if (ind.putCallRatio === undefined) return false;
    const threshold = (cfg.strategy as unknown as { pcr?: { bearish_threshold?: number } })
      .pcr?.bearish_threshold ?? 1.5;
    return ind.putCallRatio > threshold;
  },

  /**
   * PCR extreme bullish (options Put < Call, market sentiment at extreme optimism)
   *
   * When Put/Call Ratio < threshold (default 0.5), indicates extreme greed.
   * Reversal logic: extreme greed -> long force exhausted -> potential pullback.
   * Usage: combine with rsi_overbought / ma_bearish as one of the short confirmation conditions.
   *
   * Configurable via strategy.pcr.bullish_threshold (default 0.5)
   */
  pcr_extreme_bullish: (ind, cfg) => {
    if (ind.putCallRatio === undefined) return false;
    const threshold = (cfg.strategy as unknown as { pcr?: { bullish_threshold?: number } })
      .pcr?.bullish_threshold ?? 0.5;
    return ind.putCallRatio < threshold;
  },

  /**
   * On-chain stablecoin net inflow (accumulation signal)
   *
   * Stablecoin inflow to exchanges = increasing buying capital -> potential buying pressure.
   * Used as long filter: price signal + on-chain capital inflow = higher confidence.
   * Data source: DefiLlama Stablecoins API (onchain-data.ts)
   */
  stablecoin_accumulation: (ind) => ind.stablecoinSignal === "accumulation",

  /**
   * On-chain stablecoin net outflow (distribution signal)
   *
   * Stablecoin outflow from exchanges = holders taking profit or de-risking.
   * Used as short filter: price decline + on-chain capital outflow = stronger downward momentum.
   */
  stablecoin_distribution: (ind) => ind.stablecoinSignal === "distribution",

  /**
   * No clear on-chain direction (exclusion filter)
   * When on-chain data direction is unclear (neutral), not used as signal trigger.
   * Typically used in sell signal array meaning "only sell when on-chain is not bullish".
   */
  stablecoin_not_accumulation: (ind) =>
    ind.stablecoinSignal === undefined || ind.stablecoinSignal !== "accumulation",
};

/** Internal helper: check if all conditions in a group are met, returns [allMet, metConditionNames] */
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
      console.warn(`[signals] Unknown ${label} condition: "${name}", please check strategy config`);
      return false;
    }
    const ok = checker(indicators, cfg);
    if (ok) reasons.push(name);
    return ok;
  });
  return [met, reasons];
}

/**
 * Detect signal (position-aware version)
 *
 * Uses different priorities based on current position direction,
 * preventing exit signals from being preempted by entry signals:
 *
 * - Holding long: sell (close long) takes priority, ignore buy/short/cover
 * - Holding short: cover (close short) takes priority, ignore sell/buy/short
 * - No position: buy (open long) -> short (open short)
 *              Note: don't check sell/cover (meaningless without a position)
 *
 * @param positionSide Current position direction (undefined = no position)
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
    // Holding long: only check close-long signals
    const [sellMet, sellReasons] = checkConditions(cfg.signals.sell, indicators, cfg, "sell");
    if (sellMet) return makeSignal("sell", sellReasons);
    return makeSignal("none", []);
  }

  if (positionSide === "short") {
    // Holding short: only check close-short signals
    const [coverMet, coverReasons] = checkConditions(coverConditions, indicators, cfg, "cover");
    if (coverMet) return makeSignal("cover", coverReasons);
    return makeSignal("none", []);
  }

  // No position: check entry signals (long priority over short)
  const [buyMet, buyReasons] = checkConditions(cfg.signals.buy, indicators, cfg, "buy");
  if (buyMet) return makeSignal("buy", buyReasons);

  const [shortMet, shortReasons] = checkConditions(shortConditions, indicators, cfg, "short");
  if (shortMet) return makeSignal("short", shortReasons);

  return makeSignal("none", []);
}

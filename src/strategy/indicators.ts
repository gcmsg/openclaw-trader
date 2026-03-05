import type { Kline, Indicators, MacdResult } from "../types.js";

/** Simple Moving Average (SMA) */
export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential Moving Average (EMA) — returns the last value */
export function ema(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let result = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    result = (values[i] ?? 0) * k + result * (1 - k);
  }
  return result;
}

/**
 * Full-series EMA (O(n) incremental calculation)
 *
 * Compared to calling ema() on each slice (O(n^2)), this function scans the array once,
 * using SMA as seed then continuously rolling updates, with O(n) time complexity.
 *
 * Returns length = values.length - period + 1
 * (first element corresponds to the EMA seed from values[0..period-1])
 */
export function emaArray(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  // Use SMA of first period bars as initial EMA
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  seed /= period;

  const result = new Array<number>(values.length - period + 1);
  result[0] = seed;
  for (let i = period; i < values.length; i++) {
    result[i - period + 1] = (values[i] ?? 0) * k + (result[i - period] ?? 0) * (1 - k);
  }
  return result;
}

/**
 * Relative Strength Index (RSI) — Wilder Smoothed Moving Average (standard algorithm)
 *
 * Consistent with TradingView / Binance:
 * 1. Calculate gains/losses for first period bars, use SMA as initial average
 * 2. Subsequent bars use Wilder smoothing: avgGain = (prevAvgGain*(period-1) + gain) / period
 * 3. More data yields more converged results (recommend at least 3x period bars)
 */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  const changes = closes.slice(1).map((c, i) => c - (closes[i] ?? 0));

  // ── Step 1: Use SMA of first period bars as initial average ──
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i] ?? 0;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  // ── Step 2: Wilder smooth remaining changes ──
  for (let i = period; i < changes.length; i++) {
    const change = changes[i] ?? 0;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (Moving Average Convergence Divergence) — O(n) optimized version
 *
 * Original implementation was O(n^2): recalculated EMA from scratch for each bar.
 * Optimization: use emaArray() to compute full fast/slow line series in one pass (each O(n)),
 * then apply emaArray() once more on MACD series for signal line. Total complexity O(n).
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdResult | null {
  // Need enough data: slowPeriod + signalPeriod + 1 (for previous bar)
  const minRequired = slowPeriod + signalPeriod + 1;
  if (closes.length < minRequired) return null;

  // ── O(n): Full-series EMA, single pass ──────────────────────
  const fastEmaArr = emaArray(closes, fastPeriod);
  // fastEmaArr[i] corresponds to closes[fastPeriod-1 + i]

  const slowEmaArr = emaArray(closes, slowPeriod);
  // slowEmaArr[i] corresponds to closes[slowPeriod-1 + i]

  // ── MACD line = fastEma - slowEma (aligned to slowPeriod start) ──
  // fastEmaArr has (slowPeriod - fastPeriod) more elements than slowEmaArr (at the front)
  const offset = slowPeriod - fastPeriod; // fastEmaArr offset
  const macdLine = slowEmaArr.map((slowVal, i) => (fastEmaArr[i + offset] ?? 0) - slowVal);

  if (macdLine.length < signalPeriod + 1) return null;

  // ── Signal line = EMA of MACD line (also O(n)) ─────────────────
  const signalArr = emaArray(macdLine, signalPeriod);
  // Last two elements of signalArr correspond to "current" and "previous" bar
  if (signalArr.length < 2) return null;

  const signalLine = signalArr[signalArr.length - 1] ?? 0;
  const prevSignalLine = signalArr[signalArr.length - 2] ?? 0;
  const prevPrevSignalLine = signalArr[signalArr.length - 3] ?? 0;

  // Last three elements of macdLine
  const currentMacd = macdLine[macdLine.length - 1] ?? 0;
  const prevMacd = macdLine[macdLine.length - 2] ?? 0;
  const prevPrevMacd = macdLine[macdLine.length - 3] ?? 0;
  const histogram = currentMacd - signalLine;
  const prevHistogram = prevMacd - prevSignalLine;
  const prevPrevHistogram =
    signalArr.length >= 3 ? prevPrevMacd - prevPrevSignalLine : undefined;

  return {
    macd: currentMacd,
    signal: signalLine,
    histogram,
    prevMacd,
    prevSignal: prevSignalLine,
    prevHistogram,
    ...(prevPrevHistogram !== undefined ? { prevPrevHistogram } : {}),
  };
}

/**
 * ATR (Average True Range) — Wilder Smoothed
 *
 * True Range (TR) = max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = Wilder smoothed TR average (consistent with TradingView standard)
 *
 * Usage: Dynamic position sizing, stop-loss distance setting
 */
export function atr(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return NaN;

  // Calculate true range for each kline
  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const curr = klines[i];
    const prev = klines[i - 1];
    if (!curr || !prev) continue;
    trueRanges.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    ));
  }

  // Initial ATR = SMA of first period TRs
  let atrValue = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atrValue = (atrValue * (period - 1) + (trueRanges[i] ?? 0)) / period;
  }

  return atrValue;
}

/**
 * ATR-based dynamic position sizing
 *
 * Core idea: fixed risk amount per trade (riskAmount),
 * calculate stop distance from ATR, then derive max position size.
 *
 * positionUsdt = riskAmount / (atrValue x atrMultiplier)
 *
 * @param totalUsdt     Current available capital
 * @param price         Entry price
 * @param atrValue      Current ATR value
 * @param riskPercent   Risk per trade as ratio (e.g. 0.02 = 2%)
 * @param atrMultiplier Stop distance = ATR x multiplier (default 1.5x)
 * @param maxRatio      Position cap (prevents over-leverage when ATR is tiny, default 0.3 = 30%)
 * @returns Suggested buy amount in USDT
 */
export function calcAtrPositionSize(
  totalUsdt: number,
  price: number,
  atrValue: number,
  riskPercent = 0.02,
  atrMultiplier = 1.5,
  maxRatio = 0.3
): number {
  if (isNaN(atrValue) || atrValue <= 0 || price <= 0) return totalUsdt * 0.1; // fallback

  const riskAmount = totalUsdt * riskPercent;
  const stopDistance = atrValue * atrMultiplier; // Price distance (absolute)
  const stopPercent = stopDistance / price; // Stop-loss ratio

  const positionUsdt = riskAmount / stopPercent;
  const capped = Math.min(positionUsdt, totalUsdt * maxRatio);
  return Math.max(capped, 10); // Minimum 10 USDT
}

/**
 * Volume analysis
 * Returns the ratio of current volume to recent average
 */
export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return NaN;
  const avg = sma(volumes.slice(0, -1), period); // Excluding current kline
  const current = volumes[volumes.length - 1] ?? 0;
  return current / avg;
}

/** Calculate all indicators from klines */
// ─── VWAP ────────────────────────────────────────────────────────────────────

/**
 * Calculate intraday VWAP (Volume Weighted Average Price) and deviation bands (+/-1s / +/-2s)
 *
 * Logic:
 * - Split klines by natural day based on openTime, use only today's klines
 * - typical_price = (high + low + close) / 3
 * - VWAP = sum(tp x vol) / sum(vol)
 * - s^2 = sum(vol x (tp - VWAP)^2) / sum(vol)
 * - Band = VWAP +/- n x s
 *
 * Institutional significance:
 * - Above VWAP = bulls dominate (institutional average cost is here)
 * - Price drops to VWAP then bounces = institutional accumulation point
 * - Price stays above Upper2 = overbought, short-term pullback risk
 */
export function calcVwap(klines: Kline[]): {
  vwap: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
} | null {
  if (klines.length === 0) return null;

  // Get the natural day of the last kline
  const lastOpenTime = klines[klines.length - 1]?.openTime ?? 0;
  const lastDate = new Date(lastOpenTime);
  const dayStart = Date.UTC(
    lastDate.getUTCFullYear(),
    lastDate.getUTCMonth(),
    lastDate.getUTCDate()
  );

  // Keep only today's klines
  const todayKlines = klines.filter((k) => k.openTime >= dayStart);
  if (todayKlines.length === 0) return null;

  let sumTpVol = 0;
  let sumVol = 0;

  for (const k of todayKlines) {
    const tp = (k.high + k.low + k.close) / 3;
    sumTpVol += tp * k.volume;
    sumVol += k.volume;
  }

  if (sumVol === 0) return null;

  const vwapVal = sumTpVol / sumVol;

  // Variance (volume weighted)
  let sumVarVol = 0;
  for (const k of todayKlines) {
    const tp = (k.high + k.low + k.close) / 3;
    sumVarVol += k.volume * (tp - vwapVal) ** 2;
  }
  const variance = sumVarVol / sumVol;
  const sigma = Math.sqrt(variance);

  return {
    vwap: vwapVal,
    upper1: vwapVal + sigma,
    lower1: vwapVal - sigma,
    upper2: vwapVal + 2 * sigma,
    lower2: vwapVal - 2 * sigma,
  };
}

export function calculateIndicators(
  klines: Kline[],
  maShortPeriod: number,
  maLongPeriod: number,
  rsiPeriod: number,
  macdConfig?: { enabled: boolean; fast: number; slow: number; signal: number }
): Indicators | null {
  if (klines.length < maLongPeriod + 1) return null;

  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const prevCloses = closes.slice(0, -1);

  // Using EMA instead of SMA: more responsive to recent prices, consistent with TradingView / mainstream bots
  const maShort = ema(closes, maShortPeriod);
  const maLong = ema(closes, maLongPeriod);
  const prevMaShort = ema(prevCloses, maShortPeriod);
  const prevMaLong = ema(prevCloses, maLongPeriod);
  const rsiValue = rsi(closes, rsiPeriod);

  if (isNaN(maShort) || isNaN(maLong) || isNaN(rsiValue)) return null;

  const price = closes[closes.length - 1] ?? 0;
  const currentVolume = volumes[volumes.length - 1] ?? 0;

  // Volume
  const volPeriod = 20;
  const avgVol =
    volumes.length > volPeriod
      ? sma(volumes.slice(0, -1), volPeriod)
      : sma(volumes, volumes.length);

  const result: Indicators = {
    maShort,
    maLong,
    rsi: rsiValue,
    price,
    volume: currentVolume,
    avgVolume: isNaN(avgVol) ? currentVolume : avgVol,
    prevMaShort,
    prevMaLong,
  };

  // MACD (optional)
  if (macdConfig?.enabled) {
    const macdResult = macd(closes, macdConfig.fast, macdConfig.slow, macdConfig.signal);
    if (macdResult) result.macd = macdResult;
  }

  // ATR (always calculated, used for dynamic position sizing and stop-loss suggestions)
  const atrValue = atr(klines, 14);
  if (!isNaN(atrValue)) result.atr = atrValue;

  // Cumulative Volume Delta (CVD, kline approximation)
  // Close > open -> buy-side dominant (+volume); close < open -> sell-side dominant (-volume)
  // Sum over last 20 klines: positive = net buying pressure, negative = net selling pressure
  const cvdLookback = 20;
  const cvdWindow = klines.slice(-cvdLookback);
  result.cvd = cvdWindow.reduce((sum, k) => {
    return sum + (k.close >= k.open ? k.volume : -k.volume);
  }, 0);

  // VWAP (intraday, resets by natural day)
  const vwapResult = calcVwap(klines);
  if (vwapResult) {
    result.vwap = vwapResult.vwap;
    result.vwapUpper1 = vwapResult.upper1;
    result.vwapLower1 = vwapResult.lower1;
    result.vwapUpper2 = vwapResult.upper2;
    result.vwapLower2 = vwapResult.lower2;
  }

  // Previous kline close price (cross-bar signals, e.g. vwap_bounce)
  const prevClose = closes[closes.length - 2];
  if (prevClose !== undefined) result.prevPrice = prevClose;

  return result;
}

import type { Kline, Indicators, MacdResult } from "../types.js";

/** 简单移动平均线（SMA） */
export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** 指数移动平均线（EMA） */
export function ema(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let result = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

/** 相对强弱指数（RSI） */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);

  let gains = 0;
  let losses = 0;
  for (const change of recent) {
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD（指数平滑异同移动平均线）
 * 返回当前和前一根 K 线的 MACD 值（用于判断交叉）
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdResult | null {
  // 需要足够数据：slowPeriod + signalPeriod + 1（算前一根）
  const minRequired = slowPeriod + signalPeriod + 1;
  if (closes.length < minRequired) return null;

  // 计算所有 EMA 快线和慢线，得到 MACD 序列
  const macdLine: number[] = [];
  for (let i = slowPeriod - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const fast = ema(slice, fastPeriod);
    const slow = ema(slice, slowPeriod);
    if (!isNaN(fast) && !isNaN(slow)) {
      macdLine.push(fast - slow);
    }
  }

  if (macdLine.length < signalPeriod + 1) return null;

  // 信号线 = MACD 的 EMA
  const signalLine = ema(macdLine, signalPeriod);
  const prevSignalLine = ema(macdLine.slice(0, -1), signalPeriod);

  if (isNaN(signalLine) || isNaN(prevSignalLine)) return null;

  const currentMacd = macdLine[macdLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const histogram = currentMacd - signalLine;
  const prevHistogram = prevMacd - prevSignalLine;

  return {
    macd: currentMacd,
    signal: signalLine,
    histogram,
    prevMacd,
    prevSignal: prevSignalLine,
    prevHistogram,
  };
}

/**
 * 成交量分析
 * 返回当前成交量相对于近期平均的倍数
 */
export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return NaN;
  const avg = sma(volumes.slice(0, -1), period); // 不含当前 K 线
  const current = volumes[volumes.length - 1];
  return current / avg;
}

/** 从 K 线计算所有指标 */
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

  const maShort = sma(closes, maShortPeriod);
  const maLong = sma(closes, maLongPeriod);
  const prevMaShort = sma(prevCloses, maShortPeriod);
  const prevMaLong = sma(prevCloses, maLongPeriod);
  const rsiValue = rsi(closes, rsiPeriod);
  const price = closes[closes.length - 1];

  if (isNaN(maShort) || isNaN(maLong) || isNaN(rsiValue)) return null;

  // 成交量
  const volPeriod = 20;
  const avgVol = volumes.length > volPeriod
    ? sma(volumes.slice(0, -1), volPeriod)
    : sma(volumes, volumes.length);
  const currentVolume = volumes[volumes.length - 1];

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

  // MACD（可选）
  if (macdConfig?.enabled) {
    const macdResult = macd(closes, macdConfig.fast, macdConfig.slow, macdConfig.signal);
    if (macdResult) result.macd = macdResult;
  }

  return result;
}

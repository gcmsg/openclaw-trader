import type { Kline, Indicators } from "../types.js";

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

/** 从 K 线计算所有指标 */
export function calculateIndicators(
  klines: Kline[],
  maShortPeriod: number,
  maLongPeriod: number,
  rsiPeriod: number
): Indicators | null {
  if (klines.length < maLongPeriod + 1) return null;

  const closes = klines.map((k) => k.close);
  const prevCloses = closes.slice(0, -1); // 前一根 K 线的收盘价序列

  const maShort = sma(closes, maShortPeriod);
  const maLong = sma(closes, maLongPeriod);
  const prevMaShort = sma(prevCloses, maShortPeriod);
  const prevMaLong = sma(prevCloses, maLongPeriod);
  const rsiValue = rsi(closes, rsiPeriod);
  const price = closes[closes.length - 1];

  if (isNaN(maShort) || isNaN(maLong) || isNaN(rsiValue)) return null;

  return {
    maShort,
    maLong,
    rsi: rsiValue,
    price,
    prevMaShort,
    prevMaLong,
  };
}

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
    // 守卫：slice + length check 确保 i < values.length，非空断言安全
    result = values[i]! * k + result * (1 - k);
  }
  return result;
}

/**
 * 相对强弱指数（RSI）— Wilder 平滑移动平均（标准算法）
 *
 * 与 TradingView / Binance 保持一致：
 * 1. 计算前 period 根 K 线的涨跌幅，取 SMA 作为初始均值
 * 2. 后续每根 K 线用 Wilder 平滑：avgGain = (prevAvgGain*(period-1) + gain) / period
 * 3. 数据越多，结果越收敛（建议至少 3×period 根 K 线）
 */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  // closes.slice(1).map 的 index 与 closes 对齐（i 在 0..length-2 范围内）
  const changes = closes.slice(1).map((c, i) => c - closes[i]!);

  // ── 步骤 1：前 period 根取 SMA 作为初始均值 ──
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i]!;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  // ── 步骤 2：Wilder 平滑剩余变化 ──
  for (let i = period; i < changes.length; i++) {
    const change = changes[i]!;
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

  // macdLine.length >= signalPeriod + 1 > 1，末尾两个元素必存在
  const currentMacd = macdLine[macdLine.length - 1]!;
  const prevMacd = macdLine[macdLine.length - 2]!;
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
  // volumes.length >= period + 1 > 0，末尾元素必存在
  const current = volumes[volumes.length - 1]!;
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

  // 使用 EMA 而非 SMA：对近期价格更敏感，与 TradingView / 主流机器人一致
  const maShort = ema(closes, maShortPeriod);
  const maLong = ema(closes, maLongPeriod);
  const prevMaShort = ema(prevCloses, maShortPeriod);
  const prevMaLong = ema(prevCloses, maLongPeriod);
  const rsiValue = rsi(closes, rsiPeriod);

  if (isNaN(maShort) || isNaN(maLong) || isNaN(rsiValue)) return null;

  // klines.length >= maLongPeriod + 1 > 0，末尾元素必存在
  const price = closes[closes.length - 1]!;
  const currentVolume = volumes[volumes.length - 1]!;

  // 成交量
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

  // MACD（可选）
  if (macdConfig?.enabled) {
    const macdResult = macd(closes, macdConfig.fast, macdConfig.slow, macdConfig.signal);
    if (macdResult) result.macd = macdResult;
  }

  return result;
}

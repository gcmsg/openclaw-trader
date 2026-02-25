import type { Kline, Indicators, MacdResult } from "../types.js";

/** 简单移动平均线（SMA） */
export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** 指数移动平均线（EMA）— 返回最后一个值 */
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
 * 全序列 EMA（O(n) 增量计算）
 *
 * 相比对每个切片单独调用 ema()（O(n²)），本函数只扫描一遍数组，
 * 用 SMA 作种子后持续滚动更新，时间复杂度 O(n)。
 *
 * 返回长度 = values.length - period + 1
 * （第一个元素对应 values[0..period-1] 的 EMA 种子）
 */
export function emaArray(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  // 以前 period 根的 SMA 作为初始 EMA
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
 * 相对强弱指数（RSI）— Wilder 平滑移动平均（标准算法）
 *
 * 与 TradingView / Binance 保持一致：
 * 1. 计算前 period 根 K 线的涨跌幅，取 SMA 作为初始均值
 * 2. 后续每根 K 线用 Wilder 平滑：avgGain = (prevAvgGain*(period-1) + gain) / period
 * 3. 数据越多，结果越收敛（建议至少 3×period 根 K 线）
 */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  const changes = closes.slice(1).map((c, i) => c - (closes[i] ?? 0));

  // ── 步骤 1：前 period 根取 SMA 作为初始均值 ──
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i] ?? 0;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  // ── 步骤 2：Wilder 平滑剩余变化 ──
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
 * MACD（指数平滑异同移动平均线）— O(n) 优化版本
 *
 * 原实现为 O(n²)：对每根 K 线都从头重新计算 EMA。
 * 优化：先用 emaArray() 一次性算出完整快线/慢线序列（各 O(n)），
 * 再对 MACD 序列做一次 emaArray() 得到信号线。总复杂度 O(n)。
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

  // ── O(n)：全序列 EMA，一次扫描 ──────────────────────
  const fastEmaArr = emaArray(closes, fastPeriod);
  // fastEmaArr[i] 对应 closes[fastPeriod-1 + i]

  const slowEmaArr = emaArray(closes, slowPeriod);
  // slowEmaArr[i] 对应 closes[slowPeriod-1 + i]

  // ── MACD 线 = fastEma - slowEma（对齐到 slowPeriod 起始点）──
  // fastEmaArr 比 slowEmaArr 多 (slowPeriod - fastPeriod) 个元素（在前面）
  const offset = slowPeriod - fastPeriod; // fastEmaArr 的偏移量
  const macdLine = slowEmaArr.map((slowVal, i) => (fastEmaArr[i + offset] ?? 0) - slowVal);

  if (macdLine.length < signalPeriod + 1) return null;

  // ── 信号线 = MACD 线的 EMA（同样 O(n)）─────────────────
  const signalArr = emaArray(macdLine, signalPeriod);
  // signalArr 末尾两个元素分别对应"当前"和"前一根"
  if (signalArr.length < 2) return null;

  const signalLine = signalArr[signalArr.length - 1] ?? 0;
  const prevSignalLine = signalArr[signalArr.length - 2] ?? 0;

  // macdLine 末尾两个元素
  const currentMacd = macdLine[macdLine.length - 1] ?? 0;
  const prevMacd = macdLine[macdLine.length - 2] ?? 0;
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
 * ATR（平均真实波幅）— Wilder 平滑
 *
 * 真实波幅（TR）= max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = Wilder 平滑的 TR 均值（与 TradingView 标准一致）
 *
 * 用途：动态仓位计算、止损距离设定
 */
export function atr(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return NaN;

  // 计算每根 K 线的真实波幅
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

  // 初始 ATR = 前 period 根 TR 的 SMA
  let atrValue = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder 平滑
  for (let i = period; i < trueRanges.length; i++) {
    atrValue = (atrValue * (period - 1) + (trueRanges[i] ?? 0)) / period;
  }

  return atrValue;
}

/**
 * 基于 ATR 的动态仓位计算
 *
 * 核心思想：每笔交易愿意亏损的金额固定（riskAmount），
 * 通过 ATR 算出止损距离，反推最大仓位。
 *
 * positionUsdt = riskAmount / (atrValue × atrMultiplier)
 *
 * @param totalUsdt     当前可用资金
 * @param price         入场价格
 * @param atrValue      当前 ATR 值
 * @param riskPercent   每笔愿意亏损的比例（如 0.02 = 2%）
 * @param atrMultiplier 止损距离 = ATR × 倍数（默认 1.5x）
 * @param maxRatio      仓位上限（防止 ATR 极小时过度重仓，默认 0.3 = 30%）
 * @returns 建议买入 USDT 金额
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
  const stopDistance = atrValue * atrMultiplier; // 价格距离（绝对值）
  const stopPercent = stopDistance / price; // 止损比例

  const positionUsdt = riskAmount / stopPercent;
  const capped = Math.min(positionUsdt, totalUsdt * maxRatio);
  return Math.max(capped, 10); // 最低 10 USDT
}

/**
 * 成交量分析
 * 返回当前成交量相对于近期平均的倍数
 */
export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return NaN;
  const avg = sma(volumes.slice(0, -1), period); // 不含当前 K 线
  const current = volumes[volumes.length - 1] ?? 0;
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

  const price = closes[closes.length - 1] ?? 0;
  const currentVolume = volumes[volumes.length - 1] ?? 0;

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

  // ATR（始终计算，用于动态仓位和止损建议）
  const atrValue = atr(klines, 14);
  if (!isNaN(atrValue)) result.atr = atrValue;

  return result;
}

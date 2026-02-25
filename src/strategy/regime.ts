/**
 * 市场状态分类器（Market Regime Classifier）
 *
 * 这是整个系统最关键的基础模块。
 * EMA 金叉在趋势市有效，在震荡市是绞肉机。
 * 不知道自己在什么市场里，所有信号都是噪音。
 *
 * 判断维度（三重确认）：
 *   1. ADX(14)        — 趋势强度（> 25 有趋势，< 20 震荡）
 *   2. BB Width       — 波动率状态（收窄 = 蓄力，扩张 = 爆发）
 *   3. 价格结构       — Higher High / Lower Low 序列
 *
 * 输出状态：
 *   trending_bull    — 强上涨趋势，做多信号可信
 *   trending_bear    — 强下跌趋势，做空信号可信
 *   ranging_tight    — 低波动震荡，等待突破，慎开仓
 *   ranging_wide     — 高波动震荡，反转机会，趋势信号失效
 *   breakout_up      — 刚突破上行，可能进入 trending_bull
 *   breakout_down    — 刚突破下行，可能进入 trending_bear
 */

import type { Kline } from "../types.js";

// ─── 类型定义 ──────────────────────────────────────────

export type MarketRegime =
  | "trending_bull"
  | "trending_bear"
  | "ranging_tight"
  | "ranging_wide"
  | "breakout_up"
  | "breakout_down";

export interface RegimeAnalysis {
  regime: MarketRegime;
  label: string;            // 中文描述
  confidence: number;       // 0-100，三个维度一致时高
  adx: number;              // ADX 值
  bbWidth: number;          // 当前 BB Width
  bbWidthPercentile: number;// BB Width 在近 N 周期的百分位（0-100）
  structure: PriceStructure;
  signalFilter: SignalFilter;
  detail: string;           // 一句话分析
}

export type PriceStructure = "higher_highs" | "lower_lows" | "mixed" | "flat";

export type SignalFilter =
  | "trend_signals_only"    // 趋势信号有效，反转信号忽略
  | "reversal_signals_only" // 反转信号有效（在区间边缘），趋势信号忽略
  | "breakout_watch"        // 等待突破确认，暂不开仓
  | "reduced_size"          // 所有信号可用但仓位减半
  | "all";                  // 无过滤

// ─── ADX 计算 ──────────────────────────────────────────

/**
 * 计算 ADX（平均趋向指数）
 * 使用 Wilder's Smoothing，与 TradingView 标准一致
 * @param klines K 线数据（至少需要 period*2 根）
 * @param period 周期，默认 14
 */
export function calcAdx(klines: Kline[], period = 14): {
  adx: number;
  diPlus: number;
  diMinus: number;
} {
  if (klines.length < period * 2 + 1) {
    return { adx: 0, diPlus: 0, diMinus: 0 };
  }

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    const curr = klines[i];
    const prev = klines[i - 1];
    if (!curr || !prev) continue;

    // True Range
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trueRanges.push(tr);

    // Directional Movement
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's Smoothing（首个值用简单平均，后续用 Wilder 公式）
  const wilderSmooth = (arr: number[], p: number): number[] => {
    const smoothed: number[] = [];
    // 第一个值：前 p 个的总和（Wilder 方式，不除以 p）
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    smoothed.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + (arr[i] ?? 0);
      smoothed.push(sum);
    }
    return smoothed;
  };

  const smoothTR = wilderSmooth(trueRanges, period);
  const smoothPlusDM = wilderSmooth(plusDMs, period);
  const smoothMinusDM = wilderSmooth(minusDMs, period);

  // DI+ and DI-
  const dxValues: number[] = [];
  let lastDiPlus = 0;
  let lastDiMinus = 0;

  for (let i = 0; i < smoothTR.length; i++) {
    const tr = smoothTR[i] ?? 0;
    if (tr === 0) { dxValues.push(0); continue; }

    const diPlus = 100 * (smoothPlusDM[i] ?? 0) / tr;
    const diMinus = 100 * (smoothMinusDM[i] ?? 0) / tr;
    lastDiPlus = diPlus;
    lastDiMinus = diMinus;

    const diSum = diPlus + diMinus;
    const dx = diSum === 0 ? 0 : 100 * Math.abs(diPlus - diMinus) / diSum;
    dxValues.push(dx);
  }

  // ADX = Wilder Smoothing of DX
  if (dxValues.length < period) {
    return { adx: 0, diPlus: lastDiPlus, diMinus: lastDiMinus };
  }

  const smoothDX = wilderSmooth(dxValues, period);
  const adx = (smoothDX[smoothDX.length - 1] ?? 0) / period; // 归一化

  return { adx, diPlus: lastDiPlus, diMinus: lastDiMinus };
}

// ─── Bollinger Band Width ──────────────────────────────

/**
 * 计算 BB Width 及其历史百分位
 * BB Width = (Upper - Lower) / Middle（相对宽度，无单位）
 */
export function calcBollingerWidth(closes: number[], period = 20, stdDevMult = 2): {
  bbWidth: number;
  bbWidthPercentile: number;  // 当前 width 在历史中的百分位（0=最窄, 100=最宽）
  upper: number;
  middle: number;
  lower: number;
} {
  if (closes.length < period) {
    return { bbWidth: 0, bbWidthPercentile: 50, upper: 0, middle: 0, lower: 0 };
  }

  // 计算所有历史 BB Width（用于百分位）
  const allWidths: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = mean + stdDevMult * stdDev;
    const lower = mean - stdDevMult * stdDev;
    allWidths.push(mean > 0 ? (upper - lower) / mean : 0);
  }

  const current = allWidths[allWidths.length - 1] ?? 0;
  const sorted = [...allWidths].sort((a, b) => a - b);
  const rank = sorted.filter((w) => w <= current).length;
  const percentile = Math.round((rank / sorted.length) * 100);

  // 最新 BB 值
  const recentCloses = closes.slice(-period);
  const mean = recentCloses.reduce((a, b) => a + b, 0) / period;
  const variance = recentCloses.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    bbWidth: current,
    bbWidthPercentile: percentile,
    upper: mean + stdDevMult * stdDev,
    middle: mean,
    lower: mean - stdDevMult * stdDev,
  };
}

// ─── 价格结构 ─────────────────────────────────────────

/**
 * 分析价格结构：Higher Highs / Lower Lows
 * 对比最近 N 根与之前 N 根的高低点
 */
export function analyzePriceStructure(klines: Kline[], lookback = 10): PriceStructure {
  if (klines.length < lookback * 2) return "flat";

  const recent = klines.slice(-lookback);
  const prior = klines.slice(-lookback * 2, -lookback);

  const recentHigh = Math.max(...recent.map((k) => k.high));
  const recentLow = Math.min(...recent.map((k) => k.low));
  const priorHigh = Math.max(...prior.map((k) => k.high));
  const priorLow = Math.min(...prior.map((k) => k.low));

  const higherHigh = recentHigh > priorHigh;
  const lowerLow = recentLow < priorLow;
  const lowerHigh = recentHigh < priorHigh;
  const higherLow = recentLow > priorLow;

  if (higherHigh && higherLow) return "higher_highs";  // 强上升结构
  if (lowerLow && lowerHigh) return "lower_lows";      // 强下降结构
  if (higherHigh || lowerLow) return "mixed";           // 混合（宽幅震荡或转折点）
  return "flat";                                        // 窄幅整理
}

// ─── 综合分类 ─────────────────────────────────────────

/**
 * 主分类器：结合 ADX + BB Width + 价格结构
 * @param klines K 线数据（至少 60 根，推荐 100+）
 */
export function classifyRegime(klines: Kline[]): RegimeAnalysis {
  const closes = klines.map((k) => k.close);

  // 三个维度
  const { adx, diPlus, diMinus } = calcAdx(klines, 14);
  const { bbWidth, bbWidthPercentile } = calcBollingerWidth(closes, 20);
  const structure = analyzePriceStructure(klines, 10);

  // ── 决策逻辑 ──────────────────────────────────────

  // 突破检测：BB Width 从低位快速扩张（10 根以内从 < 30th 涨到 > 60th）
  const recentWidths = calcBollingerWidthHistory(closes, 20, 10);
  const wasNarrow = recentWidths[0] !== undefined && recentWidths[0] < 0.3;  // 相对窄（绝对值）
  const isExpanding = bbWidth > (recentWidths[0] ?? 0) * 1.3;                // 扩张 > 30%
  const breakoutDetected = wasNarrow && isExpanding;

  let regime: MarketRegime;
  let confidence: number;
  let signalFilter: SignalFilter;
  let detail: string;

  if (breakoutDetected) {
    // 突破状态：优先判断，不管 ADX 还没反应过来
    regime = diPlus > diMinus ? "breakout_up" : "breakout_down";
    confidence = 55;  // 突破初期确信度中等
    signalFilter = "breakout_watch";
    detail = `BB Width 快速扩张（+${((bbWidth / (recentWidths[0] ?? bbWidth) - 1) * 100).toFixed(0)}%），突破信号`;

  } else if (adx > 25) {
    // 强趋势
    if (diPlus > diMinus && structure === "higher_highs") {
      regime = "trending_bull";
      confidence = Math.min(95, 60 + (adx - 25) * 1.5);
    } else if (diMinus > diPlus && structure === "lower_lows") {
      regime = "trending_bear";
      confidence = Math.min(95, 60 + (adx - 25) * 1.5);
    } else {
      // ADX 高但结构不匹配（趋势减弱中）
      regime = diPlus > diMinus ? "trending_bull" : "trending_bear";
      confidence = 45;
    }
    signalFilter = "trend_signals_only";
    detail = `ADX=${adx.toFixed(1)}（强趋势），DI+=${diPlus.toFixed(1)} DI-=${diMinus.toFixed(1)}`;

  } else if (adx < 20) {
    // 震荡市
    if (bbWidthPercentile < 25) {
      regime = "ranging_tight";
      confidence = 75;
      signalFilter = "breakout_watch";
      detail = `ADX=${adx.toFixed(1)}（无趋势），BB Width 处于历史低位（${bbWidthPercentile}th），等待突破`;
    } else {
      regime = "ranging_wide";
      confidence = 65;
      signalFilter = "reversal_signals_only";
      detail = `ADX=${adx.toFixed(1)}（无趋势），高波动震荡，区间边缘反转机会`;
    }

  } else {
    // ADX 20-25：过渡区间
    if (structure === "higher_highs" && diPlus > diMinus) {
      regime = "trending_bull";
      confidence = 50;
      signalFilter = "reduced_size";
    } else if (structure === "lower_lows" && diMinus > diPlus) {
      regime = "trending_bear";
      confidence = 50;
      signalFilter = "reduced_size";
    } else {
      regime = bbWidthPercentile < 40 ? "ranging_tight" : "ranging_wide";
      confidence = 45;
      signalFilter = "reduced_size";
    }
    detail = `ADX=${adx.toFixed(1)}（过渡区），方向不明确，建议缩量`;
  }

  // 结构与趋势不一致时降低置信度
  if ((regime === "trending_bull" && structure === "lower_lows") ||
      (regime === "trending_bear" && structure === "higher_highs")) {
    confidence = Math.max(30, confidence - 20);
  }

  const label = regimeLabel(regime);

  return {
    regime,
    label,
    confidence: Math.round(confidence),
    adx,
    bbWidth,
    bbWidthPercentile,
    structure,
    signalFilter,
    detail,
  };
}

/** 获取最近 N 根 K 线的 BB Width 历史（用于突破检测） */
function calcBollingerWidthHistory(closes: number[], period: number, lookback: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < lookback; i++) {
    const end = closes.length - i;
    if (end < period) break;
    const slice = closes.slice(end - period, end);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    result.push(mean > 0 ? (2 * 2 * stdDev) / mean : 0);
  }
  return result.reverse();
}

function regimeLabel(regime: MarketRegime): string {
  const map: Record<MarketRegime, string> = {
    trending_bull:  "📈 上升趋势（趋势信号有效）",
    trending_bear:  "📉 下降趋势（趋势信号有效）",
    ranging_tight:  "⏸ 低波动震荡（等待突破）",
    ranging_wide:   "↔️ 高波动震荡（区间交易）",
    breakout_up:    "🚀 向上突破（确认中）",
    breakout_down:  "💥 向下突破（确认中）",
  };
  return map[regime];
}

// ─── 与信号系统集成 ──────────────────────────────────

/**
 * 判断当前 regime 是否应该允许某类信号
 * 用于在 detectSignal() 之前过滤
 */
export function shouldAllowSignal(
  regime: RegimeAnalysis,
  signalType: "buy" | "sell" | "short" | "cover"
): boolean {
  const { signalFilter, confidence } = regime;

  // 置信度太低时不过滤（让信号系统正常工作）
  if (confidence < 40) return true;

  switch (signalFilter) {
    case "trend_signals_only":
      // 趋势市：允许顺势方向的入场信号
      if (regime.regime === "trending_bull") return signalType === "buy" || signalType === "cover";
      if (regime.regime === "trending_bear") return signalType === "short" || signalType === "sell";
      return true;

    case "reversal_signals_only":
      // 震荡市：允许反转信号（区间高点空，低点多）
      // 具体由 RSI 超买超卖 + 区间边缘判断，这里只是降低过滤门槛
      return true; // 震荡市反转交易，由 RSI 门控

    case "breakout_watch":
      // 突破等待：禁止开仓，只允许平仓
      return signalType === "sell" || signalType === "cover";

    case "reduced_size":
      return true; // 允许但外部需缩减仓位

    case "all":
    default:
      return true;
  }
}

/**
 * 格式化 Regime 报告（单币种）
 */
export function formatRegimeReport(symbol: string, regime: RegimeAnalysis): string {
  const coin = symbol.replace("USDT", "");
  const confBar = "█".repeat(Math.round(regime.confidence / 10)) + "░".repeat(10 - Math.round(regime.confidence / 10));

  return [
    `🎯 **${coin} 市场状态**`,
    regime.label,
    `置信度: ${confBar} ${regime.confidence}%`,
    `ADX: ${regime.adx.toFixed(1)} | BB Width: ${regime.bbWidthPercentile}th 百分位`,
    `价格结构: ${structureLabel(regime.structure)}`,
    `→ ${regime.detail}`,
  ].join("\n");
}

function structureLabel(s: PriceStructure): string {
  const map: Record<PriceStructure, string> = {
    higher_highs: "上升结构（HH/HL）",
    lower_lows:   "下降结构（LH/LL）",
    mixed:        "混合（转折中）",
    flat:         "横盘整理",
  };
  return map[s];
}

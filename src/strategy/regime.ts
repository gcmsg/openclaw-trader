/**
 * Market Regime Classifier
 *
 * This is the most critical foundational module of the entire system.
 * EMA golden crosses work in trending markets but are a meat grinder in ranging markets.
 * Without knowing what market you're in, all signals are noise.
 *
 * Classification dimensions (triple confirmation):
 *   1. ADX(14)        — Trend strength (> 25 trending, < 20 ranging)
 *   2. BB Width       — Volatility state (narrowing = coiling, expanding = erupting)
 *   3. Price structure — Higher High / Lower Low sequences
 *
 * Output states:
 *   trending_bull    — Strong uptrend, long signals are trustworthy
 *   trending_bear    — Strong downtrend, short signals are trustworthy
 *   ranging_tight    — Low volatility ranging, wait for breakout, cautious entry
 *   ranging_wide     — High volatility ranging, reversal opportunities, trend signals ineffective
 *   breakout_up      — Just broke upward, may enter trending_bull
 *   breakout_down    — Just broke downward, may enter trending_bear
 */

import type { Kline } from "../types.js";

// ─── Type Definitions ──────────────────────────────────────────

export type MarketRegime =
  | "trending_bull"
  | "trending_bear"
  | "ranging_tight"
  | "ranging_wide"
  | "breakout_up"
  | "breakout_down";

export interface RegimeAnalysis {
  regime: MarketRegime;
  label: string;            // Human-readable description
  confidence: number;       // 0-100, high when all three dimensions agree
  adx: number;              // ADX value
  bbWidth: number;          // Current BB Width
  bbWidthPercentile: number;// BB Width percentile over recent N periods (0-100)
  structure: PriceStructure;
  signalFilter: SignalFilter;
  detail: string;           // One-line analysis
}

export type PriceStructure = "higher_highs" | "lower_lows" | "mixed" | "flat";

export type SignalFilter =
  | "trend_signals_only"    // Trend signals valid, reversal signals ignored
  | "reversal_signals_only" // Reversal signals valid (at range edges), trend signals ignored
  | "breakout_watch"        // Wait for breakout confirmation, no opening
  | "reduced_size"          // All signals available but position halved
  | "all";                  // No filter

// ─── ADX Calculation ──────────────────────────────────────────

/**
 * Calculate ADX (Average Directional Index)
 * Uses Wilder's Smoothing, consistent with TradingView standard
 * @param klines Kline data (requires at least period*2 bars)
 * @param period Period, default 14
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

  // Wilder's Smoothing (first value uses simple average, subsequent use Wilder formula)
  const wilderSmooth = (arr: number[], p: number): number[] => {
    const smoothed: number[] = [];
    // First value: sum of first p elements (Wilder method, not divided by p)
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
  const adx = (smoothDX[smoothDX.length - 1] ?? 0) / period; // Normalize

  return { adx, diPlus: lastDiPlus, diMinus: lastDiMinus };
}

// ─── Bollinger Band Width ──────────────────────────────

/**
 * Calculate BB Width and its historical percentile
 * BB Width = (Upper - Lower) / Middle (relative width, dimensionless)
 */
export function calcBollingerWidth(closes: number[], period = 20, stdDevMult = 2): {
  bbWidth: number;
  bbWidthPercentile: number;  // Current width's percentile in history (0=narrowest, 100=widest)
  upper: number;
  middle: number;
  lower: number;
} {
  if (closes.length < period) {
    return { bbWidth: 0, bbWidthPercentile: 50, upper: 0, middle: 0, lower: 0 };
  }

  // Calculate all historical BB Widths (for percentile)
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

  // Latest BB values
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

// ─── Price Structure ─────────────────────────────────────────

/**
 * Analyze price structure: Higher Highs / Lower Lows
 * Compare highs/lows of recent N bars vs prior N bars
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

  if (higherHigh && higherLow) return "higher_highs";  // Strong upward structure
  if (lowerLow && lowerHigh) return "lower_lows";      // Strong downward structure
  if (higherHigh || lowerLow) return "mixed";           // Mixed (wide ranging or turning point)
  return "flat";                                        // Narrow consolidation
}

// ─── Comprehensive Classification ──────────────────────

/**
 * Main classifier: Combines ADX + BB Width + Price Structure
 * @param klines Kline data (at least 60 bars, 100+ recommended)
 */
export function classifyRegime(klines: Kline[]): RegimeAnalysis {
  const closes = klines.map((k) => k.close);

  // Three dimensions
  const { adx, diPlus, diMinus } = calcAdx(klines, 14);
  const { bbWidth, bbWidthPercentile } = calcBollingerWidth(closes, 20);
  const structure = analyzePriceStructure(klines, 10);

  // ── Decision Logic ──────────────────────────────────

  // Breakout detection: BB Width rapidly expanding from low levels (within 10 bars from < 30th to > 60th)
  const recentWidths = calcBollingerWidthHistory(closes, 20, 10);
  const wasNarrow = recentWidths[0] !== undefined && recentWidths[0] < 0.3;  // Relatively narrow (absolute)
  const isExpanding = bbWidth > (recentWidths[0] ?? 0) * 1.3;                // Expanding > 30%
  const breakoutDetected = wasNarrow && isExpanding;

  let regime: MarketRegime;
  let confidence: number;
  let signalFilter: SignalFilter;
  let detail: string;

  if (breakoutDetected) {
    // Breakout state: prioritize this judgment, regardless of whether ADX has caught up
    regime = diPlus > diMinus ? "breakout_up" : "breakout_down";
    confidence = 55;  // Medium confidence in early breakout
    signalFilter = "breakout_watch";
    detail = `BB Width rapidly expanding (+${((bbWidth / (recentWidths[0] ?? bbWidth) - 1) * 100).toFixed(0)}%), breakout signal`;

  } else if (adx > 25) {
    // Strong trend
    if (diPlus > diMinus && structure === "higher_highs") {
      regime = "trending_bull";
      confidence = Math.min(95, 60 + (adx - 25) * 1.5);
    } else if (diMinus > diPlus && structure === "lower_lows") {
      regime = "trending_bear";
      confidence = Math.min(95, 60 + (adx - 25) * 1.5);
    } else {
      // ADX high but structure mismatch (trend weakening)
      regime = diPlus > diMinus ? "trending_bull" : "trending_bear";
      confidence = 45;
    }
    signalFilter = "trend_signals_only";
    detail = `ADX=${adx.toFixed(1)} (strong trend), DI+=${diPlus.toFixed(1)} DI-=${diMinus.toFixed(1)}`;

  } else if (adx < 20) {
    // Ranging market
    if (bbWidthPercentile < 25) {
      regime = "ranging_tight";
      confidence = 75;
      signalFilter = "breakout_watch";
      detail = `ADX=${adx.toFixed(1)} (no trend), BB Width at historical low (${bbWidthPercentile}th), waiting for breakout`;
    } else {
      regime = "ranging_wide";
      confidence = 65;
      signalFilter = "reversal_signals_only";
      detail = `ADX=${adx.toFixed(1)} (no trend), high volatility ranging, reversal opportunities at range edges`;
    }

  } else {
    // ADX 20-25: Transition zone
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
    detail = `ADX=${adx.toFixed(1)} (transition zone), direction unclear, recommend reduced size`;
  }

  // Lower confidence when structure contradicts trend
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

/** Get BB Width history for recent N klines (for breakout detection) */
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
    trending_bull:  "📈 Uptrend (trend signals valid)",
    trending_bear:  "📉 Downtrend (trend signals valid)",
    ranging_tight:  "⏸ Low volatility ranging (waiting for breakout)",
    ranging_wide:   "↔️ High volatility ranging (range trading)",
    breakout_up:    "🚀 Upward breakout (confirming)",
    breakout_down:  "💥 Downward breakout (confirming)",
  };
  return map[regime];
}

// ─── Integration with Signal System ──────────────────

/**
 * Determine whether the current regime should allow a specific signal type
 * Used for filtering before detectSignal()
 */
export function shouldAllowSignal(
  regime: RegimeAnalysis,
  signalType: "buy" | "sell" | "short" | "cover"
): boolean {
  const { signalFilter, confidence } = regime;

  // Don't filter when confidence is too low (let signal system work normally)
  if (confidence < 40) return true;

  switch (signalFilter) {
    case "trend_signals_only":
      // Trending market: allow entry signals in trend direction
      if (regime.regime === "trending_bull") return signalType === "buy" || signalType === "cover";
      if (regime.regime === "trending_bear") return signalType === "short" || signalType === "sell";
      return true;

    case "reversal_signals_only":
      // Ranging market: allow reversal signals (short at range high, long at range low)
      // Specific filtering by RSI overbought/oversold + range edge detection, just lowering filter threshold here
      return true; // Ranging market reversal trading, gated by RSI

    case "breakout_watch":
      // Breakout watch: no new positions, only allow closing
      return signalType === "sell" || signalType === "cover";

    case "reduced_size":
      return true; // Allowed but external code should reduce position size

    case "all":
    default:
      return true;
  }
}

/**
 * Format Regime report (single symbol)
 */
export function formatRegimeReport(symbol: string, regime: RegimeAnalysis): string {
  const coin = symbol.replace("USDT", "");
  const confBar = "█".repeat(Math.round(regime.confidence / 10)) + "░".repeat(10 - Math.round(regime.confidence / 10));

  return [
    `🎯 **${coin} Market Regime**`,
    regime.label,
    `Confidence: ${confBar} ${regime.confidence}%`,
    `ADX: ${regime.adx.toFixed(1)} | BB Width: ${regime.bbWidthPercentile}th percentile`,
    `Price structure: ${structureLabel(regime.structure)}`,
    `→ ${regime.detail}`,
  ].join("\n");
}

function structureLabel(s: PriceStructure): string {
  const map: Record<PriceStructure, string> = {
    higher_highs: "Upward structure (HH/HL)",
    lower_lows:   "Downward structure (LH/LL)",
    mixed:        "Mixed (transitioning)",
    flat:         "Sideways consolidation",
  };
  return map[s];
}

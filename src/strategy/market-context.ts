/**
 * Multi-Timeframe Comprehensive Market Analysis
 *
 * Integrates 15m / 1h / 4h / 1D into a single structured judgment,
 * outputting: trend direction, signal strength, entry timing assessment, one-line conclusion.
 *
 * Principles:
 *   - Higher timeframes determine direction (daily/4h)
 *   - Lower timeframes find entry points (1h/15m)
 *   - Multiple TFs aligned = high confidence signal
 *   - TF contradiction = wait, no action
 */

import { getKlines } from "../exchange/binance.js";
import { calculateIndicators } from "./indicators.js";
import { calcPivotPoints } from "./volume-profile.js";
import { classifyRegime } from "./regime.js";
import type { RegimeAnalysis } from "./regime.js";
import type { StrategyConfig, Timeframe } from "../types.js";

// ─── Type Definitions ──────────────────────────────────────────

export type TfTrend = "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear";
export type SignalStrength = "strong" | "medium" | "weak" | "none";
export type TradeDirection = "long" | "short" | "wait";

export interface TfAnalysis {
  timeframe: Timeframe;
  trend: TfTrend;
  trendLabel: string;
  rsi: number;
  rsiLabel: string;
  macdState: "golden_cross" | "death_cross" | "bullish" | "bearish" | "neutral";
  maShort: number;
  maLong: number;
  price: number;
  distanceToMaShort: number;  // Percentage distance from price to short EMA
}

export interface MultiTfContext {
  symbol: string;
  fetchedAt: number;
  timeframes: Partial<Record<Timeframe, TfAnalysis>>;

  // Market regime classification (Phase 1 addition)
  regime: RegimeAnalysis | null;

  // Composite judgment
  overallTrend: TfTrend;
  tradeDirection: TradeDirection;
  signalStrength: SignalStrength;
  confluence: number;          // TF directional alignment (0-4, higher = more trustworthy)

  // Key levels (Pivot Point + recent highs/lows fusion)
  supportLevel: number;
  resistanceLevel: number;
  pivotPP?: number;    // Standard Pivot Point (optional, missing when daily data insufficient)

  // Text conclusions
  summary: string;             // One-line conclusion
  detail: string;              // Multi-line details (for Telegram delivery)
}

// ─── Internal Helpers ──────────────────────────────────────────

function classifyTrend(maShort: number, maLong: number, rsi: number): TfTrend {
  const maDiff = (maShort - maLong) / maLong;
  if (maDiff > 0.02 && rsi > 55) return "strong_bull";
  if (maDiff > 0    && rsi >= 45) return "bull";
  if (maDiff < -0.02 && rsi < 45) return "strong_bear";
  if (maDiff < 0    && rsi <= 55) return "bear";
  return "neutral";
}

function trendToLabel(trend: TfTrend): string {
  const map: Record<TfTrend, string> = {
    strong_bull: "Strong Bull 📈📈",
    bull:        "Bull 📈",
    neutral:     "Neutral ➡️",
    bear:        "Bear 📉",
    strong_bear: "Strong Bear 📉📉",
  };
  return map[trend];
}

function trendScore(trend: TfTrend): number {
  // Positive = bullish, negative = bearish
  const map: Record<TfTrend, number> = {
    strong_bull: 2, bull: 1, neutral: 0, bear: -1, strong_bear: -2
  };
  return map[trend];
}

function classifyMacd(
  macd: { macd: number; signal: number; histogram: number; prevMacd?: number; prevSignal?: number } | undefined
): TfAnalysis["macdState"] {
  if (!macd) return "neutral";
  if (macd.prevMacd !== undefined && macd.prevSignal !== undefined) {
    if (macd.prevMacd <= macd.prevSignal && macd.macd > macd.signal) return "golden_cross";
    if (macd.prevMacd >= macd.prevSignal && macd.macd < macd.signal) return "death_cross";
  }
  if (macd.macd > macd.signal && macd.histogram > 0) return "bullish";
  if (macd.macd < macd.signal && macd.histogram < 0) return "bearish";
  return "neutral";
}

function rsiLabel(rsi: number): string {
  if (rsi >= 70) return `${rsi.toFixed(0)} 🔴Overbought`;
  if (rsi >= 60) return `${rsi.toFixed(0)} Warm`;
  if (rsi >= 45) return `${rsi.toFixed(0)} Neutral-Bull`;
  if (rsi >= 35) return `${rsi.toFixed(0)} Neutral-Bear`;
  if (rsi >= 25) return `${rsi.toFixed(0)} Cool`;
  return `${rsi.toFixed(0)} 🟢Oversold`;
}

// ─── Core Analysis ──────────────────────────────────────────

/** Analyze a single timeframe */
async function analyzeTf(
  symbol: string,
  tf: Timeframe,
  cfg: StrategyConfig
): Promise<TfAnalysis | null> {
  try {
    const limit = Math.max(cfg.strategy.ma.long, 50) + 30;
    const klines = await getKlines(symbol, tf, limit);
    const ind = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd
    );
    if (!ind) return null;

    const trend = classifyTrend(ind.maShort, ind.maLong, ind.rsi);
    const distanceToMaShort =
      ind.maShort > 0 ? ((ind.price - ind.maShort) / ind.maShort) * 100 : 0;

    return {
      timeframe: tf,
      trend,
      trendLabel: trendToLabel(trend),
      rsi: ind.rsi,
      rsiLabel: rsiLabel(ind.rsi),
      macdState: classifyMacd(ind.macd),
      maShort: ind.maShort,
      maLong: ind.maLong,
      price: ind.price,
      distanceToMaShort,
    };
  } catch {
    return null;
  }
}

/**
 * Estimate support/resistance levels
 *
 * Dual-layer algorithm:
 *   1. Pivot Points (standard formula, based on previous daily H/L/C) -> precise market consensus levels
 *   2. Recent 4h kline highs/lows -> short-term pressure/support
 *
 * Fusion logic:
 *   - Prioritize Pivot Point S1/R1 (widely referenced by institutions)
 *   - If PP S1/R1 is too close to current price (< 0.3%) or wrong direction, fall back to recent highs/lows
 *   - Return the layer closest to price (more actionable)
 */
async function estimateKeyLevels(
  symbol: string,
  lookback = 50
): Promise<{ support: number; resistance: number; pivotPP?: number; pivotR1?: number; pivotS1?: number }> {
  try {
    // Concurrently fetch 4h klines (recent highs/lows) and daily klines (Pivot Point)
    const [klines4h, klines1d] = await Promise.all([
      getKlines(symbol, "4h", lookback),
      getKlines(symbol, "1d", 5),   // Only need the last few daily klines
    ]);

    const price = klines4h.at(-1)?.close ?? 0;
    if (price === 0) return { support: 0, resistance: 0 };

    // ── Layer 1: Pivot Points (daily) ──────────────────────
    const pivot = calcPivotPoints(klines1d);
    let pivotSupport = 0;
    let pivotResistance = 0;

    if (pivot) {
      // Select the PP support/resistance level closest to current price
      const candidates = [
        { s: pivot.s1, r: pivot.r1 },
        { s: pivot.s2, r: pivot.r2 },
      ];

      for (const { s, r } of candidates) {
        const sValid = s < price * 0.997;   // Support below price by 0.3%
        const rValid = r > price * 1.003;   // Resistance above price by 0.3%
        if (sValid && pivotSupport === 0) pivotSupport = s;
        if (rValid && pivotResistance === 0) pivotResistance = r;
        if (pivotSupport > 0 && pivotResistance > 0) break;
      }
    }

    // ── Layer 2: Recent 4h kline highs/lows ───────────────────────
    const lows = klines4h.map((k) => k.low);
    const highs = klines4h.map((k) => k.high);

    const nearestSupport = lows.filter((l) => l < price * 0.997).sort((a, b) => b - a)[0] ?? price * 0.95;
    const nearestResistance = highs.filter((h) => h > price * 1.003).sort((a, b) => a - b)[0] ?? price * 1.05;

    // ── Fusion: prioritize Pivot Point, fall back to recent highs/lows ──────────────
    const finalSupport = pivotSupport > 0 ? pivotSupport : nearestSupport;
    const finalResistance = pivotResistance > 0 ? pivotResistance : nearestResistance;

    return {
      support: finalSupport,
      resistance: finalResistance,
      ...(pivot ? { pivotPP: pivot.pp, pivotR1: pivot.r1, pivotS1: pivot.s1 } : {}),
    };
  } catch {
    return { support: 0, resistance: 0 };
  }
}

/**
 * Get multi-timeframe comprehensive analysis
 * @param timeframes List of timeframes to analyze (default: 1h, 4h, 1D)
 */
export async function getMultiTfContext(
  symbol: string,
  cfg: StrategyConfig,
  timeframes: Timeframe[] = ["1h", "4h", "1d"]
): Promise<MultiTfContext> {
  // Concurrently fetch all TF data (including 4h klines for Regime classification)
  const [tfResults, levels, regimeKlines] = await Promise.all([
    Promise.allSettled(timeframes.map((tf) => analyzeTf(symbol, tf, cfg))),
    estimateKeyLevels(symbol),
    getKlines(symbol, "4h", 100).catch(() => null),
  ]);

  const tfMap: Partial<Record<Timeframe, TfAnalysis>> = {};
  for (const [i, r] of tfResults.entries()) {
    if (r.status === "fulfilled" && r.value) {
      tfMap[timeframes[i] ?? "1d"] = r.value;
    }
  }

  // Calculate total score weighted by timeframe (higher TF has more weight)
  const tfWeights: Partial<Record<Timeframe, number>> = {
    "15m": 1, "1h": 2, "4h": 3, "1d": 4
  };

  let totalScore = 0;
  let totalWeight = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let analyzedCount = 0;

  for (const [tf, analysis] of Object.entries(tfMap) as [Timeframe, TfAnalysis][]) {
    const weight = tfWeights[tf] ?? 1;
    const score = trendScore(analysis.trend);
    totalScore += score * weight;
    totalWeight += weight;
    analyzedCount++;
    if (score > 0) bullishCount++;
    if (score < 0) bearishCount++;
  }

  const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;

  // Directional alignment (confluence): how many TFs agree on direction
  const confluence = Math.max(bullishCount, bearishCount);

  // Overall trend
  let overallTrend: TfTrend;
  if (avgScore > 1.2) overallTrend = "strong_bull";
  else if (avgScore > 0.3) overallTrend = "bull";
  else if (avgScore < -1.2) overallTrend = "strong_bear";
  else if (avgScore < -0.3) overallTrend = "bear";
  else overallTrend = "neutral";

  // Trade direction
  let tradeDirection: TradeDirection;
  let signalStrength: SignalStrength;

  if (overallTrend === "strong_bull" || (overallTrend === "bull" && confluence >= 2)) {
    tradeDirection = "long";
    signalStrength = overallTrend === "strong_bull" ? "strong" : "medium";
  } else if (overallTrend === "strong_bear" || (overallTrend === "bear" && confluence >= 2)) {
    tradeDirection = "short";
    signalStrength = overallTrend === "strong_bear" ? "strong" : "medium";
  } else if (overallTrend !== "neutral" && confluence === 1) {
    tradeDirection = overallTrend.includes("bull") ? "long" : "short";
    signalStrength = "weak";
  } else {
    tradeDirection = "wait";
    signalStrength = "none";
  }

  // One-line summary
  const dirLabel = tradeDirection === "long" ? "Long opportunity" :
                   tradeDirection === "short" ? "Short opportunity" : "Wait & watch";
  const confLabel = `${analyzedCount > 0 ? confluence : 0}/${analyzedCount} TF aligned`;

  const summary = `${trendToLabel(overallTrend)} | ${dirLabel} | ${confLabel}`;

  // Multi-line details
  const lines: string[] = [`🔬 **${symbol} Multi-Timeframe Analysis**\n`];

  const tfOrder: Timeframe[] = ["1d", "4h", "1h", "15m"];
  for (const tf of tfOrder) {
    const a = tfMap[tf];
    if (!a) continue;
    const macdEmoji = a.macdState === "golden_cross" ? "🔔Golden Cross" :
                      a.macdState === "death_cross"  ? "💀Death Cross" :
                      a.macdState === "bullish"       ? "↑Bullish" :
                      a.macdState === "bearish"       ? "↓Bearish" : "→Neutral";
    lines.push(
      `**${tf.toUpperCase()}**: ${a.trendLabel}  RSI=${a.rsiLabel}  MACD=${macdEmoji}`
    );
  }

  lines.push(`\n📊 Overall: ${trendToLabel(overallTrend)} (${confLabel})`);

  if (levels.support > 0) {
    const ppNote = levels.pivotPP ? ` (PP $${levels.pivotPP.toFixed(0)})` : "";
    lines.push(`🛡️ Support: $${levels.support.toFixed(2)}  🚧 Resistance: $${levels.resistance.toFixed(2)}${ppNote}`);
  }

  const strengthLabel = signalStrength === "strong" ? "⭐⭐⭐ Strong" :
                        signalStrength === "medium" ? "⭐⭐ Medium" :
                        signalStrength === "weak"   ? "⭐ Weak" : "─ None";
  lines.push(`\n🎯 **Action**: ${dirLabel}  Signal strength: ${strengthLabel}`);

  // Calculate market regime
  const regime = regimeKlines && regimeKlines.length >= 60 ? classifyRegime(regimeKlines) : null;

  // If regime is ranging or breakout watch, reduce signal strength
  let adjustedStrength = signalStrength;
  let adjustedDirection = tradeDirection;
  if (regime && regime.confidence >= 60) {
    if (regime.signalFilter === "breakout_watch") {
      adjustedStrength = "none";
      adjustedDirection = "wait";
    } else if (regime.signalFilter === "reduced_size" && signalStrength === "strong") {
      adjustedStrength = "medium"; // Downgrade one level
    }
  }

  // Add regime info to details
  if (regime) {
    lines.push(`\n🎯 **Market Regime**: ${regime.label} (confidence ${regime.confidence}%)`);
    if (regime.signalFilter !== "all" && regime.signalFilter !== "trend_signals_only") {
      lines.push(`⚠️ ${regime.detail}`);
    }
  }

  return {
    symbol,
    fetchedAt: Date.now(),
    timeframes: tfMap,
    regime,
    overallTrend,
    tradeDirection: adjustedDirection,
    signalStrength: adjustedStrength,
    confluence,
    supportLevel: levels.support,
    resistanceLevel: levels.resistance,
    ...(levels.pivotPP !== undefined ? { pivotPP: levels.pivotPP } : {}),
    summary,
    detail: lines.join("\n"),
  };
}

/**
 * Batch analyze multiple symbols (concurrent, with rate limiting)
 */
export async function getBatchMultiTfContext(
  symbols: string[],
  cfg: StrategyConfig,
  timeframes: Timeframe[] = ["1h", "4h", "1d"],
  concurrency = 3
): Promise<Map<string, MultiTfContext>> {
  const map = new Map<string, MultiTfContext>();

  // Batch concurrency to avoid API rate limiting
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((sym) => getMultiTfContext(sym, cfg, timeframes))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r?.status === "fulfilled") map.set(batch[j] ?? "", r.value);
    }
    // Rate limit: wait 300ms between batches
    if (i + concurrency < symbols.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return map;
}

/** Generate multi-symbol comprehensive market scan report */
export function formatMultiTfReport(
  contexts: Map<string, MultiTfContext>,
  includeDetail = false
): string {
  const lines: string[] = ["🔬 **Multi-Timeframe Scan Report**\n"];

  // Group by signal strength
  const strong: [string, MultiTfContext][] = [];
  const medium: [string, MultiTfContext][] = [];
  const weak: [string, MultiTfContext][] = [];
  const none: [string, MultiTfContext][] = [];

  for (const entry of contexts.entries()) {
    const [, ctx] = entry;
    if (ctx.signalStrength === "strong") strong.push(entry);
    else if (ctx.signalStrength === "medium") medium.push(entry);
    else if (ctx.signalStrength === "weak") weak.push(entry);
    else none.push(entry);
  }

  if (strong.length > 0) {
    lines.push("⭐⭐⭐ **Strong Signals**");
    for (const [sym, ctx] of strong) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
      if (includeDetail) lines.push(`  Price: $${ctx.timeframes["1h"]?.price.toFixed(2) ?? "?"}`);
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("⭐⭐ **Medium Signals**");
    for (const [sym, ctx] of medium) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
    }
    lines.push("");
  }

  if (weak.length > 0) {
    lines.push("⭐ **Weak Signals** (reference)");
    for (const [sym, ctx] of weak) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
    }
    lines.push("");
  }

  if (none.length > 0) {
    lines.push("─ **Wait & Watch**");
    lines.push(`  ${none.map(([s]) => s.replace("USDT", "")).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * 多时间框架综合市场分析
 *
 * 把 15m / 1h / 4h / 1D 四个维度整合成一个结构化判断，
 * 输出：趋势方向、信号强度、入场时机评估、一句话结论。
 *
 * 原则：
 *   - 高时间框架决定方向（日线/4h）
 *   - 低时间框架寻找入场点（1h/15m）
 *   - 多个 TF 方向一致 = 高置信信号
 *   - TF 之间矛盾 = 等待，不操作
 */

import { getKlines } from "../exchange/binance.js";
import { calculateIndicators } from "./indicators.js";
import { classifyRegime } from "./regime.js";
import type { RegimeAnalysis } from "./regime.js";
import type { StrategyConfig, Timeframe } from "../types.js";

// ─── 类型定义 ──────────────────────────────────────────

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
  distanceToMaShort: number;  // 价格距 EMA 短期的百分比距离
}

export interface MultiTfContext {
  symbol: string;
  fetchedAt: number;
  timeframes: Partial<Record<Timeframe, TfAnalysis>>;

  // 市场状态分类（Phase 1 新增）
  regime: RegimeAnalysis | null;

  // 综合判断
  overallTrend: TfTrend;
  tradeDirection: TradeDirection;
  signalStrength: SignalStrength;
  confluence: number;          // TF 方向一致性（0-4，越高越可信）

  // 关键价位（基于 1h 数据估算）
  supportLevel: number;
  resistanceLevel: number;

  // 文字结论
  summary: string;             // 一句话结论
  detail: string;              // 多行详情（供 Telegram 发送）
}

// ─── 内部辅助 ──────────────────────────────────────────

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
    strong_bull: "强多头 📈📈",
    bull:        "多头 📈",
    neutral:     "中性 ➡️",
    bear:        "空头 📉",
    strong_bear: "强空头 📉📉",
  };
  return map[trend];
}

function trendScore(trend: TfTrend): number {
  // 正分 = 多头，负分 = 空头
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
  if (rsi >= 70) return `${rsi.toFixed(0)} 🔴超买`;
  if (rsi >= 60) return `${rsi.toFixed(0)} 偏热`;
  if (rsi >= 45) return `${rsi.toFixed(0)} 中性偏多`;
  if (rsi >= 35) return `${rsi.toFixed(0)} 中性偏空`;
  if (rsi >= 25) return `${rsi.toFixed(0)} 偏冷`;
  return `${rsi.toFixed(0)} 🟢超卖`;
}

// ─── 核心分析 ──────────────────────────────────────────

/** 分析单个时间框架 */
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

/** 从 K 线数据估算支撑/阻力位（近期高低点） */
async function estimateKeyLevels(
  symbol: string,
  lookback = 50
): Promise<{ support: number; resistance: number }> {
  try {
    const klines = await getKlines(symbol, "4h", lookback);
    const lows = klines.map((k) => k.low);
    const highs = klines.map((k) => k.high);
    const price = klines[klines.length - 1]!.close;

    // 找最近的支撑（低于当前价的近期低点）和阻力（高于当前价的近期高点）
    const belowPriceHighs = highs.filter((h) => h < price * 1.005).sort((a, b) => b - a);
    const abovePriceLows = lows.filter((l) => l > price * 0.995).sort((a, b) => a - b);

    const support = lows.filter((l) => l < price).sort((a, b) => b - a)[0] ?? price * 0.95;
    const resistance = highs.filter((h) => h > price).sort((a, b) => a - b)[0] ?? price * 1.05;

    // 避免支撑/阻力太近（< 0.5%）
    const validSupport = support < price * 0.995 ? support : price * 0.97;
    const validResistance = resistance > price * 1.005 ? resistance : price * 1.03;

    void belowPriceHighs;
    void abovePriceLows;

    return { support: validSupport, resistance: validResistance };
  } catch {
    return { support: 0, resistance: 0 };
  }
}

/**
 * 获取多时间框架综合分析
 * @param timeframes 要分析的时间框架列表（默认：1h, 4h, 1D）
 */
export async function getMultiTfContext(
  symbol: string,
  cfg: StrategyConfig,
  timeframes: Timeframe[] = ["1h", "4h", "1d"]
): Promise<MultiTfContext> {
  // 并发获取所有 TF 数据（含 4h klines 用于 Regime 分类）
  const [tfResults, levels, regimeKlines] = await Promise.all([
    Promise.allSettled(timeframes.map((tf) => analyzeTf(symbol, tf, cfg))),
    estimateKeyLevels(symbol),
    getKlines(symbol, "4h", 100).catch(() => null),
  ]);

  const tfMap: Partial<Record<Timeframe, TfAnalysis>> = {};
  for (let i = 0; i < timeframes.length; i++) {
    const r = tfResults[i]!;
    if (r.status === "fulfilled" && r.value) {
      tfMap[timeframes[i]!] = r.value;
    }
  }

  // 按时间框架权重计算总分（高 TF 权重更大）
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

  // 方向一致性（confluence）：有多少个 TF 方向相同
  const confluence = Math.max(bullishCount, bearishCount);

  // 综合趋势
  let overallTrend: TfTrend;
  if (avgScore > 1.2) overallTrend = "strong_bull";
  else if (avgScore > 0.3) overallTrend = "bull";
  else if (avgScore < -1.2) overallTrend = "strong_bear";
  else if (avgScore < -0.3) overallTrend = "bear";
  else overallTrend = "neutral";

  // 交易方向
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

  // 一句话总结
  const dirLabel = tradeDirection === "long" ? "做多机会" :
                   tradeDirection === "short" ? "做空机会" : "观望等待";
  const confLabel = `${analyzedCount > 0 ? confluence : 0}/${analyzedCount} TF 方向一致`;

  const summary = `${trendToLabel(overallTrend)} | ${dirLabel} | ${confLabel}`;

  // 多行详情
  const lines: string[] = [`🔬 **${symbol} 多时间框架分析**\n`];

  const tfOrder: Timeframe[] = ["1d", "4h", "1h", "15m"];
  for (const tf of tfOrder) {
    const a = tfMap[tf];
    if (!a) continue;
    const macdEmoji = a.macdState === "golden_cross" ? "🔔金叉" :
                      a.macdState === "death_cross"  ? "💀死叉" :
                      a.macdState === "bullish"       ? "↑多头" :
                      a.macdState === "bearish"       ? "↓空头" : "→中性";
    lines.push(
      `**${tf.toUpperCase()}**: ${a.trendLabel}  RSI=${a.rsiLabel}  MACD=${macdEmoji}`
    );
  }

  lines.push(`\n📊 综合: ${trendToLabel(overallTrend)}（${confLabel}）`);

  if (levels.support > 0) {
    lines.push(`🛡️ 支撑: $${levels.support.toFixed(2)}  🚧 阻力: $${levels.resistance.toFixed(2)}`);
  }

  const strengthLabel = signalStrength === "strong" ? "⭐⭐⭐ 强烈" :
                        signalStrength === "medium" ? "⭐⭐ 中等" :
                        signalStrength === "weak"   ? "⭐ 弱" : "─ 无";
  lines.push(`\n🎯 **操作建议**: ${dirLabel}  信号强度: ${strengthLabel}`);

  // 计算市场状态（Regime）
  const regime = regimeKlines && regimeKlines.length >= 60 ? classifyRegime(regimeKlines) : null;

  // 如果 regime 是震荡或等待突破，降低信号强度
  let adjustedStrength = signalStrength;
  let adjustedDirection = tradeDirection;
  if (regime && regime.confidence >= 60) {
    if (regime.signalFilter === "breakout_watch") {
      adjustedStrength = "none";
      adjustedDirection = "wait";
    } else if (regime.signalFilter === "reduced_size" && signalStrength === "strong") {
      adjustedStrength = "medium"; // 降一档
    }
  }

  // 把 regime 信息加入详情
  if (regime) {
    lines.push(`\n🎯 **市场状态**: ${regime.label}（置信度 ${regime.confidence}%）`);
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
    summary,
    detail: lines.join("\n"),
  };
}

/**
 * 批量分析多个币种（并发，有限流控制）
 */
export async function getBatchMultiTfContext(
  symbols: string[],
  cfg: StrategyConfig,
  timeframes: Timeframe[] = ["1h", "4h", "1d"],
  concurrency = 3
): Promise<Map<string, MultiTfContext>> {
  const map = new Map<string, MultiTfContext>();

  // 分批并发，避免 API 限速
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((sym) => getMultiTfContext(sym, cfg, timeframes))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]!;
      if (r.status === "fulfilled") map.set(batch[j]!, r.value);
    }
    // 限速：每批之间等 300ms
    if (i + concurrency < symbols.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return map;
}

/** 生成多币种综合市场扫描报告 */
export function formatMultiTfReport(
  contexts: Map<string, MultiTfContext>,
  includeDetail = false
): string {
  const lines: string[] = ["🔬 **多时间框架扫描报告**\n"];

  // 按信号强度分组
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
    lines.push("⭐⭐⭐ **强信号**");
    for (const [sym, ctx] of strong) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
      if (includeDetail) lines.push(`  价格: $${ctx.timeframes["1h"]?.price.toFixed(2) ?? "?"}`);
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("⭐⭐ **中信号**");
    for (const [sym, ctx] of medium) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
    }
    lines.push("");
  }

  if (weak.length > 0) {
    lines.push("⭐ **弱信号**（参考）");
    for (const [sym, ctx] of weak) {
      lines.push(`  ${sym.replace("USDT", "")}: ${ctx.summary}`);
    }
    lines.push("");
  }

  if (none.length > 0) {
    lines.push("─ **观望**");
    lines.push(`  ${none.map(([s]) => s.replace("USDT", "")).join(", ")}`);
  }

  return lines.join("\n");
}

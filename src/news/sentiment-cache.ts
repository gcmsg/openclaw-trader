/**
 * LLM 情绪缓存
 *
 * 设计思路：
 *   关键词匹配是"语法识别"，LLM 是"语义理解"。
 *   但 LLM 不能跑在信号检测的热路径里（延迟 + 成本）。
 *
 *   解决方案：异步缓存模式
 *   1. 每次晚间市场分析（cron / 手动调用 npm run analysis）结束后，
 *      将 Mia 的情绪判断结果写入 logs/sentiment-cache.json
 *   2. sentiment-gate.ts 优先读缓存（TTL 6h）
 *   3. 缓存过期 → 回退到关键词匹配（不丢失功能，只降级精度）
 *
 *   好处：
 *   - 市场分析 cron 每 4h 运行一次 → 缓存始终新鲜
 *   - 信号检测无需等待 LLM → 零延迟
 *   - 随着 Mia 分析质量提升，交易决策也持续改进
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.resolve(__dirname, "../../logs/sentiment-cache.json");

// ─────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────

export type SentimentLabel = "very_bullish" | "bullish" | "neutral" | "bearish" | "very_bearish";

export interface SentimentEntry {
  /** 综合情绪分（-10 到 +10，正=利多，负=利空） */
  score: number;
  /** 语义标签 */
  label: SentimentLabel;
  /** 关键利多理由（最多 3 条） */
  bullishReasons: string[];
  /** 关键利空理由（最多 3 条） */
  bearishReasons: string[];
  /** 参考的新闻标题数量 */
  headlineCount: number;
  /** 写入时间戳（毫秒） */
  updatedAt: number;
  /** 数据来源（"llm" = LLM 分析，"keywords" = 关键词兜底） */
  source: "llm" | "keywords";
  /** 分析者（Mia / cron） */
  analyzedBy?: string;
}

export interface SentimentCache {
  /** 整体市场情绪 */
  overall: SentimentEntry;
  /** 各币种具体影响（可选，只填有特定新闻的币种） */
  byAsset?: Record<string, SentimentEntry>;
  /** 缓存版本号 */
  version: number;
}

// ─────────────────────────────────────────────────────
// 读写工具
// ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 小时有效期

/**
 * 读取情绪缓存
 * @param maxAgeMs 最大缓存年龄（毫秒），默认 6h
 * @returns 缓存内容，或 null（缓存不存在/过期）
 */
export function readSentimentCache(maxAgeMs = CACHE_TTL_MS): SentimentCache | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as SentimentCache;
    const age = Date.now() - cache.overall.updatedAt;
    if (age > maxAgeMs) return null; // 过期
    return cache;
  } catch {
    return null;
  }
}

/**
 * 写入整体市场情绪缓存（由 market-analysis.ts 和 cron 任务调用）
 *
 * @param score         -10 到 +10
 * @param label         语义标签
 * @param bullishReasons  利多理由（最多 3 条，简洁语句）
 * @param bearishReasons  利空理由
 * @param headlineCount   参考新闻条数
 * @param byAsset         可选：各币种特定情绪
 */
export function writeSentimentCache(params: {
  score: number;
  label: SentimentLabel;
  bullishReasons?: string[];
  bearishReasons?: string[];
  headlineCount?: number;
  byAsset?: Record<string, Omit<SentimentEntry, "updatedAt" | "source">>;
  analyzedBy?: string;
}): void {
  const entry: SentimentEntry = {
    score: Math.max(-10, Math.min(10, params.score)),
    label: params.label,
    bullishReasons: (params.bullishReasons ?? []).slice(0, 3),
    bearishReasons: (params.bearishReasons ?? []).slice(0, 3),
    headlineCount: params.headlineCount ?? 0,
    updatedAt: Date.now(),
    source: "llm",
    ...(params.analyzedBy !== undefined && { analyzedBy: params.analyzedBy }),
  };

  const byAsset: Record<string, SentimentEntry> | undefined = params.byAsset
    ? Object.fromEntries(
        Object.entries(params.byAsset).map(([asset, v]) => [
          asset,
          { ...v, updatedAt: Date.now(), source: "llm" as const },
        ])
      )
    : undefined;

  const cache: SentimentCache = {
    overall: entry,
    version: 2,
    ...(byAsset !== undefined && { byAsset }),
  };

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * 从关键词评分写入缓存（降级模式）
 * 当没有 LLM 分析时，也把关键词结果存入缓存供参考
 */
export function writeKeywordSentimentCache(score: number, headlineCount: number): void {
  let label: SentimentLabel;
  if (score >= 4) label = "very_bullish";
  else if (score >= 2) label = "bullish";
  else if (score <= -4) label = "very_bearish";
  else if (score <= -2) label = "bearish";
  else label = "neutral";

  const entry: SentimentEntry = {
    score: Math.max(-10, Math.min(10, score * 1.5)), // 关键词分换算到 -10~+10
    label,
    bullishReasons: [],
    bearishReasons: [],
    headlineCount,
    updatedAt: Date.now(),
    source: "keywords",
  };

  const cache: SentimentCache = { overall: entry, version: 2 };
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch { /* 写入失败不阻断主流程 */ }
}

// ─────────────────────────────────────────────────────
// 门控判断
// ─────────────────────────────────────────────────────

export type SentimentGateDecision =
  | { action: "proceed"; reason: string }
  | { action: "reduce_size"; ratio: number; reason: string }
  | { action: "skip"; reason: string };

/**
 * 基于缓存情绪判断是否放行信号
 *
 * 逻辑：
 *   买入信号 + 极度空头情绪（score ≤ -5）→ skip
 *   买入信号 + 偏空头情绪（score ≤ -3）→ 减半仓
 *   卖出/做空信号 + 极度多头情绪（score ≥ 5）→ skip
 *   其余 → proceed
 */
export function evaluateCachedSentiment(
  signalType: "buy" | "sell" | "short" | "cover",
  cache: SentimentCache
): SentimentGateDecision {
  const { score, label, source } = cache.overall;
  const srcNote = source === "keywords" ? "（关键词估算）" : "（LLM 分析）";

  if (signalType === "buy") {
    if (score <= -5) {
      return { action: "skip", reason: `情绪极度空头（${label}, ${score}分${srcNote}），跳过买入` };
    }
    if (score <= -3) {
      return { action: "reduce_size", ratio: 0.5, reason: `情绪偏空（${label}, ${score}分${srcNote}），减半仓位` };
    }
  }

  if (signalType === "short") {
    if (score >= 5) {
      return { action: "skip", reason: `情绪极度多头（${label}, ${score}分${srcNote}），跳过做空` };
    }
    if (score >= 3) {
      return { action: "reduce_size", ratio: 0.5, reason: `情绪偏多（${label}, ${score}分${srcNote}），做空减半` };
    }
  }

  return { action: "proceed", reason: `情绪${label}（${score}分${srcNote}），信号放行` };
}

// ─────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────

/** 情绪标签转中文 */
export function sentimentLabelZh(label: SentimentLabel): string {
  const map: Record<SentimentLabel, string> = {
    very_bullish: "极度看多 🚀",
    bullish: "看多 📈",
    neutral: "中性 ➡️",
    bearish: "看空 📉",
    very_bearish: "极度看空 💀",
  };
  return map[label];
}

/** 格式化情绪缓存摘要（用于分析报告） */
export function formatSentimentCacheSummary(cache: SentimentCache): string {
  const { score, label, bullishReasons, bearishReasons, updatedAt, source } = cache.overall;
  const age = Math.round((Date.now() - updatedAt) / 60000);
  const srcLabel = source === "llm" ? "🤖 LLM" : "🔤 关键词";
  const lines = [
    `📊 **情绪评分**: ${score >= 0 ? "+" : ""}${score}/10  ${sentimentLabelZh(label)}  ${srcLabel} (${age}min前)`,
  ];
  if (bullishReasons.length > 0) lines.push(`🟢 利多: ${bullishReasons.join(" · ")}`);
  if (bearishReasons.length > 0) lines.push(`🔴 利空: ${bearishReasons.join(" · ")}`);
  return lines.join("\n");
}

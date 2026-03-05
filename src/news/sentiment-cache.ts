/**
 * LLM Sentiment Cache
 *
 * Design Philosophy:
 *   Keyword matching is "syntactic recognition", LLM is "semantic understanding".
 *   But LLM cannot run in the hot path of signal detection (latency + cost).
 *
 *   Solution: Async cache pattern
 *   1. After each evening market analysis (cron / manual `npm run analysis`),
 *      write the AI agent's sentiment analysis results to logs/sentiment-cache.json
 *   2. sentiment-gate.ts reads cache first (TTL 6h)
 *   3. Cache expired -> fall back to keyword matching (no loss of functionality, only reduced precision)
 *
 *   Benefits:
 *   - Market analysis cron runs every 4h -> cache is always fresh
 *   - Signal detection doesn't need to wait for LLM -> zero latency
 *   - As AI agent analysis quality improves, trading decisions also continuously improve
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.resolve(__dirname, "../../logs/sentiment-cache.json");

// ─────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────

export type SentimentLabel = "very_bullish" | "bullish" | "neutral" | "bearish" | "very_bearish";

export interface SentimentEntry {
  /** Composite sentiment score (-10 to +10, positive=bullish, negative=bearish) */
  score: number;
  /** Semantic label */
  label: SentimentLabel;
  /** Key bullish reasons (up to 3) */
  bullishReasons: string[];
  /** Key bearish reasons (up to 3) */
  bearishReasons: string[];
  /** Number of referenced news headlines */
  headlineCount: number;
  /** Write timestamp (milliseconds) */
  updatedAt: number;
  /** Data source ("llm" = LLM analysis, "keywords" = keyword fallback) */
  source: "llm" | "keywords";
  /** Analyzer (AI agent / cron) */
  analyzedBy?: string;
}

export interface SentimentCache {
  /** Overall market sentiment */
  overall: SentimentEntry;
  /** Per-asset specific impact (optional, only for assets with specific news) */
  byAsset?: Record<string, SentimentEntry>;
  /** Cache version number */
  version: number;
}

// ─────────────────────────────────────────────────────
// Read/Write Utilities
// ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 6 * 3600 * 1000; // 6-hour validity period

/**
 * Read sentiment cache
 * @param maxAgeMs Maximum cache age (milliseconds), default 6h
 * @returns Cache contents, or null (cache doesn't exist/expired)
 */
export function readSentimentCache(maxAgeMs = CACHE_TTL_MS): SentimentCache | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as SentimentCache;
    const age = Date.now() - cache.overall.updatedAt;
    if (age > maxAgeMs) return null; // Expired
    return cache;
  } catch {
    return null;
  }
}

/**
 * Write overall market sentiment cache (called by market-analysis.ts and cron tasks)
 *
 * @param score         -10 to +10
 * @param label         Semantic label
 * @param bullishReasons  Bullish reasons (up to 3, concise phrases)
 * @param bearishReasons  Bearish reasons
 * @param headlineCount   Number of referenced news items
 * @param byAsset         Optional: per-asset specific sentiment
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
 * Write cache from keyword scoring (fallback mode)
 * When no LLM analysis is available, also store keyword results in cache for reference
 */
export function writeKeywordSentimentCache(score: number, headlineCount: number): void {
  let label: SentimentLabel;
  if (score >= 4) label = "very_bullish";
  else if (score >= 2) label = "bullish";
  else if (score <= -4) label = "very_bearish";
  else if (score <= -2) label = "bearish";
  else label = "neutral";

  const entry: SentimentEntry = {
    score: Math.max(-10, Math.min(10, score * 1.5)), // Convert keyword score to -10~+10
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
  } catch { /* Write failure does not block main flow */ }
}

// ─────────────────────────────────────────────────────
// Gate Decision
// ─────────────────────────────────────────────────────

export type SentimentGateDecision =
  | { action: "proceed"; reason: string }
  | { action: "reduce_size"; ratio: number; reason: string }
  | { action: "skip"; reason: string };

/**
 * Determine whether to pass a signal based on cached sentiment
 *
 * Logic:
 *   Buy signal + extremely bearish sentiment (score <= -5) -> skip
 *   Buy signal + moderately bearish sentiment (score <= -3) -> half position
 *   Sell/short signal + extremely bullish sentiment (score >= 5) -> skip
 *   Otherwise -> proceed
 */
export function evaluateCachedSentiment(
  signalType: "buy" | "sell" | "short" | "cover",
  cache: SentimentCache
): SentimentGateDecision {
  const { score, label, source } = cache.overall;
  const srcNote = source === "keywords" ? " (keyword estimate)" : " (LLM analysis)";

  if (signalType === "buy") {
    if (score <= -5) {
      return { action: "skip", reason: `Extremely bearish sentiment (${label}, ${score}pts${srcNote}), skipping buy` };
    }
    if (score <= -3) {
      return { action: "reduce_size", ratio: 0.5, reason: `Bearish sentiment (${label}, ${score}pts${srcNote}), halving position` };
    }
  }

  if (signalType === "short") {
    if (score >= 5) {
      return { action: "skip", reason: `Extremely bullish sentiment (${label}, ${score}pts${srcNote}), skipping short` };
    }
    if (score >= 3) {
      return { action: "reduce_size", ratio: 0.5, reason: `Bullish sentiment (${label}, ${score}pts${srcNote}), halving short` };
    }
  }

  return { action: "proceed", reason: `Sentiment ${label} (${score}pts${srcNote}), signal passed` };
}

// ─────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────

/** Sentiment label to display text */
export function sentimentLabelZh(label: SentimentLabel): string {
  const map: Record<SentimentLabel, string> = {
    very_bullish: "Very Bullish 🚀",
    bullish: "Bullish 📈",
    neutral: "Neutral ➡️",
    bearish: "Bearish 📉",
    very_bearish: "Very Bearish 💀",
  };
  return map[label];
}

/** Format sentiment cache summary (for analysis reports) */
export function formatSentimentCacheSummary(cache: SentimentCache): string {
  const { score, label, bullishReasons, bearishReasons, updatedAt, source } = cache.overall;
  const age = Math.round((Date.now() - updatedAt) / 60000);
  const srcLabel = source === "llm" ? "🤖 LLM" : "🔤 Keywords";
  const lines = [
    `📊 **Sentiment Score**: ${score >= 0 ? "+" : ""}${score}/10  ${sentimentLabelZh(label)}  ${srcLabel} (${age}min ago)`,
  ];
  if (bullishReasons.length > 0) lines.push(`🟢 Bullish: ${bullishReasons.join(" · ")}`);
  if (bearishReasons.length > 0) lines.push(`🔴 Bearish: ${bearishReasons.join(" · ")}`);
  return lines.join("\n");
}

/**
 * News Sentiment Gate Module
 * After technical signal triggers, reads latest news report as a "secondary filter"
 * Decision: execute / reduce position / skip / warn
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Signal } from "../types.js";
import { evaluateCachedSentiment, type SentimentCache } from "./sentiment-cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, "../../logs/news-report.json");

// ─────────────────────────────────────────────────────
// Keyword Sentiment Scoring
// ─────────────────────────────────────────────────────

/** Bullish keywords: +1 point each when found in title */
const BULLISH_KEYWORDS: string[] = [
  "rally", "surge", "bull", "pump", "breakout", "all-time high", "ath",
  "institutional", "etf", "approval", "adopt", "partnership", "launch",
  "upgrade", "mainnet", "halving", "recovery", "recover", "rebound",
  "support", "accumulate", "accumulation", "inflow", "buy",
];

/** Bearish keywords: -1 point each when found in title */
const BEARISH_KEYWORDS: string[] = [
  "crash", "dump", "bear", "drop", "fall", "plunge", "collapse",
  "hack", "exploit", "breach", "stolen", "ban", "crackdown",
  "sec", "lawsuit", "fine", "penalty", "bankruptcy", "insolvency",
  "liquidation", "rug", "scam", "fraud", "outflow", "sell-off",
  "selloff", "fear", "uncertainty", "concern", "warning", "risk",
];

/**
 * Score a set of news headlines by keyword sentiment
 * @returns Positive = bullish, Negative = bearish, 0 = neutral
 */
export function scoreNewsTitles(titles: string[]): number {
  let score = 0;
  for (const title of titles) {
    const lower = title.toLowerCase();
    for (const kw of BULLISH_KEYWORDS) {
      if (lower.includes(kw)) score++;
    }
    for (const kw of BEARISH_KEYWORDS) {
      if (lower.includes(kw)) score--;
    }
  }
  return score;
}

// Report validity: 4 hours (beyond this, data is considered stale)
const REPORT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type GateDecision =
  | { action: "execute"; positionRatio: number; reason: string } // Normal execution
  | { action: "reduce"; positionRatio: number; reason: string } // Half position execution
  | { action: "skip"; reason: string } // Skip
  | { action: "warn"; positionRatio: number; reason: string }; // Execute with warning

export interface NewsReport {
  generatedAt: string;
  fearGreed: { value: number; label: string };
  globalMarket: { marketCapChangePercent24h: number; btcDominance?: number; totalMarketCapUsd?: number };
  sentiment: "bullish" | "bearish" | "neutral";
  importantNews: { title: string }[];
  bigMovers: { symbol: string; priceChangePercent: number }[];
  fgAlert: boolean;
  fgDelta: number;
}

/** Load latest news report (returns null if none) */
export function loadNewsReport(): NewsReport | null {
  try {
    const raw = fs.readFileSync(REPORT_PATH, "utf-8");
    const report = JSON.parse(raw) as NewsReport;
    const age = Date.now() - new Date(report.generatedAt).getTime();
    if (age > REPORT_MAX_AGE_MS) return null; // Data too stale
    return report;
  } catch (_e: unknown) {
    return null; // File does not exist or parse failed
  }
}

/**
 * Determine how to handle a signal based on news sentiment
 *
 * Priority:
 *   1. LLM sentiment cache (optionally passed by caller, written by evening cron)
 *   2. Keyword matching (fallback)
 *   3. FGI + report global sentiment (auxiliary judgment)
 *
 * @param sentimentCache  Optional: read from disk by caller and passed in (test-friendly, no file I/O side effects)
 */
export function evaluateSentimentGate(
  signal: Signal,
  report: NewsReport | null,
  baseRatio: number,
  sentimentCache?: SentimentCache | null
): GateDecision {
  // ── Priority: use LLM sentiment cache (passed by caller, no file read side effects) ──
  if ((signal.type === "buy" || signal.type === "short") && sentimentCache) {
    const cached = evaluateCachedSentiment(signal.type, sentimentCache);
    if (cached.action === "skip") {
      return { action: "skip", reason: cached.reason };
    }
    if (cached.action === "reduce_size") {
      return { action: "reduce", positionRatio: baseRatio * cached.ratio, reason: cached.reason };
    }
    // action === "proceed": cache passed, still need to check FGI extreme values
    if (report) {
      const fg = report.fearGreed.value;
      if (signal.type === "buy" && fg > 85) {
        return { action: "reduce", positionRatio: baseRatio * 0.5, reason: `LLM sentiment passed but extreme greed (FGI=${fg}), halving for cautious entry` };
      }
      if (signal.type === "buy" && fg < 15) {
        return { action: "execute", positionRatio: baseRatio, reason: `LLM sentiment passed + extreme fear (FGI=${fg}), historical bottom, normal entry` };
      }
    }
    return { action: "execute", positionRatio: baseRatio, reason: cached.reason };
  }

  // ── Fallback: no LLM cache, use keyword matching (original logic) ────────
  if (!report) {
    return { action: "execute", positionRatio: baseRatio, reason: "No sentiment data, relying on technicals" };
  }

  // After keyword scoring, write results to cache for next use (avoid repeated keyword scanning)
  const { fearGreed, sentiment, importantNews, fgAlert } = report;
  const fg = fearGreed.value;

  // ── Keyword sentiment scoring ─────────────────────────────────────
  const newsScore = scoreNewsTitles(importantNews.map((n) => n.title));
  const newsScoreLabel =
    newsScore > 0 ? `+${newsScore} bullish` : newsScore < 0 ? `${newsScore} bearish` : "0 neutral";

  // ── Extreme market sentiment alert period: fgAlert with direction conflicting with signal ──
  if (fgAlert) {
    if (signal.type === "buy" && report.fgDelta < 0) {
      return {
        action: "skip",
        reason: `Fear & Greed Index dropped sharply by ${report.fgDelta} points, rapid sentiment deterioration, skipping buy signal`,
      };
    }
    if (signal.type === "sell" && report.fgDelta > 0) {
      return {
        action: "warn",
        positionRatio: baseRatio * 0.5,
        reason: `Fear & Greed Index surged by ${report.fgDelta} points, possible short-term top, halving sell`,
      };
    }
  }

  // ── Major news impact (5+ important news items) -> handle cautiously ──
  if (importantNews.length >= 5) {
    return {
      action: "reduce",
      positionRatio: baseRatio * 0.5,
      reason: `Detected ${importantNews.length} important news items, high market uncertainty, halving position`,
    };
  }

  // ── Buy signal x sentiment judgment ──
  if (signal.type === "buy") {
    // Keywords strongly bearish (<= -4) -> skip buy
    if (newsScore <= -4) {
      return {
        action: "skip",
        reason: `News keywords strongly bearish (score=${newsScore}), conflicts with buy signal, skipping`,
      };
    }

    // Extreme greed makes buying risky
    if (fg > 80) {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `Extreme greed (FGI=${fg}), historically often a top, halving position for cautious buy`,
      };
    }

    // Keywords moderately bearish (<= -2) -> reduce position
    if (newsScore <= -2) {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `News keywords bearish (score=${newsScore}), conflicts with buy signal, halving position`,
      };
    }

    // Macro sentiment bearish (FGI + market price judgment) -> reduce position
    if (sentiment === "bearish") {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `Overall market sentiment bearish (FGI=${fg}), conflicts with buy signal, halving position`,
      };
    }

    // Extreme fear is historically a buying opportunity (only execute when keywords not strongly bearish)
    if (fg < 20) {
      return {
        action: "execute",
        positionRatio: baseRatio,
        reason: `Extreme fear (FGI=${fg}), historical bottom zone, news score=${newsScoreLabel}, technical signal credible`,
      };
    }

    return {
      action: "execute",
      positionRatio: baseRatio,
      reason: `Neutral/bullish sentiment (FGI=${fg}, news score=${newsScoreLabel})`,
    };
  }

  // ── Sell signal x sentiment judgment ──
  if (signal.type === "sell") {
    // Extreme fear when selling -> possibly at bottom, warn
    if (fg < 20) {
      return {
        action: "warn",
        positionRatio: baseRatio,
        reason: `Extreme fear (FGI=${fg}), possibly at bottom zone, sell signal needs cautious confirmation`,
      };
    }

    // Keywords strongly bullish (>= +4) -> warn (may be counter-trend sell)
    if (newsScore >= 4) {
      return {
        action: "warn",
        positionRatio: baseRatio * 0.5,
        reason: `News keywords strongly bullish (score=${newsScore}), halving sell to avoid counter-trend`,
      };
    }

    // Macro sentiment bullish, conflicts with sell signal
    if (sentiment === "bullish") {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `Overall market sentiment bullish (FGI=${fg}), conflicts with sell signal, halving position close`,
      };
    }

    return {
      action: "execute",
      positionRatio: baseRatio,
      reason: `Neutral/bearish sentiment (FGI=${fg}, news score=${newsScoreLabel})`,
    };
  }

  return { action: "execute", positionRatio: baseRatio, reason: "No conflict" };
}

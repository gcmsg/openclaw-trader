/**
 * News and Sentiment Monitoring Script
 * Triggered by cron every 4 hours, analyzes market sentiment and notifies AI Agent
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import {
  getFearGreedIndex,
  getLatestNews,
  getGlobalMarket,
  getPriceChanges,
  type NewsItem,
  type FearGreedData,
  type GlobalMarketData,
} from "./fetcher.js";
// sendNewsReport has been moved to openclaw.ts, monitor calls notifyStatus directly
import { ping } from "../health/heartbeat.js";
import { analyzeSentimentWithLLM, llmResultToEntry } from "./llm-sentiment.js";
import { writeSentimentCache } from "./sentiment-cache.js";
import type { StrategyConfig } from "../types.js";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("news", path.resolve(__dirname, "../../logs/news-monitor.log"));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const STATE_PATH = path.resolve(__dirname, "../../logs/news-state.json");

function loadConfig(): StrategyConfig {
  return parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
}

interface NewsState {
  lastRunAt: number;
  lastFearGreed: number;
}

function loadState(): NewsState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as NewsState;
  } catch (_e: unknown) {
    return { lastRunAt: 0, lastFearGreed: 50 };
  }
}

function saveState(state: NewsState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Fear & Greed Index interpretation */
function interpretFearGreed(value: number): string {
  if (value <= 20) return "Extreme Fear 😱 — historically often a buying opportunity";
  if (value <= 40) return "Fear 😰 — pessimistic market sentiment, possibly oversold";
  if (value <= 60) return "Neutral 😐 — wait and see";
  if (value <= 80) return "Greed 😏 — watch for risk, possibly overbought";
  return "Extreme Greed 🤑 — historically often a sell signal";
}

/** Filter important news from news list (using fetcher's important flag + local keyword fallback) */
function filterImportantNews(news: NewsItem[]): NewsItem[] {
  const EXTRA_KEYWORDS = [
    "BlackRock",
    "MicroStrategy",
    "Tesla",
    "institutional",
    "halving",
    "upgrade",
    "bankrupt",
    "FTX",
  ];

  return news.filter((n) => {
    if (n.important) return true;
    const text = n.title.toLowerCase();
    return EXTRA_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
  });
}

/** Assess overall market trend sentiment */
function assessMarketSentiment(
  fearGreed: FearGreedData,
  globalMarket: GlobalMarketData,
  priceChanges: { symbol: string; priceChangePercent: number }[]
): "bullish" | "bearish" | "neutral" {
  let score = 0;

  // Fear & Greed Index
  if (fearGreed.value > 60) score += 1;
  else if (fearGreed.value < 40) score -= 1;

  // Global market cap change
  if (globalMarket.marketCapChangePercent24h > 2) score += 1;
  else if (globalMarket.marketCapChangePercent24h < -2) score -= 1;

  // Major coin price changes
  const avgChange =
    priceChanges.reduce((a, b) => a + b.priceChangePercent, 0) / (priceChanges.length || 1);
  if (avgChange > 1) score += 1;
  else if (avgChange < -1) score -= 1;

  if (score >= 2) return "bullish";
  if (score <= -2) return "bearish";
  return "neutral";
}

async function main(): Promise<void> {
  log.info("─── News sentiment scan started ───");
  const done = ping("news_collector");

  const cfg = loadConfig();
  const state = loadState();

  // Fetch all data concurrently
  const [fearGreed, news, globalMarket, priceChanges] = await Promise.all([
    getFearGreedIndex(),
    getLatestNews(30),
    getGlobalMarket(),
    getPriceChanges(cfg.symbols),
  ]);

  log.info(`Fear & Greed Index: ${fearGreed.value} (${fearGreed.label})`);
  log.info(`Market cap change 24h: ${globalMarket.marketCapChangePercent24h.toFixed(2)}%`);
  log.info(`Fetched news: ${news.length} items`);

  const importantNews = filterImportantNews(news);
  log.info(`Important news: ${importantNews.length} items`);

  // Detect price anomalies (24h change exceeding 5%)
  const bigMovers = priceChanges.filter((p) => Math.abs(p.priceChangePercent) >= 5);

  const sentiment = assessMarketSentiment(fearGreed, globalMarket, priceChanges);
  log.info(`Market sentiment: ${sentiment}`);

  // Fear & Greed Index change exceeding 15 points, extra alert
  const fgDelta = fearGreed.value - state.lastFearGreed;
  const fgAlert = Math.abs(fgDelta) >= 15;
  if (fgAlert) {
    log.warn(`⚠️ Fear & Greed Index significant change: ${state.lastFearGreed} -> ${fearGreed.value}`);
  }

  // Write report to file (read and analyzed by OpenClaw Agent)
  const reportPath = path.resolve(__dirname, "../../logs/news-report.json");
  const report = {
    generatedAt: new Date().toISOString(),
    fearGreed,
    fearGreedInterpret: interpretFearGreed(fearGreed.value),
    globalMarket,
    sentiment,
    importantNews,
    bigMovers,
    fgAlert,
    fgDelta,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log.info(`Report written to: ${reportPath}`);

  // ── LLM semantic sentiment analysis (automated, non-blocking failure) ──────────────────
  // Automatically analyzes after each news_collector run, updates 6h sentiment cache
  // Auto-skips when OPENCLAW_GATEWAY_TOKEN is not configured
  try {
    const headlines = importantNews.slice(0, 10).map((n) => n.title);
    const llmResult = await analyzeSentimentWithLLM({
      headlines,
      fearGreed: fearGreed.value,
      btcDominance: 0, // dominance is maintained by btc-dominance.ts, passing 0 as fallback
      marketCapChange: globalMarket.marketCapChangePercent24h,
    });

    if (llmResult) {
      const entry = llmResultToEntry(llmResult, headlines.length);
      writeSentimentCache(entry);
      log.info(`🧠 LLM sentiment analysis complete: ${entry.label} (${entry.score}/10)`);
    } else {
      log.warn("⚠️ LLM sentiment analysis skipped (Gateway Token not configured or empty response)");
    }
  } catch (err: unknown) {
    // LLM failure does not block main flow, continue with keyword fallback
    log.warn(`⚠️ LLM sentiment analysis failed (falling back to keywords): ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Update state ────────────────────────────────────────
  saveState({
    lastRunAt: Date.now(),
    lastFearGreed: fearGreed.value,
  });

  done();
  log.info("─── News sentiment scan complete ───\n");


}

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

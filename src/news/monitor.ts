/**
 * 新闻与情绪监控脚本
 * 每 4 小时由 cron 触发，分析市场情绪并通知 AI Agent
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
// sendNewsReport 已移至 openclaw.ts，monitor 直接调用 notifyStatus
import { ping } from "../health/heartbeat.js";
import type { StrategyConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const STATE_PATH = path.resolve(__dirname, "../../logs/news-state.json");
const LOG_PATH = path.resolve(__dirname, "../../logs/news-monitor.log");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

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

/** 恐惧贪婪指数解读 */
function interpretFearGreed(value: number): string {
  if (value <= 20) return "极度恐惧 😱 — 历史上往往是买入良机";
  if (value <= 40) return "恐惧 😰 — 市场情绪悲观，可能超卖";
  if (value <= 60) return "中性 😐 — 观望为主";
  if (value <= 80) return "贪婪 😏 — 注意风险，可能超买";
  return "极度贪婪 🤑 — 历史上往往是卖出信号";
}

/** 从新闻列表里过滤重要新闻（使用 fetcher 的 important 标记 + 本地关键词兜底） */
function filterImportantNews(news: NewsItem[]): NewsItem[] {
  const EXTRA_KEYWORDS = [
    "BlackRock",
    "MicroStrategy",
    "Tesla",
    "institutional",
    "halving",
    "减半",
    "upgrade",
    "升级",
    "bankrupt",
    "破产",
    "FTX",
  ];

  return news.filter((n) => {
    if (n.important) return true;
    const text = n.title.toLowerCase();
    return EXTRA_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
  });
}

/** 判断市场整体趋势情绪 */
function assessMarketSentiment(
  fearGreed: FearGreedData,
  globalMarket: GlobalMarketData,
  priceChanges: { symbol: string; priceChangePercent: number }[]
): "bullish" | "bearish" | "neutral" {
  let score = 0;

  // 恐惧贪婪指数
  if (fearGreed.value > 60) score += 1;
  else if (fearGreed.value < 40) score -= 1;

  // 全球市值变化
  if (globalMarket.marketCapChangePercent24h > 2) score += 1;
  else if (globalMarket.marketCapChangePercent24h < -2) score -= 1;

  // 主流币价格变化
  const avgChange =
    priceChanges.reduce((a, b) => a + b.priceChangePercent, 0) / (priceChanges.length || 1);
  if (avgChange > 1) score += 1;
  else if (avgChange < -1) score -= 1;

  if (score >= 2) return "bullish";
  if (score <= -2) return "bearish";
  return "neutral";
}

async function main(): Promise<void> {
  log("─── 新闻情绪扫描开始 ───");
  const done = ping("news_collector");

  const cfg = loadConfig();
  const state = loadState();

  // 并发拉取所有数据
  const [fearGreed, news, globalMarket, priceChanges] = await Promise.all([
    getFearGreedIndex(),
    getLatestNews(30),
    getGlobalMarket(),
    getPriceChanges(cfg.symbols),
  ]);

  log(`恐惧贪婪指数: ${fearGreed.value} (${fearGreed.label})`);
  log(`市值变化24h: ${globalMarket.marketCapChangePercent24h.toFixed(2)}%`);
  log(`获取新闻: ${news.length} 条`);

  const importantNews = filterImportantNews(news);
  log(`重要新闻: ${importantNews.length} 条`);

  // 检测价格异动（24h 涨跌超过 5%）
  const bigMovers = priceChanges.filter((p) => Math.abs(p.priceChangePercent) >= 5);

  const sentiment = assessMarketSentiment(fearGreed, globalMarket, priceChanges);
  log(`市场情绪: ${sentiment}`);

  // 恐惧贪婪指数变化超过 15 点，额外提醒
  const fgDelta = fearGreed.value - state.lastFearGreed;
  const fgAlert = Math.abs(fgDelta) >= 15;
  if (fgAlert) {
    log(`⚠️ 恐惧贪婪指数大幅变化: ${state.lastFearGreed} → ${fearGreed.value}`);
  }

  // 将报告写入文件（由 OpenClaw Agent 读取分析）
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
  log(`报告已写入: ${reportPath}`);

  // 更新状态
  saveState({
    lastRunAt: Date.now(),
    lastFearGreed: fearGreed.value,
  });

  done();
  log("─── 新闻情绪扫描完成 ───\n");
}

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

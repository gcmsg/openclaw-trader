/**
 * 完整市场分析脚本
 *
 * 整合：宏观数据 + 资金费率/OI + 多时间框架技术分析
 * 输出结构化报告，供 Telegram 发送。
 *
 * 使用：
 *   npm run analysis              # 全量分析（约 30s）
 *   npm run analysis -- --quick   # 只分析 BTC/ETH（约 10s）
 */

import { getMacroContext, formatMacroReport } from "../exchange/macro-data.js";
import { getBatchFuturesData, formatFundingRateReport } from "../exchange/futures-data.js";
import { getBatchMultiTfContext, formatMultiTfReport } from "../strategy/market-context.js";
import { getDerivativesSnapshot, formatDerivativesReport } from "../exchange/derivatives-data.js";
import { getOnChainContext, formatOnChainReport } from "../exchange/onchain-data.js";
import { getNewsDigest, formatNewsDigest } from "../news/digest.js";
import { loadNewsReport, scoreNewsTitles } from "../news/sentiment-gate.js";
import { writeKeywordSentimentCache, writeSentimentCache } from "../news/sentiment-cache.js";
import { analyzeSentimentWithLLM, llmResultToEntry, formatLLMSentimentReport } from "../news/llm-sentiment.js";
import { loadStrategyConfig } from "../config/loader.js";
import { getKlines } from "../exchange/binance.js";
import type { Timeframe } from "../types.js";

const ALL_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
const QUICK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const FUTURES_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]; // 流动性足够的合约品种

const isQuick = process.argv.includes("--quick");
const symbols = isQuick ? QUICK_SYMBOLS : ALL_SYMBOLS;

async function getCurrentPrices(syms: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  const results = await Promise.allSettled(
    syms.map(async (sym) => {
      const klines = await getKlines(sym, "1h", 2);
      return { sym, price: klines[klines.length - 1]?.close ?? 0 };
    })
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.price > 0) {
      prices[r.value.sym] = r.value.price;
    }
  }
  return prices;
}

async function main() {
  const startTime = Date.now();
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  console.log(`\n🔍 开始市场分析 ${now} ${isQuick ? "(快速模式)" : "(完整模式)"}\n`);

  // ── 并发拉取所有数据 ──────────────────────────────────
  console.log("📡 获取数据中...");

  const baseCfg = loadStrategyConfig();

  const [prices, macro] = await Promise.all([
    getCurrentPrices(symbols),
    getMacroContext(),
  ]);

  // 先拿到价格，再并发拉其余数据
  // 读取本地新闻报告（供 LLM 分析用）
  const localNewsReport = loadNewsReport();
  const llmInputHeadlines = localNewsReport?.importantNews.map((n) => n.title) ?? [];
  const llmFgValue = localNewsReport?.fearGreed.value ?? 50;
  const llmBtcDom = localNewsReport?.globalMarket.btcDominance ?? 50;
  const llmMktChange = localNewsReport?.globalMarket.marketCapChangePercent24h ?? 0;

  // 并发拉取所有数据 + LLM 分析（同步进行，互不阻塞）
  const [futuresData, multiTf, btcDeriv, ethDeriv, onchain, newsDigest, llmSentiment] = await Promise.all([
    getBatchFuturesData(FUTURES_SYMBOLS, prices),
    getBatchMultiTfContext(symbols, baseCfg, ["1h", "4h", "1d"] as Timeframe[]),
    getDerivativesSnapshot("BTCUSDT").catch(() => null),
    getDerivativesSnapshot("ETHUSDT").catch(() => null),
    getOnChainContext().catch(() => null),
    isQuick ? Promise.resolve(null) : getNewsDigest(12).catch(() => null),
    llmInputHeadlines.length > 0
      ? analyzeSentimentWithLLM({
          headlines: llmInputHeadlines,
          fearGreed: llmFgValue,
          btcDominance: llmBtcDom,
          marketCapChange: llmMktChange,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  // 读取情绪报告（复用已加载的 localNewsReport）
  let fearGreed: string | null = null;
  if (localNewsReport?.fearGreed) {
    const fgi = localNewsReport.fearGreed;
    fearGreed = `${fgi.value}/100 `;
  }

  // ── 组装报告 ──────────────────────────────────────────

  const separator = "━".repeat(44);
  const sections: string[] = [];

  // 1. 标题
  sections.push(
    `📊 **市场分析报告**\n⏰ ${now}\n${separator}`
  );

  // 2. 宏观背景
  sections.push(formatMacroReport(macro));

  // 3. 情绪指数
  if (fearGreed) {
    sections.push(`\n😨 **恐惧贪婪指数**: ${fearGreed}`);
  }

  // 4. 资金费率 + OI
  sections.push(`\n${separator}`);
  sections.push(formatFundingRateReport(futuresData));

  // 4.5 衍生品情报（Basis + L/S 比 + 期权）
  if (btcDeriv ?? ethDeriv) {
    sections.push(`\n${separator}`);
    if (btcDeriv) sections.push(formatDerivativesReport(btcDeriv));
    if (ethDeriv) sections.push(formatDerivativesReport(ethDeriv));
  }

  // 4.7 链上数据（稳定币流向 + BTC 网络）
  if (onchain) {
    sections.push(`\n${separator}`);
    sections.push(formatOnChainReport(onchain));
  }

  // 4.9 新闻摘要（完整模式才拉，供 AI 分析用）
  if (newsDigest) {
    sections.push(`\n${separator}`);
    sections.push(formatNewsDigest(newsDigest));
  }

  // 4.95 LLM 语义情绪分析
  if (llmSentiment) {
    sections.push(`\n${separator}`);
    sections.push(formatLLMSentimentReport(llmSentiment));
  }

  // 5. 多 TF 技术面扫描
  sections.push(`\n${separator}`);
  sections.push(formatMultiTfReport(multiTf, true));

  // 6. 关键价位
  sections.push(`\n${separator}`);
  const btcCtx = multiTf.get("BTCUSDT");
  const ethCtx = multiTf.get("ETHUSDT");
  if (btcCtx || ethCtx) {
    const keyLines: string[] = ["📍 **关键价位**\n"];
    if (btcCtx) {
      const ppNote = btcCtx.pivotPP ? `  PP $${btcCtx.pivotPP.toFixed(0)}` : "";
      keyLines.push(
        `BTC $${prices["BTCUSDT"]?.toFixed(0) ?? "?"} | 支撑 $${btcCtx.supportLevel.toFixed(0)} | 阻力 $${btcCtx.resistanceLevel.toFixed(0)}${ppNote}`
      );
    }
    if (ethCtx) {
      const ppNote = ethCtx.pivotPP ? `  PP $${ethCtx.pivotPP.toFixed(0)}` : "";
      keyLines.push(
        `ETH $${prices["ETHUSDT"]?.toFixed(0) ?? "?"} | 支撑 $${ethCtx.supportLevel.toFixed(0)} | 阻力 $${ethCtx.resistanceLevel.toFixed(0)}${ppNote}`
      );
    }
    sections.push(keyLines.join("\n"));
  }

  // 7. 综合操作建议
  sections.push(`\n${separator}`);
  const strongSignals = [...multiTf.entries()].filter(([, c]) => c.signalStrength === "strong" || c.signalStrength === "medium");
  const opLines: string[] = ["🎯 **综合操作建议**\n"];

  if (macro.cryptoEnvironment === "risk_off") {
    opLines.push("⚠️ 宏观环境偏负，建议以防守为主，减少新开仓");
  } else if (macro.cryptoEnvironment === "risk_on") {
    opLines.push("✅ 宏观环境有利，可适当积极");
  }

  if (strongSignals.length > 0) {
    for (const [sym, ctx] of strongSignals) {
      const coin = sym.replace("USDT", "");
      const fr = futuresData.get(sym);
      const frNote = fr ? `（资金费率 ${fr.fundingRate.fundingRateStr}）` : "";
      opLines.push(`→ ${coin}: ${ctx.summary}${frNote}`);
    }
  } else {
    opLines.push("→ 当前无明显高置信信号，建议观望");
  }

  opLines.push("\n_所有建议需主人确认后执行_");
  sections.push(opLines.join("\n"));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  sections.push(`\n${separator}\n⏱️ 分析耗时 ${elapsed}s`);

  const fullReport = sections.join("\n");

  // ── 自动更新情绪缓存（优先 LLM，降级关键词）──
  try {
    if (llmSentiment && llmInputHeadlines.length > 0) {
      // LLM 分析成功 → 写入高质量缓存
      const entry = llmResultToEntry(llmSentiment, llmInputHeadlines.length);
      writeSentimentCache({
        score: entry.score,
        label: entry.label,
        bullishReasons: entry.bullishReasons,
        bearishReasons: entry.bearishReasons,
        headlineCount: entry.headlineCount,
        ...(entry.analyzedBy !== undefined ? { analyzedBy: entry.analyzedBy } : {}),
      });
    } else if (localNewsReport?.importantNews) {
      // 降级：关键词匹配
      const kwScore = scoreNewsTitles(localNewsReport.importantNews.map((n) => n.title));
      const fg = localNewsReport.fearGreed.value;
      const fgAdjust = fg < 20 ? -2 : fg > 75 ? 2 : 0;
      writeKeywordSentimentCache(kwScore - fgAdjust, localNewsReport.importantNews.length);
    }
  } catch { /* 不影响主流程 */ }

  // 输出到 console（cron 任务会通过 announce 发到 Telegram）
  console.log("\n" + fullReport);

  return fullReport;
}

main().catch((e: unknown) => {
  console.error("分析失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

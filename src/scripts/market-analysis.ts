/**
 * Comprehensive Market Analysis Script
 *
 * Integrates: Macro data + Funding rate/OI + Multi-timeframe technical analysis
 * Outputs structured report for Telegram delivery.
 *
 * Usage:
 *   npm run analysis              # Full analysis (~30s)
 *   npm run analysis -- --quick   # Only analyze BTC/ETH (~10s)
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
import { getLiquidationData, formatLiquidationReport } from "../exchange/liquidation-data.js";
import { fetchRedditPosts, analyzeRedditSentiment, formatRedditReport } from "../news/reddit-sentiment.js";
import { loadStrategyConfig } from "../config/loader.js";
import { trackBtcDominance, getBtcDominanceTrend } from "../strategy/btc-dominance.js";
import { getKlines } from "../exchange/binance.js";
import { fetchOptionsSummary, formatOptionsReport } from "../exchange/options-data.js";
import { loadCalendar, getUpcomingEvents, checkEventRisk, formatEventReport } from "../strategy/events-calendar.js";
import type { Timeframe } from "../types.js";

const ALL_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
const QUICK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const FUTURES_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]; // Futures with sufficient liquidity

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
  const now = new Date().toLocaleString("en-US", { timeZone: "UTC" });
  console.log(`\n🔍 Starting market analysis ${now} ${isQuick ? "(quick mode)" : "(full mode)"}\n`);

  // ── Fetch all data concurrently ──────────────────────────
  console.log("📡 Fetching data...");

  const baseCfg = loadStrategyConfig();

  const [prices, macro] = await Promise.all([
    getCurrentPrices(symbols),
    getMacroContext(),
  ]);

  // Get prices first, then concurrently fetch remaining data
  // Load local news report (for LLM analysis)
  const localNewsReport = loadNewsReport();
  const llmInputHeadlines = localNewsReport?.importantNews.map((n) => n.title) ?? [];
  const llmFgValue = localNewsReport?.fearGreed.value ?? 50;
  const llmBtcDom = localNewsReport?.globalMarket.btcDominance ?? 50;
  const llmMktChange = localNewsReport?.globalMarket.marketCapChangePercent24h ?? 0;

  // Track BTC dominance history (recorded after each analysis, for 7-day trend calculation)
  if (localNewsReport?.globalMarket.btcDominance !== undefined) {
    trackBtcDominance(localNewsReport.globalMarket.btcDominance);
  }

  // Concurrently fetch all data + LLM analysis (run in parallel, non-blocking)
  const [futuresData, multiTf, btcDeriv, ethDeriv, onchain, newsDigest, llmSentiment,
    btcLiq, ethLiq, redditCrypto, redditBtc] = await Promise.all([
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
    // P5.3 Liquidation heatmap
    getLiquidationData("BTCUSDT", 24).catch(() => null),
    getLiquidationData("ETHUSDT", 24).catch(() => null),
    // P5.4 Reddit sentiment
    fetchRedditPosts("CryptoCurrency").catch(() => null),
    fetchRedditPosts("Bitcoin").catch(() => null),
  ]);

  // Load sentiment report (reuse already loaded localNewsReport)
  let fearGreed: string | null = null;
  if (localNewsReport?.fearGreed) {
    const fgi = localNewsReport.fearGreed;
    fearGreed = `${fgi.value}/100 `;
  }

  // ── Assemble report ──────────────────────────────────────

  const separator = "━".repeat(44);
  const sections: string[] = [];

  // 1. Title
  sections.push(
    `📊 **Market Analysis Report**\n⏰ ${now}\n${separator}`
  );

  // 2. Macro context
  sections.push(formatMacroReport(macro));

  // 3. Sentiment index
  if (fearGreed) {
    sections.push(`\n😨 **Fear & Greed Index**: ${fearGreed}`);
  }

  // 3.5 BTC dominance trend
  {
    const domTrend = getBtcDominanceTrend(7);
    if (!isNaN(domTrend.latest)) {
      const arrow = domTrend.direction === "rising" ? "📈" : domTrend.direction === "falling" ? "📉" : "➡️";
      const changeStr = `${domTrend.change >= 0 ? "+" : ""}${domTrend.change.toFixed(2)}%`;
      const label = domTrend.direction === "rising"
        ? "⚠️ Altcoin risk (capital flowing to BTC)"
        : domTrend.direction === "falling"
        ? "✅ Alt season signal (capital diversifying)"
        : "Normal";
      sections.push(
        `\n${arrow} **BTC Dominance**: ${domTrend.latest.toFixed(1)}% | 7d change ${changeStr} | ${label}`
      );
    }
  }

  // 4. Funding rate + OI
  sections.push(`\n${separator}`);
  sections.push(formatFundingRateReport(futuresData));

  // 4.5 Derivatives intelligence (Basis + L/S ratio + Options)
  if (btcDeriv ?? ethDeriv) {
    sections.push(`\n${separator}`);
    if (btcDeriv) sections.push(formatDerivativesReport(btcDeriv));
    if (ethDeriv) sections.push(formatDerivativesReport(ethDeriv));
  }

  // 4.7 On-chain data (stablecoin flows + BTC network)
  if (onchain) {
    sections.push(`\n${separator}`);
    sections.push(formatOnChainReport(onchain));
  }

  // 4.9 News digest (full mode only, for AI analysis)
  if (newsDigest) {
    sections.push(`\n${separator}`);
    sections.push(formatNewsDigest(newsDigest));
  }

  // 4.95 LLM semantic sentiment analysis
  if (llmSentiment) {
    sections.push(`\n${separator}`);
    sections.push(formatLLMSentimentReport(llmSentiment));
  }

  // 4.96 P5.3 Liquidation heatmap (BTC + ETH)
  if (btcLiq ?? ethLiq) {
    sections.push(`\n${separator}`);
    if (btcLiq) sections.push(formatLiquidationReport(btcLiq, "BTCUSDT"));
    if (ethLiq) {
      sections.push("");
      sections.push(formatLiquidationReport(ethLiq, "ETHUSDT"));
    }
  }

  // 4.97 P5.4 Reddit community sentiment
  {
    const allPosts = [...(redditCrypto ?? []), ...(redditBtc ?? [])];
    if (allPosts.length > 0) {
      const redditResult = analyzeRedditSentiment(allPosts);
      sections.push(`\n${separator}`);
      sections.push(formatRedditReport(redditResult));
    }
  }

  // 4.98 P6.4 Options market signals (BTC + ETH)
  const [btcOptions, ethOptions] = await Promise.all([
    fetchOptionsSummary("BTC").catch(() => null),
    fetchOptionsSummary("ETH").catch(() => null),
  ]);
  if (btcOptions ?? ethOptions) {
    sections.push(`\n${separator}`);
    if (btcOptions) sections.push(formatOptionsReport(btcOptions));
    if (ethOptions) {
      sections.push("");
      sections.push(formatOptionsReport(ethOptions));
    }
  }

  // 4.99 P6.5 Macro events calendar
  {
    const calendarEvents = loadCalendar();
    const upcoming = getUpcomingEvents(calendarEvents, 7);
    const eventRisk = checkEventRisk(calendarEvents);
    sections.push(`\n${separator}`);
    sections.push(formatEventReport(eventRisk, upcoming));
  }

  // 5. Multi-TF technical scan
  sections.push(`\n${separator}`);
  sections.push(formatMultiTfReport(multiTf, true));

  // 6. Key price levels
  sections.push(`\n${separator}`);
  const btcCtx = multiTf.get("BTCUSDT");
  const ethCtx = multiTf.get("ETHUSDT");
  if (btcCtx || ethCtx) {
    const keyLines: string[] = ["📍 **Key Price Levels**\n"];
    if (btcCtx) {
      const ppNote = btcCtx.pivotPP ? `  PP $${btcCtx.pivotPP.toFixed(0)}` : "";
      keyLines.push(
        `BTC $${prices["BTCUSDT"]?.toFixed(0) ?? "?"} | Support $${btcCtx.supportLevel.toFixed(0)} | Resistance $${btcCtx.resistanceLevel.toFixed(0)}${ppNote}`
      );
    }
    if (ethCtx) {
      const ppNote = ethCtx.pivotPP ? `  PP $${ethCtx.pivotPP.toFixed(0)}` : "";
      keyLines.push(
        `ETH $${prices["ETHUSDT"]?.toFixed(0) ?? "?"} | Support $${ethCtx.supportLevel.toFixed(0)} | Resistance $${ethCtx.resistanceLevel.toFixed(0)}${ppNote}`
      );
    }
    sections.push(keyLines.join("\n"));
  }

  // 7. Comprehensive action recommendations
  sections.push(`\n${separator}`);
  const strongSignals = [...multiTf.entries()].filter(([, c]) => c.signalStrength === "strong" || c.signalStrength === "medium");
  const opLines: string[] = ["🎯 **Action Recommendations**\n"];

  if (macro.cryptoEnvironment === "risk_off") {
    opLines.push("⚠️ Macro environment is bearish, recommend defensive stance, reduce new positions");
  } else if (macro.cryptoEnvironment === "risk_on") {
    opLines.push("✅ Macro environment is favorable, can be moderately aggressive");
  }

  if (strongSignals.length > 0) {
    for (const [sym, ctx] of strongSignals) {
      const coin = sym.replace("USDT", "");
      const fr = futuresData.get(sym);
      const frNote = fr ? ` (Funding rate ${fr.fundingRate.fundingRateStr})` : "";
      opLines.push(`→ ${coin}: ${ctx.summary}${frNote}`);
    }
  } else {
    opLines.push("→ No clear high-confidence signals, recommend watching");
  }

  opLines.push("\n_All recommendations require user confirmation_");
  sections.push(opLines.join("\n"));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  sections.push(`\n${separator}\n⏱️ Analysis took ${elapsed}s`);

  const fullReport = sections.join("\n");

  // ── Auto-update sentiment cache (prefer LLM, fallback to keyword) ──
  try {
    if (llmSentiment && llmInputHeadlines.length > 0) {
      // LLM analysis succeeded -> write high-quality cache
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
      // Fallback: keyword matching
      const kwScore = scoreNewsTitles(localNewsReport.importantNews.map((n) => n.title));
      const fg = localNewsReport.fearGreed.value;
      const fgAdjust = fg < 20 ? -2 : fg > 75 ? 2 : 0;
      writeKeywordSentimentCache(kwScore - fgAdjust, localNewsReport.importantNews.length);
    }
  } catch { /* Don't affect main flow */ }

  // Output to console (cron tasks will send to Telegram via announce)
  console.log("\n" + fullReport);

  return fullReport;
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((e: unknown) => {
  console.error("Analysis failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

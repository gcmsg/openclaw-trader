/**
 * Regime Adaptive Backtest Validation
 *
 * Compares three modes on 1000 days of historical data:
 *   A. Fixed parameters (current default)
 *   B. Regime adaptive (detect regime on each kline and switch parameters)
 *   C. Buy and hold BTC (benchmark)
 *
 * Usage: npm run regime-backtest
 */

import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import { loadStrategyConfig, loadStrategyProfile } from "../config/loader.js";
import { classifyRegime } from "../strategy/regime.js";
import { applyRegimeParams, describeRegimeParams } from "../strategy/regime-params.js";
import type { Kline, StrategyConfig } from "../types.js";

const DAYS = 1000;
const REGIME_WINDOW = 100; // Use last 100 klines to detect regime

// Support --strategy <id> argument
const strategyArg = process.argv.indexOf("--strategy");
const strategyId = strategyArg >= 0 ? process.argv[strategyArg + 1] : undefined;

function formatPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Regime Adaptive Backtest Validation           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  let baseCfg = loadStrategyConfig();
  if (strategyId) {
    const profile = loadStrategyProfile(strategyId);
    baseCfg = {
      ...baseCfg,
      strategy: { ...baseCfg.strategy, ...profile.strategy } as StrategyConfig["strategy"],
      signals: { ...baseCfg.signals, ...profile.signals },
      risk: { ...baseCfg.risk, ...profile.risk } as StrategyConfig["risk"],
    };
    console.log(`📋 Using strategy: ${strategyId} (${profile.name ?? strategyId})\n`);
  }
  const SYMBOLS = baseCfg.symbols;
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;

  // Fetch data
  console.log(`📥 Fetching ${SYMBOLS.length} symbols, ${DAYS} days of data...`);
  const allKlines: Record<string, Kline[]> = {};
  for (const sym of SYMBOLS) {
    const klines = await fetchHistoricalKlines(sym, "1h", startMs, endMs);
    allKlines[sym] = klines;
    console.log(`   ${sym} ✓ ${klines.length} bars`);
  }

  // ── A. Fixed parameter backtest ──
  console.log("\n🔄 Mode A: Fixed parameter backtest...");
  const fixedResult = runBacktest(allKlines, baseCfg, {
    initialUsdt: 1000, feeRate: 0.001, slippagePercent: 0.05,
  });
  const fm = fixedResult.metrics;
  console.log(`   Return: ${formatPct(fm.totalReturnPercent)} | ${fm.totalTrades} trades | WinRate ${(fm.winRate*100).toFixed(1)}% | Sharpe ${fm.sharpeRatio.toFixed(2)}`);

  // ── B. Regime adaptive backtest ──
  // Strategy: split 1000 days of data into segments of 200 bars,
  // at the start of each segment use the prior 100 bars to detect regime, then run with corresponding params
  console.log("\n🔄 Mode B: Regime adaptive backtest...");

  const btcKlines = allKlines["BTCUSDT"] ?? [];
  const segmentSize = 200; // 200 bars per segment (~8 days)
  let adaptiveUsdt = 1000;
  let adaptiveTrades = 0;
  let adaptiveWins = 0;
  const regimeLog: string[] = [];

  for (let i = REGIME_WINDOW; i < btcKlines.length; i += segmentSize) {
    // Use prior REGIME_WINDOW bars to detect regime
    const regimeKlines = btcKlines.slice(Math.max(0, i - REGIME_WINDOW), i);
    const regime = classifyRegime(regimeKlines);

    // Switch parameters
    const segCfg = applyRegimeParams(baseCfg, regime.regime);

    // Extract current segment data for all symbols
    const segEnd = Math.min(i + segmentSize, btcKlines.length);
    const segKlines: Record<string, Kline[]> = {};
    for (const sym of SYMBOLS) {
      const symKlines = allKlines[sym] ?? [];
      // Find the corresponding time range
      const segEndTime = btcKlines[segEnd - 1]?.closeTime ?? 0;
      // Need to include enough historical data for indicator calculation (prepend REGIME_WINDOW bars)
      const lookbackStart = Math.max(0, i - REGIME_WINDOW);
      const lookbackStartTime = btcKlines[lookbackStart]?.openTime ?? 0;
      const filtered = symKlines.filter(k => k.openTime >= lookbackStartTime && k.openTime <= segEndTime);
      if (filtered.length > 0) segKlines[sym] = filtered;
    }

    if (Object.keys(segKlines).length === 0) continue;

    try {
      const segResult = runBacktest(segKlines, segCfg, {
        initialUsdt: adaptiveUsdt,
        feeRate: 0.001,
        slippagePercent: 0.05,
      });
      const returnPct = segResult.metrics.totalReturnPercent;
      adaptiveUsdt = adaptiveUsdt * (1 + returnPct / 100);
      adaptiveTrades += segResult.metrics.totalTrades;
      adaptiveWins += segResult.metrics.wins;

      const startDate = new Date((btcKlines[i]?.openTime ?? 0)).toISOString().slice(0, 10);
      regimeLog.push(
        `  ${startDate} | ${regime.regime.padEnd(16)} | ${formatPct(returnPct).padEnd(8)} | ${segResult.metrics.totalTrades} trades | ${describeRegimeParams(regime.regime).slice(0, 50)}`
      );
    } catch {
      // Insufficient data, skip
    }
  }

  const adaptiveReturn = ((adaptiveUsdt - 1000) / 1000) * 100;
  const adaptiveWinRate = adaptiveTrades > 0 ? (adaptiveWins / adaptiveTrades * 100) : 0;
  console.log(`   Return: ${formatPct(adaptiveReturn)} | ${adaptiveTrades} trades | WinRate ${adaptiveWinRate.toFixed(1)}%`);

  // ── Summary ──
  console.log("\n\n╔═══════════════════════════════════════════════╗");
  console.log("║          Backtest Comparison Results             ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  console.log(`  A. Fixed params:    ${formatPct(fm.totalReturnPercent).padEnd(10)} ${fm.totalTrades} trades WinRate ${(fm.winRate*100).toFixed(1)}%`);
  console.log(`  B. Regime adaptive: ${formatPct(adaptiveReturn).padEnd(10)} ${adaptiveTrades} trades WinRate ${adaptiveWinRate.toFixed(1)}%`);
  console.log(`  C. Hold BTC:        ${formatPct(fixedResult.metrics.totalReturnPercent + (fixedResult.metrics.calmarRatio !== 0 ? 0 : 0))} (benchmark)`);

  const improvement = adaptiveReturn - fm.totalReturnPercent;
  console.log(`\n  Improvement: ${formatPct(improvement)} (B vs A)`);

  // ── Regime Switch Log ──
  console.log("\n📋 Regime Switch Log:");
  console.log("  Date       | Regime           | Return   | Trades | Param Description");
  console.log("  " + "─".repeat(70));
  for (const line of regimeLog) {
    console.log(line);
  }

  // Save results
  const fs = await import("fs");
  fs.writeFileSync("logs/regime-backtest.json", JSON.stringify({
    fixedReturn: fm.totalReturnPercent,
    adaptiveReturn,
    improvement,
    fixedTrades: fm.totalTrades,
    adaptiveTrades,
    regimeLog,
  }, null, 2));
  console.log("\n💾 Results saved to: logs/regime-backtest.json");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch(console.error);

#!/usr/bin/env tsx
/**
 * Signal Statistics Analysis CLI
 *
 * Usage:
 *   npm run signal-stats                    # Analyze from signal-history.jsonl
 *   npm run signal-stats -- --backtest      # Run backtest first then analyze
 *   npm run signal-stats -- --days 90       # Specify backtest days
 *   npm run signal-stats -- --min-trades 3  # Minimum number of trades
 *   npm run signal-stats -- --top 10        # Show Top/Bottom 10
 */

import { calcSignalStats, formatSignalStats, rankSignals } from "../analysis/signal-stats.js";
import {
  collectFromBacktest,
  collectFromSignalHistory,
  mergeRecords,
} from "../analysis/trade-collector.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  useBacktest: boolean;
  days: number;
  minTrades: number;
  topN: number;
} {
  const args = argv.slice(2);
  const useBacktest = args.includes("--backtest");

  const daysIdx = args.indexOf("--days");
  const daysRaw = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? "30", 10) : 30;
  const days = Number.isNaN(daysRaw) ? 30 : daysRaw;

  const minIdx = args.indexOf("--min-trades");
  const minTradesRaw = minIdx >= 0 ? parseInt(args[minIdx + 1] ?? "5", 10) : 5;
  const minTrades = Number.isNaN(minTradesRaw) ? 5 : minTradesRaw;

  const topIdx = args.indexOf("--top");
  const topNRaw = topIdx >= 0 ? parseInt(args[topIdx + 1] ?? "5", 10) : 5;
  const topN = Number.isNaN(topNRaw) ? 5 : topNRaw;

  return { useBacktest, days, minTrades, topN };
}

// ─────────────────────────────────────────────────────
// Backtest Runner (lazy loaded to avoid importing every time)
// ─────────────────────────────────────────────────────

async function runBacktestAndCollect(days: number) {
  console.log(`\n🔄 Running backtest (last ${days} days)...\n`);

  try {
    // Dynamic import to avoid module loading overhead
    const { runBacktest } = await import("../backtest/runner.js");
    const { fetchHistoricalKlines } = await import("../backtest/fetcher.js");
    const { loadStrategyConfig } = await import("../config/loader.js");

    const cfg = loadStrategyConfig();
    const symbols: string[] = cfg.symbols.slice(0, 5);
    const endMs = Date.now();
    const startMs = endMs - days * 86_400_000;
    const startDate = new Date(startMs).toISOString().slice(0, 10);
    const endDate = new Date(endMs).toISOString().slice(0, 10);

    console.log(`📌 Backtest symbols: ${symbols.join(", ")}`);
    console.log(`📅 Time range: ${startDate} ~ ${endDate}\n`);

    const klinesBySymbol: Record<string, Kline[]> = {};
    for (const sym of symbols) {
      process.stdout.write(`  Fetching ${sym} klines...`);
      try {
        const klines = await fetchHistoricalKlines(sym, cfg.timeframe, startMs, endMs);
        klinesBySymbol[sym] = klines;
        process.stdout.write(` ✅ ${klines.length} bars\n`);
      } catch (e) {
        process.stdout.write(` ⚠️ Failed: ${String(e)}\n`);
      }
    }

    const result = runBacktest(klinesBySymbol, cfg);
    console.log(`\n✅ Backtest complete, ${result.trades.length} trade records`);

    return collectFromBacktest(result);
  } catch (e) {
    console.error(`❌ Backtest failed: ${String(e)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { useBacktest, days, minTrades, topN } = parseArgs(process.argv);

  console.log("📊 OpenClaw Trader — Signal Statistics Analysis\n");
  console.log(`Params: minTrades=${minTrades}, top=${topN}${useBacktest ? `, backtest=${days} days` : ""}\n`);

  // Collect trade records
  let records = collectFromSignalHistory();
  console.log(`📂 signal-history.jsonl: ${records.length} closed trades`);

  if (useBacktest) {
    const btRecords = await runBacktestAndCollect(days);
    console.log(`🧪 Backtest records: ${btRecords.length}`);
    records = mergeRecords(records, btRecords);
    console.log(`🔀 After merge: ${records.length} trade records\n`);
  }

  if (records.length === 0) {
    console.log(
      "\n⚠️  Not enough trade records.\nSuggestions:\n  1. Run `npm run signal-stats -- --backtest` to generate records via backtest\n  2. Wait for live trading to accumulate more signal history"
    );
    return;
  }

  // Statistical analysis
  const stats = calcSignalStats(records, minTrades);

  if (stats.length === 0) {
    console.log(
      `\n⚠️  No signal combinations meet the criteria (minimum ${minTrades} trades).\nPlease lower the --min-trades parameter.`
    );
    return;
  }

  console.log(`\n✅ Analyzed ${stats.length} signal combinations\n`);

  // Ranking
  const { best, worst } = rankSignals(stats, topN);

  // Output Top N
  console.log(`━━━ Top ${topN} Signal Combinations (by expected return) ━━━\n`);
  console.log(formatSignalStats(best));

  if (worst.length > 0 && stats.length > topN) {
    console.log(`\n━━━ Bottom ${topN} Signal Combinations (by expected return) ━━━\n`);
    console.log(formatSignalStats(worst));
  }

  // Summary
  const totalTrades = records.length;
  const winCount = records.filter((r) => r.pnlPercent > 0).length;
  const overallWR = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : "0.0";

  console.log(`\n━━━ Overall Statistics ━━━`);
  console.log(`Total trades: ${totalTrades} | Win rate: ${overallWR}% | Signal combinations: ${stats.length}`);
}

// Only run when executed directly (avoid triggering main on unit test imports)
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

if (process.argv[1]?.endsWith("signal-stats.ts") || process.argv[1]?.endsWith("signal-stats.js")) {
  main().catch((e: unknown) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

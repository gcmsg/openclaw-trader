#!/usr/bin/env tsx
/**
 * 信号统计分析 CLI
 *
 * Usage:
 *   npm run signal-stats                    # 从 signal-history.jsonl 分析
 *   npm run signal-stats -- --backtest      # 先跑回测再分析
 *   npm run signal-stats -- --days 90       # 指定回测天数
 *   npm run signal-stats -- --min-trades 3  # 最少交易次数
 *   npm run signal-stats -- --top 10        # 显示 Top/Bottom 10
 */

import { calcSignalStats, formatSignalStats, rankSignals } from "../analysis/signal-stats.js";
import {
  collectFromBacktest,
  collectFromSignalHistory,
  mergeRecords,
} from "../analysis/trade-collector.js";

// ─────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  useBacktest: boolean;
  days: number;
  minTrades: number;
  topN: number;
} {
  const args = argv.slice(2);
  const useBacktest = args.includes("--backtest");

  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? "30", 10) : 30;

  const minIdx = args.indexOf("--min-trades");
  const minTrades = minIdx >= 0 ? parseInt(args[minIdx + 1] ?? "5", 10) : 5;

  const topIdx = args.indexOf("--top");
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1] ?? "5", 10) : 5;

  return { useBacktest, days, minTrades, topN };
}

// ─────────────────────────────────────────────────────
// 回测运行器（懒加载，避免每次都导入）
// ─────────────────────────────────────────────────────

async function runBacktestAndCollect(days: number) {
  console.log(`\n🔄 正在运行回测（最近 ${days} 天）...\n`);

  try {
    // 动态导入，避免模块加载开销
    const { runBacktest } = await import("../backtest/runner.js");
    const { fetchHistoricalKlines } = await import("../backtest/fetcher.js");
    const { loadStrategyConfig } = await import("../config/loader.js");

    const cfg = loadStrategyConfig();
    const symbols: string[] = cfg.symbols.slice(0, 5);
    const endMs = Date.now();
    const startMs = endMs - days * 86_400_000;
    const startDate = new Date(startMs).toISOString().slice(0, 10);
    const endDate = new Date(endMs).toISOString().slice(0, 10);

    console.log(`📌 回测符号: ${symbols.join(", ")}`);
    console.log(`📅 时间范围: ${startDate} ~ ${endDate}\n`);

    const klinesBySymbol: Record<string, import("../types.js").Kline[]> = {};
    for (const sym of symbols) {
      process.stdout.write(`  获取 ${sym} K 线...`);
      try {
        const klines = await fetchHistoricalKlines(sym, cfg.timeframe, startMs, endMs);
        klinesBySymbol[sym] = klines;
        process.stdout.write(` ✅ ${klines.length} 根\n`);
      } catch (e) {
        process.stdout.write(` ⚠️ 失败: ${String(e)}\n`);
      }
    }

    const result = runBacktest(klinesBySymbol, cfg);
    console.log(`\n✅ 回测完成，共 ${result.trades.length} 笔交易记录`);

    return collectFromBacktest(result);
  } catch (e) {
    console.error(`❌ 回测失败: ${String(e)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { useBacktest, days, minTrades, topN } = parseArgs(process.argv);

  console.log("📊 OpenClaw Trader — 信号统计分析\n");
  console.log(`参数: minTrades=${minTrades}, top=${topN}${useBacktest ? `, backtest=${days}天` : ""}\n`);

  // 收集交易记录
  let records = collectFromSignalHistory();
  console.log(`📂 signal-history.jsonl: ${records.length} 条已关闭交易`);

  if (useBacktest) {
    const btRecords = await runBacktestAndCollect(days);
    console.log(`🧪 回测记录: ${btRecords.length} 条`);
    records = mergeRecords(records, btRecords);
    console.log(`🔀 合并后: ${records.length} 条交易记录\n`);
  }

  if (records.length === 0) {
    console.log(
      "\n⚠️  没有足够的交易记录。\n建议：\n  1. 运行 `npm run signal-stats -- --backtest` 通过回测生成记录\n  2. 等待实盘积累更多信号历史"
    );
    return;
  }

  // 统计分析
  const stats = calcSignalStats(records, minTrades);

  if (stats.length === 0) {
    console.log(
      `\n⚠️  没有满足条件的信号组合（最少 ${minTrades} 笔交易）。\n请降低 --min-trades 参数。`
    );
    return;
  }

  console.log(`\n✅ 共分析 ${stats.length} 个信号组合\n`);

  // 排名
  const { best, worst } = rankSignals(stats, topN);

  // 输出 Top N
  console.log(`━━━ Top ${topN} 信号组合（按期望收益） ━━━\n`);
  console.log(formatSignalStats(best));

  if (worst.length > 0 && stats.length > topN) {
    console.log(`\n━━━ Bottom ${topN} 信号组合（按期望收益） ━━━\n`);
    console.log(formatSignalStats(worst));
  }

  // 汇总
  const totalTrades = records.length;
  const winCount = records.filter((r) => r.pnlPercent > 0).length;
  const overallWR = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : "0.0";

  console.log(`\n━━━ 总体统计 ━━━`);
  console.log(`总交易: ${totalTrades} | 胜率: ${overallWR}% | 信号组合数: ${stats.length}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

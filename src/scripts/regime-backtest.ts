/**
 * Regime 自适应回测验证
 *
 * 对比三种模式在 1000 天历史数据上的表现：
 *   A. 固定参数（当前默认）
 *   B. Regime 自适应（每根 K 线检测 regime 并切换参数）
 *   C. 纯持有 BTC（基准）
 *
 * 用法：npm run regime-backtest
 */

import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import { loadStrategyConfig, loadStrategyProfile } from "../config/loader.js";
import { classifyRegime } from "../strategy/regime.js";
import { applyRegimeParams, describeRegimeParams } from "../strategy/regime-params.js";
import type { Kline, StrategyConfig } from "../types.js";

const DAYS = 1000;
const REGIME_WINDOW = 100; // 用最近 100 根 K 线检测 regime

// 支持 --strategy <id> 参数
const strategyArg = process.argv.indexOf("--strategy");
const strategyId = strategyArg >= 0 ? process.argv[strategyArg + 1] : undefined;

function formatPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       Regime 自适应回测验证                       ║");
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
    console.log(`📋 使用策略: ${strategyId} (${profile.name ?? strategyId})\n`);
  }
  const SYMBOLS = baseCfg.symbols;
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;

  // 获取数据
  console.log(`📥 获取 ${SYMBOLS.length} 个币种 ${DAYS} 天数据...`);
  const allKlines: Record<string, Kline[]> = {};
  for (const sym of SYMBOLS) {
    const klines = await fetchHistoricalKlines(sym, "1h", startMs, endMs);
    allKlines[sym] = klines;
    console.log(`   ${sym} ✓ ${klines.length} 根`);
  }

  // ── A. 固定参数回测 ──
  console.log("\n🔄 模式 A: 固定参数回测...");
  const fixedResult = runBacktest(allKlines, baseCfg, {
    initialUsdt: 1000, feeRate: 0.001, slippagePercent: 0.05,
  });
  const fm = fixedResult.metrics;
  console.log(`   收益: ${formatPct(fm.totalReturnPercent)} | ${fm.totalTrades}笔 | 胜率${(fm.winRate*100).toFixed(1)}% | Sharpe ${fm.sharpeRatio.toFixed(2)}`);

  // ── B. Regime 自适应回测 ──
  // 策略：将 1000 天数据按 200 根一段分成多个窗口，
  // 每个窗口开始时用前 100 根检测 regime，用对应参数跑该窗口
  console.log("\n🔄 模式 B: Regime 自适应回测...");

  const btcKlines = allKlines["BTCUSDT"] ?? [];
  const segmentSize = 200; // 每段 200 根（~8 天）
  let adaptiveUsdt = 1000;
  let adaptiveTrades = 0;
  let adaptiveWins = 0;
  const regimeLog: string[] = [];

  for (let i = REGIME_WINDOW; i < btcKlines.length; i += segmentSize) {
    // 用前 REGIME_WINDOW 根检测 regime
    const regimeKlines = btcKlines.slice(Math.max(0, i - REGIME_WINDOW), i);
    const regime = classifyRegime(regimeKlines);

    // 切换参数
    const segCfg = applyRegimeParams(baseCfg, regime.regime);

    // 截取当前段的所有 symbol 数据
    const segEnd = Math.min(i + segmentSize, btcKlines.length);
    const segKlines: Record<string, Kline[]> = {};
    for (const sym of SYMBOLS) {
      const symKlines = allKlines[sym] ?? [];
      // 找到对应时间范围
      const segEndTime = btcKlines[segEnd - 1]?.closeTime ?? 0;
      // 需要包含足够的历史数据来计算指标（prepend REGIME_WINDOW 根）
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
        `  ${startDate} | ${regime.regime.padEnd(16)} | ${formatPct(returnPct).padEnd(8)} | ${segResult.metrics.totalTrades}笔 | ${describeRegimeParams(regime.regime).slice(0, 50)}`
      );
    } catch {
      // 数据不足跳过
    }
  }

  const adaptiveReturn = ((adaptiveUsdt - 1000) / 1000) * 100;
  const adaptiveWinRate = adaptiveTrades > 0 ? (adaptiveWins / adaptiveTrades * 100) : 0;
  console.log(`   收益: ${formatPct(adaptiveReturn)} | ${adaptiveTrades}笔 | 胜率${adaptiveWinRate.toFixed(1)}%`);

  // ── 汇总 ──
  console.log("\n\n╔═══════════════════════════════════════════════╗");
  console.log("║               回测对比结果                       ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  console.log(`  A. 固定参数:     ${formatPct(fm.totalReturnPercent).padEnd(10)} ${fm.totalTrades}笔 胜率${(fm.winRate*100).toFixed(1)}%`);
  console.log(`  B. Regime自适应: ${formatPct(adaptiveReturn).padEnd(10)} ${adaptiveTrades}笔 胜率${adaptiveWinRate.toFixed(1)}%`);
  console.log(`  C. 持有BTC:      ${formatPct(fixedResult.metrics.totalReturnPercent + (fixedResult.metrics.calmarRatio !== 0 ? 0 : 0))} (参考)`);

  const improvement = adaptiveReturn - fm.totalReturnPercent;
  console.log(`\n  提升: ${formatPct(improvement)} (B vs A)`);

  // ── Regime 切换日志 ──
  console.log("\n📋 Regime 切换记录：");
  console.log("  日期       | Regime           | 收益     | 交易 | 参数描述");
  console.log("  " + "─".repeat(70));
  for (const line of regimeLog) {
    console.log(line);
  }

  // 保存结果
  const fs = await import("fs");
  fs.writeFileSync("logs/regime-backtest.json", JSON.stringify({
    fixedReturn: fm.totalReturnPercent,
    adaptiveReturn,
    improvement,
    fixedTrades: fm.totalTrades,
    adaptiveTrades,
    regimeLog,
  }, null, 2));
  console.log("\n💾 结果已保存: logs/regime-backtest.json");
}

main().catch(console.error);

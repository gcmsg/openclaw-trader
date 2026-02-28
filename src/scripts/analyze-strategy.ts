/**
 * 策略可靠性分析 CLI
 *
 * 用法：
 *   npm run analyze                                     # 默认策略全量分析
 *   npm run analyze -- --strategy short-trend           # 指定策略
 *   npm run analyze -- --wf                             # 只跑 Walk-Forward
 *   npm run analyze -- --sensitivity ma.short           # 参数敏感性
 *   npm run analyze -- --mc                             # 只跑蒙特卡洛
 */

import { loadStrategyConfig, loadStrategyProfile } from "../config/loader.js";
import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import {
  walkForwardSingle,
  runSensitivity,
  runMonteCarlo,
  formatWalkForwardReport,
  formatSensitivityReport,
  formatMonteCarloReport,
} from "../backtest/walk-forward.js";
import type { SensitivityParam } from "../backtest/walk-forward.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─── 参数解析 ──────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const strategyArg = getArg("strategy");
const runWF     = hasFlag("wf")          || (!hasFlag("sensitivity") && !hasFlag("mc"));
const runSens   = hasFlag("sensitivity") || (!hasFlag("wf")          && !hasFlag("mc"));
const runMC     = hasFlag("mc")          || (!hasFlag("wf")          && !hasFlag("sensitivity"));
const sensParam = getArg("sensitivity") ?? "ma.short";
const days      = parseInt(getArg("days") ?? "120", 10);
const INITIAL   = 1000;

// ─── 配置加载 ──────────────────────────────────────────

function buildCfg(): StrategyConfig {
  const base = loadStrategyConfig();
  if (!strategyArg) return base;
  try {
    const profile = loadStrategyProfile(strategyArg);
    return {
      ...base,
      symbols:    profile.symbols    ?? base.symbols,
      timeframe:  (profile.timeframe ?? base.timeframe),
      strategy:   { ...base.strategy, ...profile.strategy } as StrategyConfig["strategy"],
      signals:    { ...base.signals,  ...profile.signals },
      risk:       { ...base.risk,     ...(profile.risk ?? {}) },
    };
  } catch {
    console.warn(`⚠️ 未找到策略 "${strategyArg}"，使用默认配置`);
    return base;
  }
}

// ─── 主函数 ────────────────────────────────────────────

async function main() {
  const cfg = buildCfg();
  const symbols = cfg.symbols.slice(0, 3); // 最多 3 个，避免太慢

  console.log(`\n🔬 策略可靠性分析: ${strategyArg ?? "default"} | ${days} 天历史\n`);

  // 预拉取 klines
  console.log("📡 拉取历史数据...");
  const now = Date.now();
  const startMs = now - days * 24 * 3600 * 1000;
  const allKlines: Record<string, Kline[]> = {};

  for (const symbol of symbols) {
    const klines = await fetchHistoricalKlines(symbol, cfg.timeframe, startMs, now);
    allKlines[symbol] = klines;
    console.log(`  ${symbol}: ${klines.length} 根 K 线`);
  }

  const sep = "─".repeat(50);

  // ── Walk-Forward ──────────────────────────────────
  if (runWF) {
    console.log(`\n${sep}`);
    console.log("📊 Walk-Forward 验证（5 折）\n");

    const wfResults = symbols.map((sym) =>
walkForwardSingle(allKlines[sym] ?? [], cfg, sym, 5, 0.7)
    );
    console.log(formatWalkForwardReport(wfResults));

    const robustCount = wfResults.filter((r) => r.robust).length;
    if (robustCount === symbols.length) {
      console.log("✅ 所有测试币种策略稳健，具备统计意义\n");
    } else if (robustCount > 0) {
      console.log(`⚠️ ${robustCount}/${symbols.length} 币种稳健，其他需要优化\n`);
    } else {
      console.log("❌ 所有折外收益为负，策略可能过拟合，不建议实盘\n");
    }
  }

  // ── 参数敏感性 ────────────────────────────────────
  if (runSens) {
    console.log(`\n${sep}`);
    console.log("📊 参数敏感性分析\n");

    const sym = symbols[0] ?? "";
    const klines = allKlines[sym] ?? [];
    const params = getDefaultParams(sensParam);

    for (const param of params) {
      const report = runSensitivity(klines, cfg, sym, param);
      console.log(formatSensitivityReport(report));
      console.log("");
    }
  }

  // ── 蒙特卡洛 ─────────────────────────────────────
  if (runMC) {
    console.log(`\n${sep}`);
    console.log("🎲 蒙特卡洛风险模拟（1000 次）\n");

    const result = runBacktest(allKlines, cfg, { initialUsdt: INITIAL });

    for (const sym of symbols) {
      const trades = result.trades
        .filter((t) => t.symbol === sym && (t.side === "sell" || t.side === "cover"))
        .map((t) => ({ returnPct: t.pnlPercent * 100 }));

      if (trades.length < 5) {
        console.log(`${sym.replace("USDT", "")}: 交易次数不足（${trades.length} 笔），跳过\n`);
        continue;
      }

      console.log(`**${sym.replace("USDT", "")}** (${trades.length} 笔)`);
      console.log(formatMonteCarloReport(runMonteCarlo(trades, 1000)));
      console.log("");
    }
  }
}

// ─── 参数列表 ─────────────────────────────────────────

function getDefaultParams(focused?: string): SensitivityParam[] {
  if (focused === "ma.long") {
    return [{ name: "MA Long Period", path: "strategy.ma.long", values: [40, 45, 50, 55, 60, 65, 70, 80] }];
  }
  if (focused === "stoploss") {
    return [{ name: "Stop Loss %", path: "risk.stop_loss_percent", values: [3, 4, 5, 6, 7, 8] }];
  }
  if (focused === "rsi") {
    return [{ name: "RSI Period", path: "strategy.rsi.period", values: [9, 10, 12, 14, 16, 18] }];
  }
  // 默认：MA short + MA long
  return [
    { name: "MA Short Period", path: "strategy.ma.short", values: [12, 15, 18, 20, 22, 25, 30] },
    { name: "MA Long Period",  path: "strategy.ma.long",  values: [40, 50, 55, 60, 65, 70, 80] },
  ];
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((e: unknown) => {
  console.error("分析失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

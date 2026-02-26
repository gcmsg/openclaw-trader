/**
 * P6.1 Hyperopt — 策略参数自动优化 CLI
 *
 * 用法：
 *   npm run hyperopt -- --symbol BTCUSDT --trials 100
 *   npm run hyperopt -- --symbol BTCUSDT --trials 200 --days 90
 *   npm run hyperopt -- --symbol BTCUSDT --trials 100 --walk-forward
 *
 * 参数：
 *   --symbol, -s      交易对（默认 BTCUSDT）
 *   --trials, -t      优化轮次（默认 100）
 *   --days, -d        回测天数（默认 60）
 *   --walk-forward    启用 walk-forward 验证（70/30 分割）
 *   --seed            随机种子（用于复现）
 *   --no-save         不保存结果文件
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { loadStrategyConfig } from "../config/loader.js";
import { BayesianOptimizer, splitKlines } from "../optimization/bayesian.js";
import { evaluateParams, applyParams } from "../optimization/objective.js";
import { DEFAULT_PARAM_SPACE } from "../optimization/param-space.js";
import type { Kline } from "../types.js";
import type { ParamSet } from "../optimization/param-space.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────

interface CliArgs {
  symbol: string;
  trials: number;
  days: number;
  walkForward: boolean;
  seed?: number;
  save: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    symbol: "BTCUSDT",
    trials: 100,
    days: 60,
    walkForward: false,
    save: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return val;
    };

    switch (arg) {
      case "--symbol":
      case "-s":
        args.symbol = next();
        break;
      case "--trials":
      case "-t": {
        const v = parseInt(next(), 10);
        args.trials = Number.isNaN(v) ? 100 : v;
        break;
      }
      case "--days":
      case "-d": {
        const v = parseInt(next(), 10);
        args.days = Number.isNaN(v) ? 60 : v;
        break;
      }
      case "--walk-forward":
        args.walkForward = true;
        break;
      case "--seed": {
        const v = parseInt(next(), 10);
        if (!Number.isNaN(v)) args.seed = v;
        break;
      }
      case "--no-save":
        args.save = false;
        break;
    }
  }

  return args;
}

// ─────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────

interface TrialRecord {
  trial: number;
  params: ParamSet;
  score: number;
  sharpe: number;
  maxDrawdown: number;
  totalReturn: number;
  trades: number;
  winRate: number;
}

interface HyperoptResult {
  symbol: string;
  trials: number;
  days: number;
  walkForward: boolean;
  bestParams: ParamSet;
  bestScore: number;
  bestMetrics: {
    sharpe: number;
    maxDrawdown: number;
    totalReturnPercent: number;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
  };
  walkForwardMetrics?: {
    trainScore: number;
    testScore: number;
    sharpe: number;
    maxDrawdown: number;
    trades: number;
  };
  allTrials: TrialRecord[];
  completedAt: number;
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║           Hyperopt — Bayesian Optimization       ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Symbol:       ${args.symbol}`);
  console.log(`  Trials:       ${args.trials}`);
  console.log(`  Days:         ${args.days}`);
  console.log(`  Walk-Forward: ${args.walkForward ? "✓" : "✗"}`);
  if (args.seed !== undefined) {
    console.log(`  Seed:         ${args.seed}`);
  }
  console.log("");

  // ── 1. 加载配置 ──────────────────────────────────
  const baseCfg = loadStrategyConfig();

  // ── 2. 拉取历史数据 ───────────────────────────────
  console.log(`📥 正在加载 ${args.symbol} 近 ${args.days} 天 K 线数据...`);
  const endMs = Date.now();
  const startMs = endMs - args.days * 86_400_000;
  const allKlines = await fetchHistoricalKlines(
    args.symbol,
    baseCfg.timeframe,
    startMs,
    endMs
  );
  console.log(`   ✓ 共 ${allKlines.length} 根 K 线`);

  // ── 3. Walk-forward 数据分割 ─────────────────────
  let trainKlines: Kline[];
  let testKlines: Kline[];

  if (args.walkForward) {
    const split = splitKlines(allKlines, 0.7);
    trainKlines = split.train;
    testKlines  = split.test;
    console.log(`   Train: ${trainKlines.length} 根 | Test: ${testKlines.length} 根`);
  } else {
    trainKlines = allKlines;
    testKlines  = [];
  }

  const klineCache = new Map<string, Kline[]>([[args.symbol, trainKlines]]);

  // ── 4. 初始化优化器 ───────────────────────────────
  const optimizer = new BayesianOptimizer(
    DEFAULT_PARAM_SPACE,
    args.seed,
    Math.min(20, Math.floor(args.trials * 0.2))
  );

  const allTrials: TrialRecord[] = [];
  const startTime = Date.now();

  console.log(`\n🔍 开始优化（${args.trials} 轮）...\n`);

  // ── 5. 主循环 ─────────────────────────────────────
  for (let i = 1; i <= args.trials; i++) {
    const params = optimizer.suggest();
    const { score, metrics } = await evaluateParams(
      params,
      args.symbol,
      baseCfg,
      klineCache
    );

    optimizer.observe(params, score);

    const trial: TrialRecord = {
      trial: i,
      params,
      score,
      sharpe: metrics.sharpeRatio,
      maxDrawdown: metrics.maxDrawdown,
      totalReturn: metrics.totalReturnPercent,
      trades: metrics.totalTrades,
      winRate: metrics.winRate,
    };
    allTrials.push(trial);

    // 每 10 次打印当前最优
    if (i % 10 === 0 || i === args.trials) {
      const best = optimizer.best();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  [${String(i).padStart(4, " ")}/${args.trials}] ` +
        `best=${best ? best.score.toFixed(4) : "N/A"} ` +
        `cur=${score.toFixed(4)} ` +
        `sharpe=${metrics.sharpeRatio.toFixed(3)} ` +
        `dd=${metrics.maxDrawdown.toFixed(1)}% ` +
        `trades=${metrics.totalTrades} ` +
        `(${elapsed}s)`
      );
    }
  }

  // ── 6. 提取最优结果 ───────────────────────────────
  const best = optimizer.best()!;
  const bestTrial = allTrials.find((t) => t.score === best.score)!;

  console.log("\n" + "─".repeat(55));
  console.log("🏆 最优参数：");
  for (const [k, v] of Object.entries(best.params)) {
    console.log(`   ${k.padEnd(20, " ")}: ${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : v}`);
  }
  console.log("\n📊 最优回测指标：");
  console.log(`   Score:           ${best.score.toFixed(4)}`);
  console.log(`   Sharpe:          ${bestTrial.sharpe.toFixed(4)}`);
  console.log(`   Max Drawdown:    ${bestTrial.maxDrawdown.toFixed(2)}%`);
  console.log(`   Total Return:    ${bestTrial.totalReturn.toFixed(2)}%`);
  console.log(`   Total Trades:    ${bestTrial.trades}`);
  console.log(`   Win Rate:        ${(bestTrial.winRate * 100).toFixed(1)}%`);

  // ── 7. Walk-Forward 验证 ──────────────────────────
  let walkForwardMetrics: HyperoptResult["walkForwardMetrics"];

  if (args.walkForward && testKlines.length > 0) {
    console.log("\n🔬 Walk-Forward 测试集验证...");
    const testCache = new Map<string, Kline[]>([[args.symbol, testKlines]]);
    const { score: testScore, metrics: testMetrics } = await evaluateParams(
      best.params,
      args.symbol,
      baseCfg,
      testCache
    );

    walkForwardMetrics = {
      trainScore: best.score,
      testScore,
      sharpe: testMetrics.sharpeRatio,
      maxDrawdown: testMetrics.maxDrawdown,
      trades: testMetrics.totalTrades,
    };

    console.log(`   Train score:  ${best.score.toFixed(4)}`);
    console.log(`   Test score:   ${testScore.toFixed(4)}`);
    console.log(`   Test Sharpe:  ${testMetrics.sharpeRatio.toFixed(4)}`);
    console.log(`   Test DD:      ${testMetrics.maxDrawdown.toFixed(2)}%`);
    console.log(`   Test Trades:  ${testMetrics.totalTrades}`);

    const degradation = best.score > 0 && testScore > 0
      ? ((best.score - testScore) / best.score * 100).toFixed(1)
      : "N/A";
    console.log(`   Degradation:  ${degradation}%`);
  }

  // ── 8. 获取最优回测详情 ───────────────────────────
  const fullKlineCache = new Map<string, Kline[]>([[args.symbol, allKlines]]);
  const { metrics: fullMetrics } = await evaluateParams(
    best.params,
    args.symbol,
    baseCfg,
    fullKlineCache
  );

  // ── 9. 构建结果对象 ───────────────────────────────
  const result: HyperoptResult = {
    symbol: args.symbol,
    trials: args.trials,
    days: args.days,
    walkForward: args.walkForward,
    bestParams: best.params,
    bestScore: best.score,
    bestMetrics: {
      sharpe: fullMetrics.sharpeRatio,
      maxDrawdown: fullMetrics.maxDrawdown,
      totalReturnPercent: fullMetrics.totalReturnPercent,
      totalTrades: fullMetrics.totalTrades,
      winRate: fullMetrics.winRate,
      profitFactor: fullMetrics.profitFactor,
    },
    ...(walkForwardMetrics !== undefined ? { walkForwardMetrics } : {}),
    allTrials,
    completedAt: Date.now(),
  };

  // ── 10. 保存结果 ──────────────────────────────────
  if (args.save) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const outPath = path.join(LOGS_DIR, "hyperopt-results.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 结果已保存至: ${outPath}`);
  }

  console.log("\n✅ Hyperopt 完成！");
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   总耗时: ${totalSec}s | 平均: ${(parseFloat(totalSec) / args.trials * 1000).toFixed(0)}ms/trial`);

  // ── 11. 打印可直接粘贴的配置片段 ─────────────────
  const optimalCfg = applyParams(best.params, baseCfg);
  console.log("\n📋 最优配置片段（可粘贴至 strategy.yaml）：");
  console.log("   strategy:");
  console.log(`     ma.short: ${optimalCfg.strategy.ma.short}`);
  console.log(`     ma.long:  ${optimalCfg.strategy.ma.long}`);
  console.log(`     rsi.period: ${optimalCfg.strategy.rsi.period}`);
  console.log(`     rsi.overbought: ${optimalCfg.strategy.rsi.overbought.toFixed(1)}`);
  console.log(`     rsi.oversold: ${optimalCfg.strategy.rsi.oversold.toFixed(1)}`);
  console.log("   risk:");
  console.log(`     stop_loss_percent: ${optimalCfg.risk.stop_loss_percent.toFixed(2)}`);
  console.log(`     take_profit_percent: ${optimalCfg.risk.take_profit_percent.toFixed(2)}`);
  console.log(`     position_ratio: ${optimalCfg.risk.position_ratio.toFixed(3)}`);
}

// ─────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────

// 只在直接执行时运行（避免单元测试 import 时触发 main）
if (process.argv[1]?.endsWith("hyperopt.ts") || process.argv[1]?.endsWith("hyperopt.js")) {
  main().catch((err: unknown) => {
    console.error("❌ Hyperopt 运行失败:", err);
    process.exit(1);
  });
}

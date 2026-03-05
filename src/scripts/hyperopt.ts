/**
 * P6.1 Hyperopt — Strategy Parameter Auto-Optimization CLI
 *
 * Usage:
 *   npm run hyperopt -- --symbol BTCUSDT --trials 100
 *   npm run hyperopt -- --symbol BTCUSDT --trials 200 --days 90
 *   npm run hyperopt -- --symbol BTCUSDT --trials 100 --walk-forward
 *
 * Parameters:
 *   --symbol, -s      Trading pair (default BTCUSDT)
 *   --trials, -t      Optimization trials (default 100)
 *   --days, -d        Backtest days (default 60)
 *   --walk-forward    Enable walk-forward validation (70/30 split)
 *   --seed            Random seed (for reproducibility)
 *   --no-save         Do not save result file
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
// CLI Argument Parsing
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
      if (val === undefined) throw new Error(`Argument ${arg} requires a value`);
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
// Result Types
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
// Main Function
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

  // ── 1. Load Config ──────────────────────────────────
  const baseCfg = loadStrategyConfig();

  // ── 2. Fetch Historical Data ───────────────────────────────
  console.log(`📥 Loading ${args.symbol} candlestick data for the last ${args.days} days...`);
  const endMs = Date.now();
  const startMs = endMs - args.days * 86_400_000;
  const allKlines = await fetchHistoricalKlines(
    args.symbol,
    baseCfg.timeframe,
    startMs,
    endMs
  );
  console.log(`   ✓ Total ${allKlines.length} candlesticks`);

  // ── 3. Walk-forward Data Split ─────────────────────
  let trainKlines: Kline[];
  let testKlines: Kline[];

  if (args.walkForward) {
    const split = splitKlines(allKlines, 0.7);
    trainKlines = split.train;
    testKlines  = split.test;
    console.log(`   Train: ${trainKlines.length} bars | Test: ${testKlines.length} bars`);
  } else {
    trainKlines = allKlines;
    testKlines  = [];
  }

  const klineCache = new Map<string, Kline[]>([[args.symbol, trainKlines]]);

  // ── 4. Initialize Optimizer ───────────────────────────────
  const optimizer = new BayesianOptimizer(
    DEFAULT_PARAM_SPACE,
    args.seed,
    Math.min(20, Math.floor(args.trials * 0.2))
  );

  const allTrials: TrialRecord[] = [];
  const startTime = Date.now();

  console.log(`\n🔍 Starting optimization (${args.trials} trials)...\n`);

  // ── 5. Main Loop ─────────────────────────────────────
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

    // Print current best every 10 trials
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

  // ── 6. Extract Best Result ───────────────────────────────
  const best = optimizer.best()!;
  const bestTrial = allTrials.find((t) => t.score === best.score)!;

  console.log("\n" + "─".repeat(55));
  console.log("🏆 Best Parameters:");
  for (const [k, v] of Object.entries(best.params)) {
    console.log(`   ${k.padEnd(20, " ")}: ${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : v}`);
  }
  console.log("\n📊 Best Backtest Metrics:");
  console.log(`   Score:           ${best.score.toFixed(4)}`);
  console.log(`   Sharpe:          ${bestTrial.sharpe.toFixed(4)}`);
  console.log(`   Max Drawdown:    ${bestTrial.maxDrawdown.toFixed(2)}%`);
  console.log(`   Total Return:    ${bestTrial.totalReturn.toFixed(2)}%`);
  console.log(`   Total Trades:    ${bestTrial.trades}`);
  console.log(`   Win Rate:        ${(bestTrial.winRate * 100).toFixed(1)}%`);

  // ── 7. Walk-Forward Validation ──────────────────────────
  let walkForwardMetrics: HyperoptResult["walkForwardMetrics"];

  if (args.walkForward && testKlines.length > 0) {
    console.log("\n🔬 Walk-Forward test set validation...");
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

  // ── 8. Get Best Backtest Details ───────────────────────────
  const fullKlineCache = new Map<string, Kline[]>([[args.symbol, allKlines]]);
  const { metrics: fullMetrics } = await evaluateParams(
    best.params,
    args.symbol,
    baseCfg,
    fullKlineCache
  );

  // ── 9. Build Result Object ───────────────────────────────
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

  // ── 10. Save Results ──────────────────────────────────
  if (args.save) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const outPath = path.join(LOGS_DIR, "hyperopt-results.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Results saved to: ${outPath}`);
  }

  console.log("\n✅ Hyperopt complete!");
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   Total time: ${totalSec}s | Average: ${(parseFloat(totalSec) / args.trials * 1000).toFixed(0)}ms/trial`);

  // ── 11. Print config snippet for copy-paste ─────────────────
  const optimalCfg = applyParams(best.params, baseCfg);
  console.log("\n📋 Optimal config snippet (paste into strategy.yaml):");
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
// Entry Point
// ─────────────────────────────────────────────────────

// Only run when executed directly (avoid triggering main on unit test imports)
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

if (process.argv[1]?.endsWith("hyperopt.ts") || process.argv[1]?.endsWith("hyperopt.js")) {
  main().catch((err: unknown) => {
    console.error("❌ Hyperopt execution failed:", err);
    process.exit(1);
  });
}

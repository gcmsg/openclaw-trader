/**
 * 回测 CLI 入口
 *
 * 用法：
 *   npm run backtest
 *   npm run backtest -- --strategy conservative --days 90
 *   npm run backtest -- --strategy aggressive --symbols BTCUSDT,ETHUSDT --days 60
 *   npm run backtest -- --days 180 --timeframe 4h --initial-usdt 5000
 *
 * 参数：
 *   --strategy, -s   策略名称（default/aggressive/conservative/rsi-pure/trend）
 *                    不指定时使用 strategy.yaml 默认配置
 *   --days, -d       回测天数（默认 90）
 *   --timeframe, -t  K 线周期（覆盖策略配置）
 *   --symbols, -S    监控币种，逗号分隔（覆盖策略配置）
 *   --initial-usdt   初始资金（默认 1000）
 *   --no-save        不保存 JSON 报告文件
 *   --compare        同时运行所有策略并对比结果
 */

import { fetchHistoricalKlines } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import { formatReport, saveReport } from "../backtest/report.js";
import {
  loadStrategyConfig,
  loadStrategyProfile,
  listStrategyProfiles,
  mergeRisk,
  mergeStrategySection,
} from "../config/loader.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────

interface CliArgs {
  strategy?: string;
  days: number;
  timeframe?: string;
  symbols?: string[];
  initialUsdt: number;
  save: boolean;
  compare: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    days: 90,
    initialUsdt: 1000,
    save: true,
    compare: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // nextArg 辅助：安全取下一个参数
    const nextArg = (): string => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return val;
    };
    switch (arg) {
      case "--strategy":
      case "-s":
        args.strategy = nextArg();
        break;
      case "--days":
      case "-d":
        args.days = parseInt(nextArg(), 10);
        break;
      case "--timeframe":
      case "-t":
        args.timeframe = nextArg();
        break;
      case "--symbols":
      case "-S":
        args.symbols = nextArg()
          .split(",")
          .map((s) => s.trim().toUpperCase());
        break;
      case "--initial-usdt":
        args.initialUsdt = parseFloat(nextArg());
        break;
      case "--no-save":
        args.save = false;
        break;
      case "--compare":
        args.compare = true;
        break;
      case undefined:
      default:
        break; // 未知参数或 undefined（noUncheckedIndexedAccess）跳过
    }
  }

  return args;
}

// ─────────────────────────────────────────────────────
// 构建回测用策略配置（strategy.yaml + profile 合并）
// ─────────────────────────────────────────────────────

function buildBacktestConfig(
  strategyId: string | undefined,
  overrides: { timeframe?: string | undefined; symbols?: string[] | undefined }
): StrategyConfig {
  const base = loadStrategyConfig();

  let cfg = { ...base };

  if (strategyId) {
    const profile = loadStrategyProfile(strategyId);
    cfg = {
      ...cfg,
      symbols: overrides.symbols ?? profile.symbols ?? cfg.symbols,
      timeframe: (overrides.timeframe ??
        profile.timeframe ??
        cfg.timeframe) as StrategyConfig["timeframe"],
      strategy: {
        ...mergeStrategySection(cfg.strategy, profile.strategy),
        name: profile.name,
      },
      signals: {
        buy: profile.signals?.buy ?? cfg.signals.buy,
        sell: profile.signals?.sell ?? cfg.signals.sell,
      },
      risk: mergeRisk(cfg.risk, profile.risk),
    };
  } else {
    cfg = {
      ...cfg,
      symbols: overrides.symbols ?? cfg.symbols,
      timeframe: (overrides.timeframe ?? cfg.timeframe) as StrategyConfig["timeframe"],
    };
  }

  return cfg;
}

// ─────────────────────────────────────────────────────
// 单次回测
// ─────────────────────────────────────────────────────

async function runOne(strategyId: string | undefined, args: CliArgs): Promise<void> {
  const cfg = buildBacktestConfig(strategyId, {
    timeframe: args.timeframe,
    symbols: args.symbols,
  });

  const label = strategyId ?? "默认策略";
  console.log(
    `\n⏳ ${label}  |  ${cfg.symbols.length} 个币种  |  ${cfg.timeframe}  |  ${args.days} 天`
  );
  console.log(`   信号条件：买入 [${cfg.signals.buy.join(", ")}]`);
  console.log(`            卖出 [${cfg.signals.sell.join(", ")}]`);

  // 计算时间范围
  const endMs = Date.now();
  const startMs = endMs - args.days * 86_400_000;

  // 拉取历史 K 线
  console.log(`\n📥 正在获取历史数据...`);
  const klinesBySymbol: Record<string, Kline[]> = {};

  for (const symbol of cfg.symbols) {
    process.stdout.write(`   ${symbol}... `);
    const klines = await fetchHistoricalKlines(symbol, cfg.timeframe, startMs, endMs, (n) =>
      process.stdout.write(`\r   ${symbol}... ${n} 根`)
    );
    process.stdout.write(`\r   ${symbol} ✓ ${klines.length} 根 K 线\n`);
    klinesBySymbol[symbol] = klines;
  }

  // 运行回测
  console.log(`\n🔄 运行回测...`);
  const result = runBacktest(klinesBySymbol, cfg, {
    initialUsdt: args.initialUsdt,
    feeRate: 0.001,
    slippagePercent: 0.05,
  });

  // 输出报告
  console.log("\n" + formatReport(result));

  // 保存报告
  if (args.save) {
    const savedPath = saveReport(result, strategyId);
    console.log(`💾 报告已保存: ${savedPath}\n`);
  }
}

// ─────────────────────────────────────────────────────
// 多策略对比
// ─────────────────────────────────────────────────────

async function runCompare(args: CliArgs): Promise<void> {
  const strategies = listStrategyProfiles();
  if (strategies.length === 0) {
    console.log("⚠️  没有找到策略文件（config/strategies/*.yaml）");
    return;
  }

  console.log(`\n🔬 策略对比模式：${strategies.join("  |  ")}\n`);

  const results: {
    strategy: string;
    returnPct: number;
    sharpe: number;
    maxDD: number;
    trades: number;
    winRate: number;
  }[] = [];

  for (const strategyId of strategies) {
    const cfg = buildBacktestConfig(strategyId, {
      timeframe: args.timeframe,
      symbols: args.symbols,
    });

    const endMs = Date.now();
    const startMs = endMs - args.days * 86_400_000;

    console.log(`⏳ 正在回测：${strategyId}...`);
    const klinesBySymbol: Record<string, Kline[]> = {};

    for (const symbol of cfg.symbols) {
      klinesBySymbol[symbol] = await fetchHistoricalKlines(symbol, cfg.timeframe, startMs, endMs);
    }

    const result = runBacktest(klinesBySymbol, cfg, {
      initialUsdt: args.initialUsdt,
    });

    const m = result.metrics;
    results.push({
      strategy: strategyId,
      returnPct: m.totalReturnPercent,
      sharpe: m.sharpeRatio,
      maxDD: m.maxDrawdown,
      trades: m.totalTrades,
      winRate: m.winRate * 100,
    });

    if (args.save) saveReport(result, strategyId);
  }

  // 对比表格
  console.log("\n");
  console.log("━".repeat(72));
  console.log("📊 策略对比结果");
  console.log("━".repeat(72));
  console.log(
    `${"策略".padEnd(22)} ${"收益率".padStart(9)} ${"夏普".padStart(7)} ${"最大回撤".padStart(9)} ${"笔数".padStart(6)} ${"胜率".padStart(7)}`
  );
  console.log("─".repeat(72));

  // 按收益率排序
  results.sort((a, b) => b.returnPct - a.returnPct);
  for (const r of results) {
    const sign = r.returnPct >= 0 ? "+" : "";
    const emoji = r.returnPct > 5 ? "🟢" : r.returnPct > 0 ? "🟡" : "🔴";
    console.log(
      `${emoji} ${r.strategy.padEnd(20)} ${(sign + r.returnPct.toFixed(2) + "%").padStart(9)} ${r.sharpe.toFixed(2).padStart(7)} ${("-" + r.maxDD.toFixed(2) + "%").padStart(9)} ${String(r.trades).padStart(6)} ${(r.winRate.toFixed(1) + "%").padStart(7)}`
    );
  }
  console.log("━".repeat(72));
}

// ─────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("🚀 openclaw-trader 回测引擎");
  console.log(`   初始资金: $${args.initialUsdt}  |  回测天数: ${args.days}d`);

  if (args.compare) {
    await runCompare(args);
  } else {
    await runOne(args.strategy, args);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("❌ 回测失败:", msg);
  process.exit(1);
});

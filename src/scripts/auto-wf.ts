/**
 * P6.6 Auto Walk-Forward — CLI 入口
 *
 * 用法：
 *   npx tsx src/scripts/auto-wf.ts [--symbols BTCUSDT,ETHUSDT] [--days 90] [--trials 50] [--dry-run] [--notify]
 *
 * 参数：
 *   --symbols, -s     交易对列表，逗号分隔（默认 BTCUSDT,ETHUSDT）
 *   --days, -d        历史数据天数（默认 90）
 *   --trials, -t      每次优化轮次（默认 50）
 *   --train-ratio     训练集比例（默认 0.7）
 *   --min-improvement OOS Sharpe 最小改进阈值百分比（默认 5）
 *   --dry-run         不写 config 文件
 *   --notify          发送 Telegram 通知（默认 true）
 *   --no-notify       禁用 Telegram 通知
 *   --seed            随机种子
 */

import { runAutoWalkForward, formatAutoWfReport } from "../optimization/auto-wf.js";
import { sendTelegramMessage } from "../notify/openclaw.js";

// ─────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────

interface CliArgs {
  symbols: string[];
  days: number;
  trials: number;
  trainRatio: number;
  minImprovementPct: number;
  dryRun: boolean;
  notify: boolean;
  seed?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    symbols: ["BTCUSDT", "ETHUSDT"],
    days: 90,
    trials: 50,
    trainRatio: 0.7,
    minImprovementPct: 5,
    dryRun: false,
    notify: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return val;
    };

    switch (arg) {
      case "--symbols":
      case "-s":
        args.symbols = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--days":
      case "-d":
        args.days = parseInt(next(), 10);
        break;
      case "--trials":
      case "-t":
        args.trials = parseInt(next(), 10);
        break;
      case "--train-ratio":
        args.trainRatio = parseFloat(next());
        break;
      case "--min-improvement":
        args.minImprovementPct = parseFloat(next());
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--notify":
        args.notify = true;
        break;
      case "--no-notify":
        args.notify = false;
        break;
      case "--seed":
        args.seed = parseInt(next(), 10);
        break;
    }
  }

  return args;
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        Auto Walk-Forward 参数自适应优化          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Symbols:     ${args.symbols.join(", ")}`);
  console.log(`  Days:        ${args.days}`);
  console.log(`  Trials:      ${args.trials}`);
  console.log(`  TrainRatio:  ${args.trainRatio}`);
  console.log(`  MinImprove:  ${args.minImprovementPct}%`);
  console.log(`  DryRun:      ${args.dryRun ? "✓" : "✗"}`);
  console.log(`  Notify:      ${args.notify ? "✓" : "✗"}`);
  if (args.seed !== undefined) console.log(`  Seed:        ${args.seed}`);
  console.log("");

  console.log("🚀 开始 Walk-Forward 优化...\n");

  const report = await runAutoWalkForward({
    symbols: args.symbols,
    days: args.days,
    trials: args.trials,
    trainRatio: args.trainRatio,
    minImprovementPct: args.minImprovementPct,
    dryRun: args.dryRun,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  });

  const formatted = formatAutoWfReport(report);

  console.log("\n" + "─".repeat(55));
  console.log(formatted);
  console.log("─".repeat(55));

  console.log(`\n✅ 完成！更新: ${report.updatedCount} | 失败: ${report.failedCount}`);

  if (args.notify) {
    console.log("\n📤 发送 Telegram 通知...");
    sendTelegramMessage(formatted);
    console.log("   ✓ 已发送");
  }
}

// ─────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error("❌ Auto Walk-Forward 运行失败:", err);
  process.exit(1);
});

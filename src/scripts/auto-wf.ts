/**
 * P6.6 Auto Walk-Forward — CLI Entry
 *
 * Usage:
 *   npx tsx src/scripts/auto-wf.ts [--symbols BTCUSDT,ETHUSDT] [--days 90] [--trials 50] [--dry-run] [--notify]
 *
 * Parameters:
 *   --symbols, -s     Trading pair list, comma-separated (default BTCUSDT,ETHUSDT)
 *   --days, -d        Historical data days (default 90)
 *   --trials, -t      Optimization trials per run (default 50)
 *   --train-ratio     Training set ratio (default 0.7)
 *   --min-improvement OOS Sharpe minimum improvement threshold percentage (default 5)
 *   --dry-run         Do not write config file
 *   --notify          Send Telegram notification (default true)
 *   --no-notify       Disable Telegram notification
 *   --seed            Random seed
 */

import { runAutoWalkForward, formatAutoWfReport } from "../optimization/auto-wf.js";
import { sendTelegramMessage } from "../notify/openclaw.js";

// ─────────────────────────────────────────────────────
// CLI Argument Parsing
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

export function parseArgs(argv: string[]): CliArgs {
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
      if (val === undefined) throw new Error(`Argument ${arg} requires a value`);
      return val;
    };

    switch (arg) {
      case "--symbols":
      case "-s":
        args.symbols = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--days":
      case "-d": {
        const v = parseInt(next(), 10);
        args.days = Number.isNaN(v) ? 90 : v;
        break;
      }
      case "--trials":
      case "-t": {
        const v = parseInt(next(), 10);
        args.trials = Number.isNaN(v) ? 50 : v;
        break;
      }
      case "--train-ratio": {
        const v = parseFloat(next());
        args.trainRatio = Number.isNaN(v) ? 0.7 : v;
        break;
      }
      case "--min-improvement": {
        const v = parseFloat(next());
        args.minImprovementPct = Number.isNaN(v) ? 5 : v;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--notify":
        args.notify = true;
        break;
      case "--no-notify":
        args.notify = false;
        break;
      case "--seed": {
        const v = parseInt(next(), 10);
        if (!Number.isNaN(v)) args.seed = v;
        break;
      }
    }
  }

  return args;
}

// ─────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Auto Walk-Forward Adaptive Optimization       ║");
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

  console.log("🚀 Starting Walk-Forward optimization...\n");

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

  console.log(`\n✅ Done! Updated: ${report.updatedCount} | Failed: ${report.failedCount}`);

  if (args.notify) {
    console.log("\n📤 Sending Telegram notification...");
    sendTelegramMessage(formatted);
    console.log("   ✓ Sent");
  }
}

// ─────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────

// Only run when executed directly (avoid triggering main on unit test imports)
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

if (process.argv[1]?.endsWith("auto-wf.ts") || process.argv[1]?.endsWith("auto-wf.js")) {
  main().catch((err: unknown) => {
    console.error("❌ Auto Walk-Forward execution failed:", err);
    process.exit(1);
  });
}

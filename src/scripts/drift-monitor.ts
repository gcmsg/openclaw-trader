/**
 * Paper vs Live Execution Drift Monitor CLI
 *
 * Usage:
 *   npm run drift -- --paper default --live testnet-default
 *   npm run drift -- --paper default --live testnet-default --threshold 0.3
 */

import { detectDrift, summarizeDrift, formatDriftReport } from "../analysis/execution-drift.js";

// ── Parse CLI Arguments ──────────────────────────────────────

function parseArgs(argv: string[]): {
  paper: string;
  live: string;
  threshold: number;
} {
  const args = argv.slice(2);
  let paper = "default";
  let live = "testnet-default";
  let threshold = 0.5;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--paper" && args[i + 1]) {
      paper = args[++i] ?? paper;
    } else if (arg === "--live" && args[i + 1]) {
      live = args[++i] ?? live;
    } else if (arg === "--threshold" && args[i + 1]) {
      const v = parseFloat(args[++i] ?? "0.5");
      if (!isNaN(v) && v > 0) threshold = v;
    }
  }

  return { paper, live, threshold };
}

// ── Main Logic ─────────────────────────────────────────────

function main(): void {
  const { paper, live, threshold } = parseArgs(process.argv);

  console.log(`\n🔍 Comparing scenarios: paper="${paper}"  live="${live}"  threshold=${threshold}%\n`);

  const records = detectDrift(paper, live);

  if (records.length === 0) {
    console.log("⚠️  No matching trade pairs found.");
    console.log(
      `   Please confirm logs/paper-${paper}.json and logs/paper-${live}.json exist and contain paired trade records.\n`,
    );
    process.exit(0);
  }

  console.log(`✅ Found ${records.length} matching trade pairs\n`);

  // Output details (max 20 records)
  const maxDisplay = 20;
  const display = records.slice(0, maxDisplay);
  const header = [
    "Symbol".padEnd(12),
    "Side ".padEnd(6),
    "PaperFill".padEnd(12),
    "LiveFill".padEnd(12),
    "PaperSlip%".padEnd(12),
    "LiveSlip%".padEnd(11),
    "Drift%",
  ].join(" ");
  console.log(header);
  console.log("─".repeat(header.length));

  for (const r of display) {
    const row = [
      r.symbol.padEnd(12),
      r.side.padEnd(6),
      r.paperFillPrice.toFixed(2).padEnd(12),
      r.liveFillPrice.toFixed(2).padEnd(12),
      r.paperSlippage.toFixed(4).padEnd(12),
      r.liveSlippage.toFixed(4).padEnd(11),
      r.driftPercent.toFixed(4),
    ].join(" ");
    console.log(row);
  }

  if (records.length > maxDisplay) {
    console.log(`  ... ${records.length - maxDisplay} more records\n`);
  } else {
    console.log();
  }

  // Summary report
  const summary = summarizeDrift(records, threshold);
  const report = formatDriftReport(summary, threshold);
  console.log(report);
  console.log();
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main();

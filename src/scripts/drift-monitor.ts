/**
 * Paper vs Live 执行漂移监控 CLI
 *
 * 用法：
 *   npm run drift -- --paper default --live testnet-default
 *   npm run drift -- --paper default --live testnet-default --threshold 0.3
 */

import { detectDrift, summarizeDrift, formatDriftReport } from "../analysis/execution-drift.js";

// ── 解析命令行参数 ──────────────────────────────────────

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

// ── 主逻辑 ─────────────────────────────────────────────

function main(): void {
  const { paper, live, threshold } = parseArgs(process.argv);

  console.log(`\n🔍 对比场景: paper="${paper}"  live="${live}"  threshold=${threshold}%\n`);

  const records = detectDrift(paper, live);

  if (records.length === 0) {
    console.log("⚠️  未找到可匹配的交易对。");
    console.log(
      `   请确认 logs/paper-${paper}.json 和 logs/paper-${live}.json 存在且包含成对交易记录。\n`,
    );
    process.exit(0);
  }

  console.log(`✅ 找到 ${records.length} 对匹配交易\n`);

  // 输出明细（最多 20 条）
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
    console.log(`  ... 还有 ${records.length - maxDisplay} 条记录\n`);
  } else {
    console.log();
  }

  // 汇总报告
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

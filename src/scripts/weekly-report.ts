#!/usr/bin/env tsx
/**
 * 每周绩效报告 CLI
 *
 * 用法:
 *   npm run weekly                               # 生成所有场景的周报
 *   npm run weekly -- --scenario testnet-default # 指定场景
 *   npm run weekly -- --days 7                   # 指定天数
 *   npm run weekly -- --send                     # 生成并发送 Telegram（通过 openclaw system event）
 */

import { spawnSync } from "child_process";
import { loadPaperConfig } from "../config/loader.js";
import { generateWeeklyReport, formatWeeklyReport } from "../report/weekly-report.js";

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  scenario: string | null;
  days: number;
  send: boolean;
} {
  let scenario: string | null = null;
  let days = 7;
  let send = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario" || arg === "-s") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        scenario = next;
        i++;
      }
    } else if (arg === "--days" || arg === "-d") {
      const next = argv[i + 1];
      if (next !== undefined) {
        const parsed = parseInt(next, 10);
        if (!isNaN(parsed) && parsed > 0) {
          days = parsed;
          i++;
        }
      }
    } else if (arg === "--send") {
      send = true;
    }
  }

  return { scenario, days, send };
}

// ─── Send to Telegram via openclaw ───────────────────────────────────────────

function sendToTelegram(text: string): void {
  const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
  const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

  const args = ["system", "event", "--mode", "now"];
  if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
  args.push("--text", text);

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
  if (result.status !== 0) {
    console.error("❌ 发送失败:", result.stderr ?? result.error?.message ?? "unknown");
  } else {
    console.log("✅ 周报已发送到 Telegram");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { scenario, days, send } = parseArgs(args);

  // Determine which scenarios to report on
  const paperCfg = loadPaperConfig();
  const scenarioIds =
    scenario !== null
      ? [scenario]
      : paperCfg.scenarios.map((s) => s.id);

  if (scenarioIds.length === 0) {
    console.log("No scenarios found in paper config.");
    return;
  }

  for (const sid of scenarioIds) {
    console.log(`\n─── 生成周报: ${sid} (最近 ${days} 天) ───`);
    try {
      const report = await generateWeeklyReport(sid, days);
      const text = formatWeeklyReport(report);
      console.log(text);

      if (send) {
        sendToTelegram(text);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ 场景 ${sid} 报告生成失败: ${msg}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});

/**
 * Cron Sync Script
 * Reads schedule configuration from config/strategy.yaml
 * and auto-syncs to system crontab, no manual editing required.
 *
 * Usage: npm run cron:sync
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import type { StrategyConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const NODE_BIN = process.execPath; // Current node binary path
const TSX_BIN = path.resolve(PROJECT_ROOT, "node_modules/.bin/tsx");

// Script file mapping for each task
const TASK_SCRIPTS: Record<string, string> = {
  price_monitor: "src/monitor.ts",
  news_collector: "src/news/monitor.ts",
  weekly_report: "src/report/weekly.ts",
  health_check: "src/health/checker.ts",
  watchdog: "src/health/watchdog.ts",
  log_rotate: "src/health/log-rotate.ts",
  news_emergency: "src/news/emergency-monitor.ts",
};

const CRONTAB_MARKER_START = "# ===== openclaw-trader BEGIN =====";
const CRONTAB_MARKER_END = "# ===== openclaw-trader END =====";

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch (_e: unknown) {
    return "";
  }
}

function buildCronLine(taskName: string, cronExpr: string, scriptFile: string): string {
  const script = path.join(PROJECT_ROOT, scriptFile);
  const envFile = path.join(PROJECT_ROOT, ".env");
  return [
    cronExpr,
    ` cd ${PROJECT_ROOT}`,
    ` && [ -f ${envFile} ] && { set -a; source ${envFile}; set +a; }`,
    ` && ${NODE_BIN} ${TSX_BIN} ${script}`,
    ` >> ${PROJECT_ROOT}/logs/${taskName}.log 2>&1`,
  ].join("");
}

function syncCron(): void {
  console.log("📋 Reading strategy config...");
  const cfg = parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
  const schedule = cfg.schedule ?? {};

  // Build new cron block
  const lines: string[] = [CRONTAB_MARKER_START];
  let enabledCount = 0;

  for (const [taskName, taskCfg] of Object.entries(schedule)) {
    // Prefer the script field from yaml, fall back to TASK_SCRIPTS hardcoded mapping
    const scriptFile = (taskCfg as { script?: string }).script ?? TASK_SCRIPTS[taskName];
    if (!scriptFile) {
      console.warn(`  ⚠️  Unknown task: ${taskName} (no script field and not in mapping), skipping`);
      continue;
    }

    if (!taskCfg.enabled) {
      console.log(`  ⏸️  ${taskName}: disabled, skipping`);
      lines.push(`# [disabled] ${taskName}: ${taskCfg.cron}`);
      continue;
    }

    const cronLine = buildCronLine(taskName, taskCfg.cron, scriptFile);
    lines.push(`# ${taskName}`);
    lines.push(cronLine);
    console.log(`  ✅ ${taskName}: ${taskCfg.cron}`);
    enabledCount++;
  }

  lines.push(CRONTAB_MARKER_END);

  // Get current crontab, replace openclaw-trader block (or append)
  const currentCrontab = getCurrentCrontab();
  const startIdx = currentCrontab.indexOf(CRONTAB_MARKER_START);
  const endIdx = currentCrontab.indexOf(CRONTAB_MARKER_END);

  let newCrontab: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block
    newCrontab =
      currentCrontab.slice(0, startIdx).trimEnd() +
      "\n" +
      lines.join("\n") +
      "\n" +
      currentCrontab.slice(endIdx + CRONTAB_MARKER_END.length).trimStart();
  } else {
    // Append new block
    newCrontab = currentCrontab.trimEnd() + "\n\n" + lines.join("\n") + "\n";
  }

  // Write to temp file and apply
  const tmpFile = "/tmp/openclaw-trader-crontab.tmp";
  fs.writeFileSync(tmpFile, newCrontab);
  const result = spawnSync("crontab", [tmpFile], { encoding: "utf-8" });

  if (result.status !== 0) {
    console.error("❌ crontab update failed:", result.stderr);
    process.exit(1);
  }

  fs.unlinkSync(tmpFile);
  console.log(`\n✅ crontab updated (${enabledCount} tasks enabled)`);
  console.log("Current crontab:");
  console.log(execSync("crontab -l", { encoding: "utf-8" }));
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

try {
  syncCron();
} catch (err: unknown) {
  console.error("Fatal:", String(err));
  process.exit(1);
}

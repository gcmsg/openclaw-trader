/**
 * Cron 同步脚本
 * 读取 config/strategy.yaml 中的 schedule 配置
 * 自动同步到系统 crontab，无需手动编辑
 *
 * 用法: npm run cron:sync
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
const NODE_BIN = process.execPath;  // 当前 node 路径
const TSX_BIN = path.resolve(PROJECT_ROOT, "node_modules/.bin/tsx");

// 各任务对应的脚本文件
const TASK_SCRIPTS: Record<string, string> = {
  price_monitor:  "src/monitor.ts",
  news_collector: "src/news/monitor.ts",
  weekly_report:  "src/report/weekly.ts",
  health_check:   "src/health/checker.ts",
};

const CRONTAB_MARKER_START = "# ===== openclaw-trader BEGIN =====";
const CRONTAB_MARKER_END   = "# ===== openclaw-trader END =====";

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function buildCronLine(taskName: string, cronExpr: string, scriptFile: string): string {
  const script = path.join(PROJECT_ROOT, scriptFile);
  const envFile = path.join(PROJECT_ROOT, ".env");
  return [
    `${cronExpr}`,
    ` cd ${PROJECT_ROOT}`,
    ` && [ -f ${envFile} ] && source ${envFile}`,
    ` && ${NODE_BIN} ${TSX_BIN} ${script}`,
    ` >> ${PROJECT_ROOT}/logs/${taskName}.log 2>&1`,
  ].join("");
}

async function syncCron(): Promise<void> {
  console.log("📋 读取策略配置...");
  const cfg = parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
  const schedule = cfg.schedule ?? {};

  // 构建新的 cron 块
  const lines: string[] = [CRONTAB_MARKER_START];
  let enabledCount = 0;

  for (const [taskName, taskCfg] of Object.entries(schedule)) {
    const scriptFile = TASK_SCRIPTS[taskName];
    if (!scriptFile) {
      console.warn(`  ⚠️  未知任务: ${taskName}，跳过`);
      continue;
    }

    if (!taskCfg.enabled) {
      console.log(`  ⏸️  ${taskName}: 已禁用，跳过`);
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

  // 获取当前 crontab，替换 openclaw-trader 区块（或追加）
  const currentCrontab = getCurrentCrontab();
  const startIdx = currentCrontab.indexOf(CRONTAB_MARKER_START);
  const endIdx = currentCrontab.indexOf(CRONTAB_MARKER_END);

  let newCrontab: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // 替换已有区块
    newCrontab =
      currentCrontab.slice(0, startIdx).trimEnd() +
      "\n" +
      lines.join("\n") +
      "\n" +
      currentCrontab.slice(endIdx + CRONTAB_MARKER_END.length).trimStart();
  } else {
    // 追加新区块
    newCrontab = currentCrontab.trimEnd() + "\n\n" + lines.join("\n") + "\n";
  }

  // 写入临时文件并 apply
  const tmpFile = "/tmp/openclaw-trader-crontab.tmp";
  fs.writeFileSync(tmpFile, newCrontab);
  const result = spawnSync("crontab", [tmpFile], { encoding: "utf-8" });

  if (result.status !== 0) {
    console.error("❌ crontab 更新失败:", result.stderr);
    process.exit(1);
  }

  fs.unlinkSync(tmpFile);
  console.log(`\n✅ crontab 已更新（${enabledCount} 个任务启用）`);
  console.log("当前 crontab:");
  console.log(execSync("crontab -l", { encoding: "utf-8" }));
}

syncCron().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

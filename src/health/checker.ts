/**
 * 健康检查脚本
 * 每 30 分钟由 cron 触发，检查所有任务的运行状态
 * 发现异常时通知 AI Agent → 推送 Telegram
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { loadHeartbeats, getTaskHealth, type TaskStatus } from "./heartbeat.js";
import type { StrategyConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const LOG_PATH = path.resolve(__dirname, "../../logs/health.log");

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function notify(message: string): void {
  const args = ["system", "event", "--mode", "now"];
  if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
  args.push("--text", message);
  spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
}

const STATUS_EMOJI: Record<TaskStatus, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
  never: "🔘",
};

async function main(): Promise<void> {
  log("─── 健康检查开始 ───");

  const cfg = parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
  const schedule = cfg.schedule ?? {};

  const results: Array<{
    name: string;
    status: TaskStatus;
    minutesSince: number;
    message: string;
    enabled: boolean;
  }> = [];

  for (const [taskName, taskCfg] of Object.entries(schedule)) {
    if (!taskCfg.enabled) continue;

    const health = getTaskHealth(taskName, taskCfg.timeout_minutes);
    results.push({
      name: taskName,
      status: health.status,
      minutesSince: health.minutesSince,
      message: health.message,
      enabled: taskCfg.enabled,
    });

    log(`${STATUS_EMOJI[health.status]} ${taskName}: ${health.message}`);
  }

  const hasIssues = results.some((r) => r.status === "error" || r.status === "warn");
  const hasNever = results.some((r) => r.status === "never");

  // 只有有问题时才发通知（正常时静默）
  if (hasIssues) {
    const lines = [
      `🩺 **[健康检查告警]** ${new Date().toLocaleString("zh-CN")}`,
      ``,
    ];

    for (const r of results) {
      if (r.status !== "ok") {
        lines.push(`${STATUS_EMOJI[r.status]} **${r.name}**: ${r.message}`);
      }
    }

    lines.push(``, `请检查对应日志文件排查原因。`);
    notify(lines.join("\n"));
    log("⚠️ 已发送告警通知");
  } else if (hasNever) {
    // 从未运行的任务，只在日志里记录，不打扰主人
    log("🔘 部分任务从未执行（可能是刚部署）");
  } else {
    log("✅ 所有任务运行正常");
  }

  // 保存健康报告快照
  const snapshotPath = path.resolve(__dirname, "../../logs/health-snapshot.json");
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)
  );

  log("─── 健康检查完成 ───\n");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});

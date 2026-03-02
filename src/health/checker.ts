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
import { ping, getTaskHealth, type TaskStatus } from "./heartbeat.js";
import type { StrategyConfig } from "../types.js";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const NOTIFY_STATE_PATH = path.resolve(__dirname, "../../logs/health-notify-state.json");
const NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 同类告警 2 小时内只发一次
const log = createLogger("health", path.resolve(__dirname, "../../logs/health.log"));

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

/** 读取上次告警时间，用于冷却判断 */
function loadNotifyState(): { lastNotifiedAt: number } {
  try {
    return JSON.parse(fs.readFileSync(NOTIFY_STATE_PATH, "utf-8")) as { lastNotifiedAt: number };
  } catch {
    return { lastNotifiedAt: 0 };
  }
}

function saveNotifyState(state: { lastNotifiedAt: number }): void {
  fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(state, null, 2));
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

function main(): void {
  const done = ping("health_check");
  log.info("─── 健康检查开始 ───");

  const cfg = parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
  const schedule = cfg.schedule ?? {};

  const results: {
    name: string;
    status: TaskStatus;
    minutesSince: number;
    message: string;
    enabled: boolean;
  }[] = [];

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

    const statusMsg = `${STATUS_EMOJI[health.status]} ${taskName}: ${health.message}`;
    if (health.status === "error") log.error(statusMsg);
    else if (health.status === "warn") log.warn(statusMsg);
    else log.info(statusMsg);
  }

  const hasIssues = results.some((r) => r.status === "error" || r.status === "warn");
  const hasNever = results.some((r) => r.status === "never");

  // 只有有问题时才发通知（正常时静默）；同类告警 2h 冷却，避免每 30min 轰炸
  if (hasIssues) {
    const notifyState = loadNotifyState();
    const sinceLastMs = Date.now() - notifyState.lastNotifiedAt;
    if (sinceLastMs >= NOTIFY_COOLDOWN_MS) {
      const lines = [`🩺 **[健康检查告警]** ${new Date().toLocaleString("zh-CN")}`, ``];

      for (const r of results) {
        if (r.status !== "ok") {
          lines.push(`${STATUS_EMOJI[r.status]} **${r.name}**: ${r.message}`);
        }
      }

      lines.push(``, `请检查对应日志文件排查原因。`);
      notify(lines.join("\n"));
      saveNotifyState({ lastNotifiedAt: Date.now() });
      log.warn("⚠️ 已发送告警通知");
    } else {
      const cooldownMin = Math.ceil((NOTIFY_COOLDOWN_MS - sinceLastMs) / 60000);
      log.warn(`⚠️ 有问题但冷却中（还需 ${cooldownMin} 分钟），跳过通知`);
    }
  } else if (hasNever) {
    // 从未运行的任务，只在日志里记录，不打扰主人
    log.info("🔘 部分任务从未执行（可能是刚部署）");
  } else {
    log.info("✅ 所有任务运行正常");
  }

  // 保存健康报告快照
  const snapshotPath = path.resolve(__dirname, "../../logs/health-snapshot.json");
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)
  );

  log.info("─── 健康检查完成 ───\n");
  done();
}

try {
  main();
} catch (err: unknown) {
  log.error(`Fatal: ${String(err)}`);
  process.exit(1);
}

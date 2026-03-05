/**
 * Health Check Script
 * Triggered by cron every 30 minutes to check the running status of all tasks.
 * Notifies AI Agent on anomalies -> pushes to Telegram.
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
const NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // Same alert type sent at most once per 2 hours
const log = createLogger("health", path.resolve(__dirname, "../../logs/health.log"));

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

/** Load last alert time for cooldown check */
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
  log.info("─── Health check started ───");

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

  // Only send notifications when issues found (silent when normal); 2h cooldown to avoid spamming every 30min
  if (hasIssues) {
    const notifyState = loadNotifyState();
    const sinceLastMs = Date.now() - notifyState.lastNotifiedAt;
    if (sinceLastMs >= NOTIFY_COOLDOWN_MS) {
      const lines = [`🩺 **[Health Check Alert]** ${new Date().toLocaleString("en-US")}`, ``];

      for (const r of results) {
        if (r.status !== "ok") {
          lines.push(`${STATUS_EMOJI[r.status]} **${r.name}**: ${r.message}`);
        }
      }

      lines.push(``, `Please check the corresponding log files to investigate.`);
      notify(lines.join("\n"));
      saveNotifyState({ lastNotifiedAt: Date.now() });
      log.warn("⚠️ Alert notification sent");
    } else {
      const cooldownMin = Math.ceil((NOTIFY_COOLDOWN_MS - sinceLastMs) / 60000);
      log.warn(`⚠️ Issues found but in cooldown (${cooldownMin} min remaining), skipping notification`);
    }
  } else if (hasNever) {
    // Tasks that never ran, only log it, don't disturb the user
    log.info("🔘 Some tasks have never run (possibly just deployed)");
  } else {
    log.info("✅ All tasks running normally");
  }

  // Save health report snapshot
  const snapshotPath = path.resolve(__dirname, "../../logs/health-snapshot.json");
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)
  );

  log.info("─── Health check completed ───\n");
  done();
}

try {
  main();
} catch (err: unknown) {
  log.error(`Fatal: ${String(err)}`);
  process.exit(1);
}

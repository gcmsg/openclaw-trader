/**
 * Watchdog — Monitor Self-supervision
 *
 * Checks whether price_monitor cron is still running normally:
 *   - If time since last ping("price_monitor") exceeds alertAfterMinutes -> send Telegram alert
 *   - Minimum interval between consecutive alerts is cooldownMinutes, to avoid spamming
 *
 * ## Usage
 *   npm run watchdog          # Manually trigger a single check
 *   Integrated in openclaw heartbeat  # Checked on each heartbeat after HEARTBEAT.md configuration
 *
 * ## How it works
 *   1. Read logs/heartbeat.json to get price_monitor last ping time
 *   2. Timeout -> call openclaw system event to trigger AI agent -> send Telegram
 *   3. State written to logs/watchdog-state.json (includes last alert time to prevent duplicate alerts)
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { loadHeartbeats, ping } from "./heartbeat.js";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../logs/watchdog-state.json");
const log = createLogger("watchdog", path.resolve(__dirname, "../../logs/watchdog.log"));

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ─── Configuration ──────────────────────────────────────────────

const TASKS_TO_WATCH = [
  { name: "price_monitor", alertAfterMinutes: 3 },
  { name: "health_check", alertAfterMinutes: 65 },
  { name: "live_monitor", alertAfterMinutes: 5 }, // live-monitor pings every 60s, >5min considered crashed
];
const COOLDOWN_MINUTES = 30; // Minimum 30 minutes between alerts for the same task

// ─── State IO ──────────────────────────────────────────

interface WatchdogState {
  lastAlertAt: Record<string, number>; // taskName -> last alert timestamp (ms)
}

function loadState(): WatchdogState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as WatchdogState;
  } catch {
    return { lastAlertAt: {} };
  }
}

function saveState(state: WatchdogState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Notification ────────────────────────────────────────────

function sendAlert(message: string): boolean {
  try {
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", message);
    const result = spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── Check Logic ─────────────────────────────────────────

export interface WatchdogResult {
  task: string;
  status: "ok" | "alert" | "cooldown";
  minutesSince: number;
  message: string;
}

export function runWatchdog(): WatchdogResult[] {
  const heartbeats = loadHeartbeats();
  const state = loadState();
  const now = Date.now();
  const results: WatchdogResult[] = [];

  for (const { name, alertAfterMinutes } of TASKS_TO_WATCH) {
    const hb = heartbeats[name];

    // Never ran (possibly just deployed)
    if (!hb || hb.lastRunAt === 0) {
      results.push({ task: name, status: "ok", minutesSince: Infinity, message: "Never executed (skipping)" });
      continue;
    }

    const minutesSince = (now - hb.lastRunAt) / 60_000;

    if (minutesSince <= alertAfterMinutes) {
      results.push({ task: name, status: "ok", minutesSince, message: `Normal (executed ${minutesSince.toFixed(0)}min ago)` });
      continue;
    }

    // Timeout, check cooldown period
    const lastAlertMs = state.lastAlertAt[name] ?? 0;
    const minutesSinceAlert = (now - lastAlertMs) / 60_000;

    if (minutesSinceAlert < COOLDOWN_MINUTES) {
      const cooldownLeft = Math.ceil(COOLDOWN_MINUTES - minutesSinceAlert);
      results.push({
        task: name,
        status: "cooldown",
        minutesSince,
        message: `Timed out but in cooldown (can alert again in ${cooldownLeft}min)`,
      });
      continue;
    }

    // Send alert
    const alertMsg = [
      `🚨 **[Watchdog Alert]** \`${name}\` timed out!`,
      ``,
      `• Last executed: ${minutesSince.toFixed(0)} minutes ago`,
      `• Threshold: ${alertAfterMinutes} minutes`,
      `• Last status: ${hb.lastStatus === "error" ? `❌ Error (${hb.lastError ?? "unknown"})` : "✅ Normal"}`,
      ``,
      `Please check \`logs/${name}.log\` to investigate.`,
      `To manually restart: \`npm run ${name === "price_monitor" ? "monitor" : name}\``,
    ].join("\n");

    const sent = sendAlert(alertMsg);
    log.warn(`⚠️ ${name} timed out ${minutesSince.toFixed(0)}min, alert ${sent ? "sent" : "failed"}`);

    if (sent) {
      state.lastAlertAt[name] = now;
    }

    results.push({
      task: name,
      status: "alert",
      minutesSince,
      message: `Timed out ${minutesSince.toFixed(0)}min, alert ${sent ? "sent" : "send failed"}`,
    });
  }

  saveState(state);
  return results;
}

// ─── CLI Entry ─────────────────────────────────────────

if (process.argv[1]?.includes("watchdog")) {
  const done = ping("watchdog");
  log.info("── Watchdog check started ──");
  const results = runWatchdog();
  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : r.status === "cooldown" ? "⏳" : "🚨";
    log.info(`${icon} ${r.task}: ${r.message}`);
  }
  log.info("── Watchdog check completed ──");
  done();
}

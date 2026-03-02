/**
 * Watchdog — Monitor 自监控
 *
 * 检查 price_monitor cron 是否还在正常运行：
 *   - 距上次 ping("price_monitor") 超过 alertAfterMinutes → 发 Telegram 告警
 *   - 连续告警间隔至少 cooldownMinutes，避免轰炸
 *
 * ## 调用方式
 *   npm run watchdog          # 手动触发一次检查
 *   openclaw heartbeat 中集成  # HEARTBEAT.md 配置后每次心跳检查
 *
 * ## 工作原理
 *   1. 读取 logs/heartbeat.json 获取 price_monitor 最后 ping 时间
 *   2. 超时 → 调用 openclaw system event 触发 Mia → 发 Telegram
 *   3. 状态写入 logs/watchdog-state.json（包含上次告警时间，防重复告警）
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

// ─── 配置 ──────────────────────────────────────────────

const TASKS_TO_WATCH = [
  { name: "price_monitor", alertAfterMinutes: 3 },
  { name: "health_check", alertAfterMinutes: 65 },
];
const COOLDOWN_MINUTES = 30; // 同一任务最少间隔 30 分钟才再告警

// ─── 状态 IO ──────────────────────────────────────────

interface WatchdogState {
  lastAlertAt: Record<string, number>; // taskName → 上次告警时间戳(ms)
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

// ─── 通知 ────────────────────────────────────────────

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

// ─── 检查逻辑 ─────────────────────────────────────────

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

    // 从未运行（可能刚部署）
    if (!hb || hb.lastRunAt === 0) {
      results.push({ task: name, status: "ok", minutesSince: Infinity, message: "从未执行（跳过）" });
      continue;
    }

    const minutesSince = (now - hb.lastRunAt) / 60_000;

    if (minutesSince <= alertAfterMinutes) {
      results.push({ task: name, status: "ok", minutesSince, message: `正常（${minutesSince.toFixed(0)}min 前执行）` });
      continue;
    }

    // 超时，检查冷却期
    const lastAlertMs = state.lastAlertAt[name] ?? 0;
    const minutesSinceAlert = (now - lastAlertMs) / 60_000;

    if (minutesSinceAlert < COOLDOWN_MINUTES) {
      const cooldownLeft = Math.ceil(COOLDOWN_MINUTES - minutesSinceAlert);
      results.push({
        task: name,
        status: "cooldown",
        minutesSince,
        message: `超时但冷却期中（${cooldownLeft}min 后可再告警）`,
      });
      continue;
    }

    // 发告警
    const alertMsg = [
      `🚨 **[Watchdog 告警]** \`${name}\` 超时未执行！`,
      ``,
      `• 最后执行：${minutesSince.toFixed(0)} 分钟前`,
      `• 阈值：${alertAfterMinutes} 分钟`,
      `• 上次状态：${hb.lastStatus === "error" ? `❌ 出错 (${hb.lastError ?? "unknown"})` : "✅ 正常"}`,
      ``,
      `请检查 \`logs/${name}.log\` 排查原因。`,
      `如需手动重启：\`npm run ${name === "price_monitor" ? "monitor" : name}\``,
    ].join("\n");

    const sent = sendAlert(alertMsg);
    log.warn(`⚠️ ${name} 超时 ${minutesSince.toFixed(0)}min，告警 ${sent ? "已发" : "失败"}`);

    if (sent) {
      state.lastAlertAt[name] = now;
    }

    results.push({
      task: name,
      status: "alert",
      minutesSince,
      message: `超时 ${minutesSince.toFixed(0)}min，告警${sent ? "已发" : "发送失败"}`,
    });
  }

  saveState(state);
  return results;
}

// ─── CLI 入口 ─────────────────────────────────────────

if (process.argv[1]?.includes("watchdog")) {
  const done = ping("watchdog");
  log.info("── Watchdog 检查开始 ──");
  const results = runWatchdog();
  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : r.status === "cooldown" ? "⏳" : "🚨";
    log.info(`${icon} ${r.task}: ${r.message}`);
  }
  log.info("── Watchdog 检查完成 ──");
  done();
}

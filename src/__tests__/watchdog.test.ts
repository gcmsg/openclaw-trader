/**
 * Watchdog 核心判断逻辑测试
 *
 * 测试纯逻辑部分（冷却期计算、超时判断）
 * 不测试副作用（文件写入、Telegram 通知）
 */
import { describe, it, expect } from "vitest";

// ─── 纯逻辑提取（从 watchdog.ts 复制逻辑，独立测试）──

const COOLDOWN_MINUTES = 30;

function isInCooldown(lastAlertMs: number, nowMs: number): boolean {
  const minutesSinceAlert = (nowMs - lastAlertMs) / 60_000;
  return minutesSinceAlert < COOLDOWN_MINUTES;
}

function isTimedOut(lastRunMs: number, alertAfterMinutes: number, nowMs: number): boolean {
  const minutesSince = (nowMs - lastRunMs) / 60_000;
  return minutesSince > alertAfterMinutes;
}

function shouldAlert(
  lastRunMs: number,
  alertAfterMinutes: number,
  lastAlertMs: number,
  nowMs: number
): "ok" | "alert" | "cooldown" {
  if (!isTimedOut(lastRunMs, alertAfterMinutes, nowMs)) return "ok";
  if (isInCooldown(lastAlertMs, nowMs)) return "cooldown";
  return "alert";
}

// ─── 超时判断 ─────────────────────────────────────────

describe("isTimedOut()", () => {
  it("1 分钟内：未超时", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 60_000, 3, nowMs)).toBe(false);
  });

  it("恰好在阈值内（2.9 分钟）：未超时", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 2.9 * 60_000, 3, nowMs)).toBe(false);
  });

  it("超过阈值（5 分钟 > 3 分钟）：超时", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 5 * 60_000, 3, nowMs)).toBe(true);
  });

  it("health_check 阈值 65 分钟", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 60 * 60_000, 65, nowMs)).toBe(false);
    expect(isTimedOut(nowMs - 70 * 60_000, 65, nowMs)).toBe(true);
  });
});

// ─── 冷却期判断 ───────────────────────────────────────

describe("isInCooldown()", () => {
  it("5 分钟前告警：仍在冷却期（30min 冷却）", () => {
    const nowMs = Date.now();
    expect(isInCooldown(nowMs - 5 * 60_000, nowMs)).toBe(true);
  });

  it("31 分钟前告警：冷却期已过", () => {
    const nowMs = Date.now();
    expect(isInCooldown(nowMs - 31 * 60_000, nowMs)).toBe(false);
  });

  it("从未告警（lastAlertMs=0）：不在冷却期", () => {
    const nowMs = Date.now();
    expect(isInCooldown(0, nowMs)).toBe(false);
  });
});

// ─── 综合判断 ─────────────────────────────────────────

describe("shouldAlert()", () => {
  const nowMs = Date.now();

  it("任务正常（1min 内）→ ok", () => {
    expect(shouldAlert(nowMs - 60_000, 3, 0, nowMs)).toBe("ok");
  });

  it("任务超时 + 无冷却期 → alert", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, 0, nowMs)).toBe("alert");
  });

  it("任务超时 + 在冷却期 → cooldown", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, nowMs - 5 * 60_000, nowMs)).toBe("cooldown");
  });

  it("任务超时 + 冷却期刚过 → alert", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, nowMs - 31 * 60_000, nowMs)).toBe("alert");
  });
});

// ─── WatchdogResult 类型结构验证 ─────────────────────

describe("WatchdogResult 类型", () => {
  it("runWatchdog 导出存在", async () => {
    const { runWatchdog } = await import("../health/watchdog.js");
    expect(typeof runWatchdog).toBe("function");
  });
});

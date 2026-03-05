/**
 * Watchdog core judgment logic tests
 *
 * Tests pure logic parts (cooldown period calculation, timeout judgment)
 * Does not test side effects (file writes, Telegram notifications)
 */
import { describe, it, expect } from "vitest";

// ─── Pure logic extraction (logic copied from watchdog.ts for independent testing) ──

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

// ─── Timeout judgment ─────────────────────────────────────────

describe("isTimedOut()", () => {
  it("within 1 minute: not timed out", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 60_000, 3, nowMs)).toBe(false);
  });

  it("just within threshold (2.9 minutes): not timed out", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 2.9 * 60_000, 3, nowMs)).toBe(false);
  });

  it("exceeds threshold (5 minutes > 3 minutes): timed out", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 5 * 60_000, 3, nowMs)).toBe(true);
  });

  it("health_check threshold 65 minutes", () => {
    const nowMs = Date.now();
    expect(isTimedOut(nowMs - 60 * 60_000, 65, nowMs)).toBe(false);
    expect(isTimedOut(nowMs - 70 * 60_000, 65, nowMs)).toBe(true);
  });
});

// ─── Cooldown period judgment ───────────────────────────────────────

describe("isInCooldown()", () => {
  it("alerted 5 minutes ago: still in cooldown (30min cooldown)", () => {
    const nowMs = Date.now();
    expect(isInCooldown(nowMs - 5 * 60_000, nowMs)).toBe(true);
  });

  it("alerted 31 minutes ago: cooldown has expired", () => {
    const nowMs = Date.now();
    expect(isInCooldown(nowMs - 31 * 60_000, nowMs)).toBe(false);
  });

  it("never alerted (lastAlertMs=0): not in cooldown", () => {
    const nowMs = Date.now();
    expect(isInCooldown(0, nowMs)).toBe(false);
  });
});

// ─── Combined judgment ─────────────────────────────────────────

describe("shouldAlert()", () => {
  const nowMs = Date.now();

  it("task is normal (within 1min) -> ok", () => {
    expect(shouldAlert(nowMs - 60_000, 3, 0, nowMs)).toBe("ok");
  });

  it("task timed out + no cooldown -> alert", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, 0, nowMs)).toBe("alert");
  });

  it("task timed out + in cooldown -> cooldown", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, nowMs - 5 * 60_000, nowMs)).toBe("cooldown");
  });

  it("task timed out + cooldown just expired -> alert", () => {
    expect(shouldAlert(nowMs - 10 * 60_000, 3, nowMs - 31 * 60_000, nowMs)).toBe("alert");
  });
});

// ─── WatchdogResult type structure verification ─────────────────────

describe("WatchdogResult type", () => {
  it("runWatchdog export exists", async () => {
    const { runWatchdog } = await import("../health/watchdog.js");
    expect(typeof runWatchdog).toBe("function");
  });
});

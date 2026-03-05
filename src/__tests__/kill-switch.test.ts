/**
 * P6.7 — Kill Switch Market-Wide Circuit Breaker Tests
 *
 * Test scenarios:
 * - checkBtcCrash trigger / no trigger
 * - activateKillSwitch / deactivateKillSwitch state read/write
 * - autoResume logic
 * - isKillSwitchActive auto-resume on expiry
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ── Mock state file path before importing the module ──────────────────
// Tests read/write STATE_FILE directly inside the module, requiring temporary redirection

import {
  readKillSwitch,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
  checkBtcCrash,
  type KillSwitchState,
} from "../health/kill-switch.js";

// ─────────────────────────────────────────────────────
// Test setup (clear state before each test)
// ─────────────────────────────────────────────────────

beforeEach(() => {
  // Ensure state is cleared (deactivate resets it)
  deactivateKillSwitch();
});

afterEach(() => {
  // Cleanup after test
  deactivateKillSwitch();
});

// ─────────────────────────────────────────────────────
// checkBtcCrash tests
// ─────────────────────────────────────────────────────

describe("checkBtcCrash — BTC crash detection", () => {
  it("triggers crash when drop >= threshold", () => {
    // Price from 100k to 91k = 9% drop, threshold 8%
    const prices = Array.from({ length: 60 }, (_, i) =>
      100_000 - i * (9_000 / 59) // uniformly from 100k to 91k
    );
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(true);
    expect(result.dropPct).toBeGreaterThanOrEqual(8);
  });

  it("does not trigger crash when drop < threshold", () => {
    // Price from 100k to 96k = 4% drop, threshold 8%
    const prices = Array.from({ length: 60 }, (_, i) =>
      100_000 - i * (4_000 / 59)
    );
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBeLessThan(8);
  });

  it("does not trigger crash when price rises (dropPct may be negative)", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100_000 + i * 100);
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBeLessThan(0); // actually a gain, dropPct is negative
  });

  it("triggers when drop exactly equals threshold", () => {
    // Drop exactly 8%: 100 → 92
    const prices = [100, 92];
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(true);
    expect(result.dropPct).toBeCloseTo(8, 5);
  });

  it("returns false when price points are insufficient (<2)", () => {
    expect(checkBtcCrash([], 8)).toEqual({ crash: false, dropPct: 0 });
    expect(checkBtcCrash([100_000], 8)).toEqual({ crash: false, dropPct: 0 });
  });

  it("safely returns false when starting price is 0 (prevents division by zero)", () => {
    const result = checkBtcCrash([0, 100], 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBe(0);
  });

  it("uses default threshold of 8%", () => {
    // 9% drop, no threshold passed
    const prices = [100_000, 91_000];
    const result = checkBtcCrash(prices); // default 8%
    expect(result.crash).toBe(true);
  });

  it("dropPct calculation is precise", () => {
    // From 200 to 180 = 10% drop
    const result = checkBtcCrash([200, 180], 8);
    expect(result.dropPct).toBeCloseTo(10, 5);
    expect(result.crash).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// activateKillSwitch / deactivateKillSwitch tests
// ─────────────────────────────────────────────────────

describe("activateKillSwitch / deactivateKillSwitch — state read/write", () => {
  it("isKillSwitchActive() returns true after activation", () => {
    activateKillSwitch("test activation");
    expect(isKillSwitchActive()).toBe(true);
  });

  it("isKillSwitchActive() returns false after deactivation", () => {
    activateKillSwitch("test activation");
    deactivateKillSwitch();
    expect(isKillSwitchActive()).toBe(false);
  });

  it("readKillSwitch() returns correct state fields", () => {
    const reason = "BTC crashed 10%";
    activateKillSwitch(reason);
    const state = readKillSwitch();
    expect(state.active).toBe(true);
    expect(state.reason).toBe(reason);
    expect(state.triggeredAt).toBeGreaterThan(0);
    expect(state.triggeredAt).toBeLessThanOrEqual(Date.now());
  });

  it("readKillSwitch() returns inactive state after deactivateKillSwitch()", () => {
    activateKillSwitch("test");
    deactivateKillSwitch();
    const state = readKillSwitch();
    expect(state.active).toBe(false);
    expect(state.reason).toBe("");
    expect(state.triggeredAt).toBe(0);
  });

  it("returns default inactive state on first read (no file)", () => {
    // deactivateKillSwitch() already called in beforeEach
    const state = readKillSwitch();
    expect(state.active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// autoResume logic tests
// ─────────────────────────────────────────────────────

describe("autoResume — auto-resume logic", () => {
  it("sets autoResumeAt field on activation", () => {
    const autoResumeMs = 3_600_000; // 1 hour
    activateKillSwitch("test auto-resume", autoResumeMs);
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeDefined();
    expect(state.autoResumeAt).toBeGreaterThan(Date.now());
  });

  it("autoResumeAt is undefined when autoResumeMs is not passed (manual resume)", () => {
    activateKillSwitch("manual resume test");
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeUndefined();
  });

  it("does not set autoResumeAt when autoResumeMs=0", () => {
    activateKillSwitch("zero duration test", 0);
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeUndefined();
  });

  it("isKillSwitchActive() auto-deactivates and returns false when autoResumeAt has expired", () => {
    // Simulate by writing an expired autoResumeAt directly to the state file
    const expiredState: KillSwitchState = {
      active: true,
      reason: "expired test",
      triggeredAt: Date.now() - 7_200_000, // activated 2 hours ago
      autoResumeAt: Date.now() - 1000,     // expired 1 second ago
    };

    // Write directly to state file (activateKillSwitch cannot set a past autoResumeAt)
    // We simulate by deactivating + writing manually
    const stateFilePath = path.resolve(__dirname, "../../logs/kill-switch-state.json");
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(expiredState, null, 2));

    // Should auto-deactivate
    const isActive = isKillSwitchActive();
    expect(isActive).toBe(false);

    // State file should have been reset
    const stateAfter = readKillSwitch();
    expect(stateAfter.active).toBe(false);
  });

  it("isKillSwitchActive() still returns true when autoResumeAt has not expired", () => {
    activateKillSwitch("not yet expired test", 3_600_000); // auto-resume after 1 hour
    expect(isKillSwitchActive()).toBe(true);
  });
});

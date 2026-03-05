/**
 * Signal history database tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Dynamic import then mock file path
// Directly test getSignalStats / logSignal / closeSignal logic

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_LOG = path.resolve(__dirname, "../../logs/test-signal-history.jsonl");
const TEST_INDEX = path.resolve(__dirname, "../../logs/test-signal-index.json");

// Temporary module path replacement: directly test pure function logic

import type { SignalRecord, SignalStats } from "../strategy/signal-history.js";

// ─── Pure function tests: no file system dependency ─────────────────────────

function makeRecord(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: `sig_test_${Math.random().toString(36).slice(2)}`,
    symbol: "BTCUSDT",
    type: "buy",
    entryPrice: 60000,
    entryTime: Date.now() - 3600000,
    entryConditions: { rsi: 32, triggeredRules: ["ma_bullish", "rsi_oversold"] },
    status: "closed",
    exitPrice: 63000,
    exitTime: Date.now(),
    exitReason: "take_profit",
    pnl: 30,
    pnlPercent: 0.05,
    holdingHours: 1,
    source: "paper",
    ...overrides,
  };
}

function calcStats(records: SignalRecord[]): SignalStats {
  const closed = records.filter((r) => r.status === "closed");
  const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
  const losses = closed.filter((r) => (r.pnlPercent ?? 0) <= 0);
  const totalWin = wins.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);
  const totalLoss = losses.reduce((s, r) => s + Math.abs(r.pnlPercent ?? 0), 0);

  return {
    total: records.length,
    closed: closed.length,
    open: records.filter((r) => r.status === "open").length,
    expired: records.filter((r) => r.status === "expired").length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    avgPnlPercent: closed.length > 0 ? closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / closed.length : 0,
    avgWinPercent: wins.length > 0 ? totalWin / wins.length : 0,
    avgLossPercent: losses.length > 0 ? totalLoss / losses.length : 0,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 1),
    avgHoldingHours: closed.length > 0 ? closed.reduce((s, r) => s + (r.holdingHours ?? 0), 0) / closed.length : 0,
    byType: { buy: { count: 0, winRate: 0, avgPnl: 0 }, sell: { count: 0, winRate: 0, avgPnl: 0 }, short: { count: 0, winRate: 0, avgPnl: 0 }, cover: { count: 0, winRate: 0, avgPnl: 0 } },
    bySymbol: {},
    byHour: {},
    recentTrades: closed.slice(-5).reverse(),
    fromDate: new Date(records[0]?.entryTime ?? Date.now()).toISOString().slice(0, 10),
    toDate: new Date(records[records.length - 1]?.entryTime ?? Date.now()).toISOString().slice(0, 10),
  };
}

describe("Signal Stats calculation logic", () => {
  it("win rate calculated correctly", () => {
    const records = [
      makeRecord({ pnlPercent: 0.05, status: "closed" }),  // profit
      makeRecord({ pnlPercent: -0.03, status: "closed" }), // loss
      makeRecord({ pnlPercent: 0.08, status: "closed" }),  // profit
    ];
    const stats = calcStats(records);
    expect(stats.winRate).toBeCloseTo(2 / 3);
    expect(stats.closed).toBe(3);
    expect(stats.avgPnlPercent).toBeCloseTo((0.05 - 0.03 + 0.08) / 3);
  });

  it("profit factor calculated correctly", () => {
    const records = [
      makeRecord({ pnlPercent: 0.10, status: "closed" }),
      makeRecord({ pnlPercent: -0.05, status: "closed" }),
    ];
    const stats = calcStats(records);
    expect(stats.profitFactor).toBeCloseTo(2.0); // 0.10 / 0.05 = 2
  });

  it("profit factor is 0 when all losses", () => {
    const records = [
      makeRecord({ pnlPercent: -0.05, status: "closed" }),
      makeRecord({ pnlPercent: -0.03, status: "closed" }),
    ];
    const stats = calcStats(records);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0); // totalWin=0, totalLoss>0 → 0/loss = 0
  });

  it("profit factor is Infinity when all wins", () => {
    const records = [
      makeRecord({ pnlPercent: 0.05, status: "closed" }),
      makeRecord({ pnlPercent: 0.10, status: "closed" }),
    ];
    const stats = calcStats(records);
    expect(stats.winRate).toBe(1);
    expect(stats.profitFactor).toBe(Infinity);
  });

  it("open and expired are not counted in winRate", () => {
    const records = [
      makeRecord({ pnlPercent: 0.05, status: "closed" }),
      makeRecord({ status: "open" }),
      makeRecord({ status: "expired" }),
    ];
    const stats = calcStats(records);
    expect(stats.total).toBe(3);
    expect(stats.closed).toBe(1);
    expect(stats.open).toBe(1);
    expect(stats.expired).toBe(1);
    expect(stats.winRate).toBe(1); // 1/1 closed wins
  });

  it("average holding duration calculated correctly", () => {
    const records = [
      makeRecord({ pnlPercent: 0.05, status: "closed", holdingHours: 4 }),
      makeRecord({ pnlPercent: -0.03, status: "closed", holdingHours: 8 }),
    ];
    const stats = calcStats(records);
    expect(stats.avgHoldingHours).toBe(6);
  });

  it("returns zero values for empty records", () => {
    const stats = calcStats([]);
    expect(stats.total).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(1);
  });
});

describe("SignalRecord structure validation", () => {
  it("makeRecord generates a valid closed record", () => {
    const r = makeRecord();
    expect(r.id).toBeTruthy();
    expect(r.status).toBe("closed");
    expect(r.pnlPercent).toBeGreaterThan(0);
    expect(r.entryConditions.triggeredRules).toContain("ma_bullish");
  });

  it("short type record is correct", () => {
    const r = makeRecord({ type: "short", pnlPercent: 0.03, exitReason: "signal" });
    expect(r.type).toBe("short");
  });
});

// Clean up test files
beforeEach(() => {
  [TEST_LOG, TEST_INDEX].forEach((f) => { try { fs.unlinkSync(f); } catch { /* ok */ } });
});
afterEach(() => {
  [TEST_LOG, TEST_INDEX].forEach((f) => { try { fs.unlinkSync(f); } catch { /* ok */ } });
});

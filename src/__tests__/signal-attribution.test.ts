/**
 * 信号归因分析测试
 */
import { describe, it, expect } from "vitest";
import { analyzeGroups, formatAttributionReport } from "../scripts/signal-attribution.js";

// ─── 测试辅助 ─────────────────────────────────────────

// pnlPercent 使用比例格式（与 signal-history.ts 一致），如 0.10 = +10%
function makeRecord(overrides: {
  id?: string;
  symbol?: string;
  type?: "buy" | "short";
  rules?: string[];
  status?: "open" | "closed";
  pnlPercent?: number;
  holdingHours?: number;
  exitReason?: string;
}) {
  return {
    id: overrides.id ?? "sig_test",
    symbol: overrides.symbol ?? "BTCUSDT",
    type: overrides.type ?? "buy",
    entryPrice: 100,
    entryTime: Date.now(),
    entryConditions: {
      triggeredRules: overrides.rules ?? ["ma_bullish"],
    },
    status: overrides.status ?? "closed",
    exitPrice: 105,
    exitTime: Date.now() + 3600_000,
    exitReason: overrides.exitReason ?? "signal",
    pnl: 5,
    pnlPercent: overrides.pnlPercent ?? 0.05,  // 默认 +5%（比例格式）
    holdingHours: overrides.holdingHours ?? 2,
    scenarioId: "test",
  };
}

// ─── analyzeGroups ────────────────────────────────────

describe("analyzeGroups()", () => {
  it("空记录返回空数组", () => {
    expect(analyzeGroups([])).toEqual([]);
  });

  it("单笔盈利信号统计正确", () => {
    const records = [makeRecord({ rules: ["ma_bullish", "rsi_bullish"], pnlPercent: 0.10 })];
    const stats = analyzeGroups(records);
    expect(stats).toHaveLength(1);
    const s = stats[0]!;
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.winRate).toBe(1);
    expect(s.avgPnlPct).toBeCloseTo(0.10);
    expect(s.totalPnlPct).toBeCloseTo(0.10);
    expect(s.rules).toContain("ma_bullish");
    expect(s.rules).toContain("rsi_bullish");
  });

  it("多笔亏损计算胜率和亏损比", () => {
    const records = [
      makeRecord({ rules: ["ma_bearish"], type: "short", pnlPercent: -0.05 }),
      makeRecord({ rules: ["ma_bearish"], type: "short", pnlPercent: -0.08 }),
      makeRecord({ rules: ["ma_bearish"], type: "short", pnlPercent: 0.10 }),
    ];
    const stats = analyzeGroups(records);
    const s = stats[0]!;
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(1 / 3, 2);
    expect(s.avgLossPct).toBeCloseTo(0.065, 4); // (0.05+0.08)/2
    expect(s.avgWinPct).toBeCloseTo(0.10, 3);
    expect(s.rrRatio).toBeCloseTo(0.10 / 0.065, 2);
  });

  it("不同信号组合分为不同 group", () => {
    const records = [
      makeRecord({ rules: ["ma_bullish"], pnlPercent: 0.05 }),
      makeRecord({ rules: ["ma_bullish", "cvd_bullish"], pnlPercent: 0.08 }),
      makeRecord({ rules: ["ma_bullish"], pnlPercent: -0.02 }),
    ];
    const stats = analyzeGroups(records);
    expect(stats).toHaveLength(2);
    const ma = stats.find((s) => s.rules.join("+") === "ma_bullish");
    const maCvd = stats.find((s) => s.rules.length === 2);
    expect(ma?.closed).toBe(2);
    expect(maCvd?.closed).toBe(1);
  });

  it("open 状态的信号不计入 closed 统计", () => {
    const records = [
      makeRecord({ status: "open" }),
      makeRecord({ status: "closed", pnlPercent: 0.05 }),
    ];
    const stats = analyzeGroups(records);
    const s = stats[0]!;
    expect(s.total).toBe(2);
    expect(s.closed).toBe(1);
    expect(s.open).toBe(1);
    expect(s.winRate).toBeCloseTo(1);
  });

  it("按累计盈亏降序排列", () => {
    const records = [
      makeRecord({ id: "a", rules: ["ma_bullish"], pnlPercent: 0.02 }),
      makeRecord({ id: "b", rules: ["ma_bearish"], type: "short", pnlPercent: 0.20 }),
      makeRecord({ id: "c", rules: ["rsi_bullish"], pnlPercent: -0.05 }),
    ];
    const stats = analyzeGroups(records);
    expect(stats[0]?.rules).toContain("ma_bearish");
    expect(stats[1]?.rules).toContain("ma_bullish");
    expect(stats[2]?.rules).toContain("rsi_bullish");
  });

  it("止损计数正确", () => {
    const records = [
      makeRecord({ rules: ["ma_bullish"], pnlPercent: -0.05, exitReason: "stop_loss" }),
      makeRecord({ rules: ["ma_bullish"], pnlPercent: 0.08, exitReason: "signal" }),
    ];
    const stats = analyzeGroups(records);
    expect(stats[0]?.stopLossCount).toBe(1);
  });

  it("持仓时长平均正确", () => {
    const records = [
      makeRecord({ rules: ["ma_bullish"], pnlPercent: 0.05, holdingHours: 4 }),
      makeRecord({ rules: ["ma_bullish"], pnlPercent: 0.03, holdingHours: 6 }),
    ];
    const stats = analyzeGroups(records);
    expect(stats[0]?.avgHoldHours).toBeCloseTo(5);
  });

  it("规则排序确保 key 一致（不同顺序 = 同一组合）", () => {
    const records = [
      makeRecord({ rules: ["b_rule", "a_rule"], pnlPercent: 0.05 }),
      makeRecord({ rules: ["a_rule", "b_rule"], pnlPercent: 0.03 }),
    ];
    const stats = analyzeGroups(records);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.closed).toBe(2);
  });
});

// ─── formatAttributionReport ─────────────────────────

describe("formatAttributionReport()", () => {
  it("空数据输出暂无数据提示", () => {
    const report = formatAttributionReport([], []);
    expect(report).toContain("暂无数据");
  });

  it("包含胜率和盈亏信息", () => {
    const records = [
      makeRecord({ pnlPercent: 0.10 }),
      makeRecord({ pnlPercent: -0.05 }),
    ];
    const stats = analyzeGroups(records);
    const report = formatAttributionReport(stats, records);
    expect(report).toContain("胜率");
    expect(report).toContain("累计");
    expect(report).toContain("信号归因分析报告");
  });
});

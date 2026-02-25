import { describe, it, expect } from "vitest";
import { checkRiskReward } from "../strategy/rr-filter.js";
import type { Kline } from "../types.js";

function makeKlines(highs: number[], lows: number[], close = 100): Kline[] {
  return highs.map((high, i) => ({
    openTime: i * 3600_000,
    open: close,
    high,
    low: lows[i] ?? close * 0.98,
    close,
    volume: 1000,
    closeTime: (i + 1) * 3600_000,
  }));
}

/** 生成围绕 center 的区间 K 线，high = center+range, low = center-range */
function makeRangeKlines(n: number, center: number, range: number): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 3600_000,
    open: center,
    high: center + range,
    low: center - range,
    close: center,
    volume: 1000,
    closeTime: (i + 1) * 3600_000,
  }));
}

describe("checkRiskReward — 多头", () => {
  it("R:R 充足时通过（多头）", () => {
    // price=100, support=90, resistance=120 → R:R = 20/10 = 2.0 ≥ 1.5
    const klines = makeKlines(
      Array(20).fill(120),
      Array(20).fill(90)
    );
    const result = checkRiskReward(klines, 100, "long", 1.5);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(2.0, 1);
    expect(result.support).toBe(90);
    expect(result.resistance).toBe(120);
  });

  it("R:R 不足时拒绝（多头）", () => {
    // price=100, support=95, resistance=107 → R:R = 7/5 = 1.4 < 1.5
    const klines = makeKlines(
      Array(20).fill(107),
      Array(20).fill(95)
    );
    const result = checkRiskReward(klines, 100, "long", 1.5);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(1.4, 1);
  });

  it("min_rr=0 时禁用，始终通过", () => {
    const klines = makeRangeKlines(20, 100, 1); // 极小区间
    const result = checkRiskReward(klines, 100, "long", 0);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBe(Infinity);
  });
});

describe("checkRiskReward — 空头", () => {
  it("R:R 充足时通过（空头）", () => {
    // price=100, support=80, resistance=105 → R:R空 = 20/5 = 4.0 ≥ 1.5
    const klines = makeKlines(
      Array(20).fill(105),
      Array(20).fill(80)
    );
    const result = checkRiskReward(klines, 100, "short", 1.5);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(4.0, 1);
  });

  it("R:R 不足时拒绝（空头）", () => {
    // price=100, support=97, resistance=110 → R:R空 = 3/10 = 0.3 < 1.5
    const klines = makeKlines(
      Array(20).fill(110),
      Array(20).fill(97)
    );
    const result = checkRiskReward(klines, 100, "short", 1.5);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(0.3, 1);
  });
});

describe("checkRiskReward — 边界情况", () => {
  it("K 线数不足（<5 根）时跳过检查，通过", () => {
    const klines = makeKlines([110], [90]);
    const result = checkRiskReward(klines, 100, "long", 1.5);
    expect(result.passed).toBe(true);
  });

  it("外部 pivot 优先于近期高低点", () => {
    // 近期高=120, 低=80，但传入 pivot support=92, resistance=115
    // R:R = (115-100)/(100-92) = 15/8 = 1.875 ≥ 1.5
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(80));
    const result = checkRiskReward(klines, 100, "long", 1.5, 20, 92, 115);
    expect(result.support).toBe(92);
    expect(result.resistance).toBe(115);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(1.875, 2);
  });

  it("外部 pivot 导致不通过", () => {
    // pivot support=98, resistance=102 → R:R = 2/2 = 1.0 < 1.5
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(80));
    const result = checkRiskReward(klines, 100, "long", 1.5, 20, 98, 102);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(1.0, 1);
  });

  it("reason 字段在通过时包含 R:R 值", () => {
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(90));
    const result = checkRiskReward(klines, 100, "long");
    expect(result.reason).toContain("R:R=");
  });

  it("lookback 参数限制使用的 K 线范围", () => {
    // 前 15 根: high=200, low=50（宽区间）
    // 后 5 根: high=105, low=95（窄区间）
    // lookback=5 时只看后5根 → R:R=(105-100)/(100-95)=1.0 → 失败
    const klines = [
      ...makeKlines(Array(15).fill(200), Array(15).fill(50)),
      ...makeKlines(Array(5).fill(105), Array(5).fill(95)),
    ];
    const result = checkRiskReward(klines, 100, "long", 1.5, 5);
    expect(result.resistance).toBe(105);
    expect(result.support).toBe(95);
    expect(result.passed).toBe(false);
  });
});

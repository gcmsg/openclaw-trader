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

/** Generate range-bound klines around center, high = center+range, low = center-range */
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

describe("checkRiskReward — long", () => {
  it("passes when R:R is sufficient (long)", () => {
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

  it("rejects when R:R is insufficient (long)", () => {
    // price=100, support=95, resistance=107 → R:R = 7/5 = 1.4 < 1.5
    const klines = makeKlines(
      Array(20).fill(107),
      Array(20).fill(95)
    );
    const result = checkRiskReward(klines, 100, "long", 1.5);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(1.4, 1);
  });

  it("min_rr=0 disables check, always passes", () => {
    const klines = makeRangeKlines(20, 100, 1); // very small range
    const result = checkRiskReward(klines, 100, "long", 0);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBe(Infinity);
  });
});

describe("checkRiskReward — short", () => {
  it("passes when R:R is sufficient (short)", () => {
    // price=100, support=80, resistance=105 → short R:R = 20/5 = 4.0 ≥ 1.5
    const klines = makeKlines(
      Array(20).fill(105),
      Array(20).fill(80)
    );
    const result = checkRiskReward(klines, 100, "short", 1.5);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(4.0, 1);
  });

  it("rejects when R:R is insufficient (short)", () => {
    // price=100, support=97, resistance=110 → short R:R = 3/10 = 0.3 < 1.5
    const klines = makeKlines(
      Array(20).fill(110),
      Array(20).fill(97)
    );
    const result = checkRiskReward(klines, 100, "short", 1.5);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(0.3, 1);
  });
});

describe("checkRiskReward — edge cases", () => {
  it("skips check and passes when kline count is insufficient (<5 bars)", () => {
    const klines = makeKlines([110], [90]);
    const result = checkRiskReward(klines, 100, "long", 1.5);
    expect(result.passed).toBe(true);
  });

  it("external pivot takes priority over recent high/low", () => {
    // recent high=120, low=80, but pivot support=92, resistance=115 passed in
    // R:R = (115-100)/(100-92) = 15/8 = 1.875 ≥ 1.5
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(80));
    const result = checkRiskReward(klines, 100, "long", 1.5, 20, 92, 115);
    expect(result.support).toBe(92);
    expect(result.resistance).toBe(115);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(1.875, 2);
  });

  it("external pivot causes rejection", () => {
    // pivot support=98, resistance=102 → R:R = 2/2 = 1.0 < 1.5
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(80));
    const result = checkRiskReward(klines, 100, "long", 1.5, 20, 98, 102);
    expect(result.passed).toBe(false);
    expect(result.ratio).toBeCloseTo(1.0, 1);
  });

  it("reason field contains R:R value when passed", () => {
    const klines = makeKlines(Array(20).fill(120), Array(20).fill(90));
    const result = checkRiskReward(klines, 100, "long");
    expect(result.reason).toContain("R:R=");
  });

  it("lookback parameter limits the kline range used", () => {
    // first 15 bars: high=200, low=50 (wide range)
    // last 5 bars: high=105, low=95 (narrow range)
    // lookback=5 only uses last 5 bars → R:R=(105-100)/(100-95)=1.0 → fail
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

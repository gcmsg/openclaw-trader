import { describe, it, expect } from "vitest";
import { calcReturns, pearsonCorrelation, checkCorrelation } from "../strategy/correlation.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Utility: generate test kline arrays
// ─────────────────────────────────────────────────────

function makeKlines(closes: number[]): Kline[] {
  return closes.map((close, i) => ({
    openTime: i * 3600000,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
    closeTime: (i + 1) * 3600000 - 1,
  }));
}

// ─────────────────────────────────────────────────────
// calcReturns
// ─────────────────────────────────────────────────────

describe("calcReturns()", () => {
  it("single kline has no return (needs at least 2)", () => {
    expect(calcReturns(makeKlines([100]))).toEqual([]);
  });

  it("geometric growth: equal returns", () => {
    // 100 → 110 → 121: ln(1.1) each time
    const returns = calcReturns(makeKlines([100, 110, 121]));
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 6);
    expect(returns[1]).toBeCloseTo(Math.log(1.1), 6);
  });

  it("price unchanged: return = 0", () => {
    const returns = calcReturns(makeKlines([50, 50, 50]));
    expect(returns).toEqual([0, 0]);
  });

  it("decline: return is negative", () => {
    const returns = calcReturns(makeKlines([100, 90]));
    expect(returns[0]).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────
// pearsonCorrelation
// ─────────────────────────────────────────────────────

describe("pearsonCorrelation()", () => {
  it("perfect positive correlation → 1", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(1, 5);
  });

  it("perfect negative correlation → -1", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it("uncorrelated (orthogonal) → 0", () => {
    // a leans long, b leans short, no linear relationship between them
    const a = [1, -1, 1, -1, 1];
    const b = [1, 1, -1, -1, 1];
    // Result is close to 0 (not necessarily exactly 0, depends on data)
    const corr = pearsonCorrelation(a, b);
    expect(Math.abs(corr)).toBeLessThan(0.6);
  });

  it("insufficient data (< 2 points) → NaN", () => {
    expect(pearsonCorrelation([], [])).toBeNaN();
    expect(pearsonCorrelation([1], [1])).toBeNaN();
  });

  it("different array lengths: uses the shorter length for calculation", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6]; // only 3 points
    const corr = pearsonCorrelation(a, b);
    expect(isNaN(corr)).toBe(false);
    expect(Math.abs(corr)).toBeLessThanOrEqual(1);
  });

  it("constant array (variance=0) → NaN", () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
});

// ─────────────────────────────────────────────────────
// checkCorrelation
// ─────────────────────────────────────────────────────

describe("checkCorrelation()", () => {
  /** Generate a price series highly correlated with base (with slight noise) */
  function makeCorrelatedPrices(base: number[], noise = 0.01): number[] {
    return base.map((v, i) => v * (1 + (i % 2 === 0 ? noise : -noise)));
  }

  it("no held positions → no filtering", () => {
    const result = checkCorrelation("BTCUSDT", makeKlines([100, 110, 120]), new Map(), 0.7);
    expect(result.correlated).toBe(false);
  });

  it("highly correlated position (> threshold) → filtered", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const heldPrices = makeCorrelatedPrices(prices, 0.001); // nearly perfectly correlated
    const heldKlines = new Map([["ETHUSDT", makeKlines(heldPrices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.7);
    expect(result.correlated).toBe(true);
    expect(result.correlatedWith).toBe("ETHUSDT");
    expect(result.maxCorrelation).toBeGreaterThan(0.7);
    expect(result.reason).toBeTruthy();
  });

  it("low correlation position (< threshold) → allows entry", () => {
    // BTC monotonically increasing, held asset oscillating (low correlation)
    const newPrices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const heldPrices = Array.from({ length: 30 }, (_, i) =>
      100 + Math.sin(i * 0.8) * 10
    );
    const heldKlines = new Map([["XRPUSDT", makeKlines(heldPrices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(newPrices), heldKlines, 0.7);
    expect(result.correlated).toBe(false);
  });

  it("same symbol skips self-comparison", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    const heldKlines = new Map([["BTCUSDT", makeKlines(prices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.7);
    // Correlated with itself but skipped, no other held symbol → no filtering
    expect(result.correlated).toBe(false);
  });

  it("insufficient data (< 10 klines) → skips check, allows entry", () => {
    const shortKlines = makeKlines([100, 110, 120]); // only 3 klines, returns only 2
    const heldKlines = new Map([["ETHUSDT", makeKlines([200, 210, 220])]]);
    const result = checkCorrelation("BTCUSDT", shortKlines, heldKlines, 0.7);
    expect(result.correlated).toBe(false);
  });

  it("maxCorrelation correctly returns the highest value", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const heldPrices = makeCorrelatedPrices(prices, 0.005);
    const heldKlines = new Map([
      ["ETHUSDT", makeKlines(heldPrices)],
    ]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.99);
    // Very high threshold (0.99) → no filtering, but maxCorrelation should be > 0
    expect(result.correlated).toBe(false);
    expect(result.maxCorrelation).toBeGreaterThan(0);
  });
});

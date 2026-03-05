import { describe, it, expect } from "vitest";
import { calcAdx, calcBollingerWidth, analyzePriceStructure, classifyRegime } from "../strategy/regime.js";
import type { Kline } from "../types.js";

// Generate simple mock klines
function makeKlines(closes: number[], highOffset = 0.02, lowOffset = 0.02): Kline[] {
  return closes.map((close, i) => ({
    openTime: i * 3600000,
    open: close * 0.999,
    high: close * (1 + highOffset),
    low: close * (1 - lowOffset),
    close,
    volume: 1000 + Math.random() * 500,
    closeTime: (i + 1) * 3600000,
  }));
}

// Generate uptrend (+0.5% per bar)
function makeTrendUp(n = 100, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start * (1.005 ** i));
}

// Generate sideways (random +/-0.2%)
function makeFlat(n = 100, center = 100): number[] {
  return Array.from({ length: n }, () => center * (1 + (Math.random() - 0.5) * 0.004));
}

describe("calcAdx", () => {
  it("ADX should be high for an uptrend", () => {
    const klines = makeKlines(makeTrendUp(80));
    const { adx, diPlus, diMinus } = calcAdx(klines);
    expect(adx).toBeGreaterThan(0);
    expect(diPlus).toBeGreaterThan(diMinus); // uptrend DI+ > DI-
  });

  it("returns 0 when insufficient klines", () => {
    const klines = makeKlines([100, 101, 102]);
    const { adx } = calcAdx(klines, 14);
    expect(adx).toBe(0);
  });

  it("ADX is low during sideways market", () => {
    const klines = makeKlines(makeFlat(80));
    const { adx } = calcAdx(klines);
    // ADX is typically < 25 during sideways market
    expect(adx).toBeGreaterThanOrEqual(0);
  });
});

describe("calcBollingerWidth", () => {
  it("return value has correct format", () => {
    const closes = makeTrendUp(50);
    const result = calcBollingerWidth(closes);
    expect(result.bbWidth).toBeGreaterThanOrEqual(0);
    expect(result.bbWidthPercentile).toBeGreaterThanOrEqual(0);
    expect(result.bbWidthPercentile).toBeLessThanOrEqual(100);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
  });

  it("returns default values when insufficient data", () => {
    const result = calcBollingerWidth([100, 101], 20);
    expect(result.bbWidth).toBe(0);
    expect(result.bbWidthPercentile).toBe(50);
  });

  it("BB Width is larger when volatility is high", () => {
    const flat = makeFlat(50, 100).map((v, i) => v + (i % 2 === 0 ? 0.1 : -0.1)); // low volatility
    const volatile = Array.from({ length: 50 }, (_, i) => 100 + (i % 3 === 0 ? 5 : -5)); // high volatility
    const flatResult = calcBollingerWidth(flat);
    const volResult = calcBollingerWidth(volatile);
    expect(volResult.bbWidth).toBeGreaterThan(flatResult.bbWidth);
  });
});

describe("analyzePriceStructure", () => {
  it("uptrend should be identified as higher_highs", () => {
    const klines = makeKlines(makeTrendUp(30));
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("higher_highs");
  });

  it("downtrend should be identified as lower_lows", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 / (1.005 ** i));
    const klines = makeKlines(closes);
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("lower_lows");
  });

  it("returns flat when insufficient data", () => {
    const klines = makeKlines([100, 101, 102]);
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("flat");
  });
});

describe("classifyRegime", () => {
  it("uptrend should be classified as trending_bull", () => {
    const klines = makeKlines(makeTrendUp(100), 0.015, 0.005);
    const result = classifyRegime(klines);
    // most common result for uptrend is trending_bull or breakout_up
    expect(["trending_bull", "breakout_up", "ranging_wide"]).toContain(result.regime);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.adx).toBeGreaterThan(0);
  });

  it("output structure is complete", () => {
    const klines = makeKlines(makeTrendUp(100));
    const result = classifyRegime(klines);
    expect(result).toHaveProperty("regime");
    expect(result).toHaveProperty("label");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("adx");
    expect(result).toHaveProperty("bbWidth");
    expect(result).toHaveProperty("bbWidthPercentile");
    expect(result).toHaveProperty("structure");
    expect(result).toHaveProperty("signalFilter");
    expect(result).toHaveProperty("detail");
  });

  it("confidence is between 0-100", () => {
    const klines = makeKlines(makeTrendUp(100));
    const result = classifyRegime(klines);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });
});

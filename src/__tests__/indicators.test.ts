import { describe, it, expect } from "vitest";
import { sma, ema, rsi, calculateIndicators } from "../strategy/indicators.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────

function makeKlines(closes: number[]): Kline[] {
  return closes.map((close, i) => ({
    openTime: i * 3600000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    closeTime: (i + 1) * 3600000 - 1,
  }));
}

// ─────────────────────────────────────────────────────
// SMA
// ─────────────────────────────────────────────────────

describe("sma()", () => {
  it("calculates simple moving average", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4); // last 3: 3,4,5
  });

  it("returns the last value when period = 1", () => {
    expect(sma([10, 20, 30], 1)).toBe(30);
  });

  it("calculates correctly when data length equals period", () => {
    expect(sma([2, 4, 6], 3)).toBe(4);
  });

  it("returns NaN when data is insufficient", () => {
    expect(sma([1, 2], 5)).toBeNaN();
  });

  it("correct with single data point and period=1", () => {
    expect(sma([42], 1)).toBe(42);
  });
});

// ─────────────────────────────────────────────────────
// EMA
// ─────────────────────────────────────────────────────

describe("ema()", () => {
  it("returns NaN when data is insufficient", () => {
    expect(ema([1, 2], 5)).toBeNaN();
  });

  it("equals SMA when data length equals period", () => {
    const values = [10, 20, 30];
    expect(ema(values, 3)).toBeCloseTo(sma(values, 3));
  });

  it("EMA gives higher weight to recent prices than old prices", () => {
    // Sequence from low to high, EMA should be higher than SMA (closer to recent values)
    const rising = [1, 2, 3, 4, 10];
    const emaVal = ema(rising, 3);
    const smaVal = sma(rising, 3); // 3,4,10 = 5.67
    expect(emaVal).toBeGreaterThan(smaVal);
  });

  it("EMA equals the last value when period=1", () => {
    expect(ema([5, 10, 20], 1)).toBe(20);
  });
});

// ─────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────

describe("rsi()", () => {
  it("returns NaN when data is insufficient", () => {
    expect(rsi([1, 2, 3], 14)).toBeNaN();
  });

  it("RSI = 100 when all prices rise", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1,2,...,20
    expect(rsi(closes, 14)).toBe(100);
  });

  it("RSI = 0 when all prices fall", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 20 - i); // 20,19,...,1
    expect(rsi(closes, 14)).toBe(0);
  });

  it("RSI result is between 0-100", () => {
    const closes = [44, 42, 45, 47, 43, 46, 48, 44, 42, 45, 47, 46, 48, 50, 49];
    const result = rsi(closes, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("RSI is between 40-60 in ranging market", () => {
    // Prices alternate up and down
    const closes = [10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11];
    const result = rsi(closes, 14);
    expect(result).toBeGreaterThan(40);
    expect(result).toBeLessThan(60);
  });
});

// ─────────────────────────────────────────────────────
// calculateIndicators
// ─────────────────────────────────────────────────────

describe("calculateIndicators()", () => {
  it("returns null when data is insufficient", () => {
    const klines = makeKlines([1, 2, 3]);
    expect(calculateIndicators(klines, 5, 10, 14)).toBeNull();
  });

  it("returns correct price (last candle close)", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(179); // last one
  });

  it("maShort > maLong in uptrend", () => {
    // First 60 candles flat, last 20 sharply higher → short-term MA above long-term
    const closes = [...Array(60).fill(100), ...Array(20).fill(200)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeGreaterThan(result!.maLong);
  });

  it("maShort < maLong in downtrend", () => {
    // First 60 candles flat, last 20 sharply lower → short-term MA below long-term
    const closes = [...Array(60).fill(100), ...Array(20).fill(10)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeLessThan(result!.maLong);
  });

  it("returns prevMaShort and prevMaLong", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result!.prevMaShort).toBeDefined();
    expect(result!.prevMaLong).toBeDefined();
  });

  it("EMA is more sensitive to recent prices: maShort should be significantly above maLong after a sharp rally", () => {
    // First 60 candles at low level, last 5 sharply higher → EMA20 should be well above EMA60
    const closes = [...Array(70).fill(50), ...Array(10).fill(200)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeGreaterThan(result!.maLong); // EMA20 > EMA60
    // EMA responds faster than SMA, maShort should be larger than old SMA value
    expect(result!.maShort).toBeGreaterThan(100);
  });
});

// ─────────────────────────────────────────────────────
// RSI Wilder smoothing behavior verification
// ─────────────────────────────────────────────────────
describe("rsi() — Wilder smoothing characteristics", () => {
  it("RSI converges more with more data (Wilder smoothing effect)", () => {
    // Same trailing oscillation, short and long data should produce different results
    const base = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 100 : 105));
    const short = base.slice(-15); // minimum data
    const long = base;             // more data (Wilder smoothing is more thorough)
    const rsiShort = rsi(short, 14);
    const rsiLong = rsi(long, 14);
    // Both should be within a reasonable range
    expect(rsiShort).toBeGreaterThan(0);
    expect(rsiShort).toBeLessThan(100);
    expect(rsiLong).toBeGreaterThan(0);
    expect(rsiLong).toBeLessThan(100);
  });

  it("Wilder RSI = 100 when all prices rise", () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(rsi(closes, 14)).toBe(100);
  });

  it("Wilder RSI = 0 when all prices fall", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 30 - i);
    expect(rsi(closes, 14)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────
// CVD Cumulative Volume Delta
// ─────────────────────────────────────────────────────

describe("calculateIndicators — CVD", () => {
  function makeKlinesOhlcv(
    bars: { open: number; close: number; volume: number }[]
  ): Kline[] {
    return bars.map((b, i) => ({
      openTime: i * 3600_000,
      open: b.open,
      high: Math.max(b.open, b.close) * 1.002,
      low: Math.min(b.open, b.close) * 0.998,
      close: b.close,
      volume: b.volume,
      closeTime: (i + 1) * 3600_000,
    }));
  }

  it("CVD is positive when all candles are bullish", () => {
    // 70 bullish candles (satisfies maLongPeriod=60)
    const bars = Array.from({ length: 70 }, (_, i) => ({
      open: 100 + i,
      close: 101 + i,   // close > open → +volume
      volume: 1000,
    }));
    const ind = calculateIndicators(makeKlinesOhlcv(bars), 20, 60, 14);
    expect(ind?.cvd).toBeGreaterThan(0);
  });

  it("CVD is negative when all candles are bearish", () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({
      open: 200 - i,
      close: 199 - i,   // close < open → -volume
      volume: 1000,
    }));
    const ind = calculateIndicators(makeKlinesOhlcv(bars), 20, 60, 14);
    expect(ind?.cvd).toBeLessThan(0);
  });

  it("CVD is positive when buy volume exceeds sell volume", () => {
    // 15 bullish (+1500) + 5 bearish (-500) = +1000
    const bars = [
      ...Array.from({ length: 15 }, () => ({ open: 100, close: 101, volume: 100 })),
      ...Array.from({ length: 5 }, () => ({ open: 101, close: 100, volume: 100 })),
    ];
    // Need 70 candles (maLongPeriod=60), pad the beginning with constant values
    const warmup = Array.from({ length: 50 }, () => ({ open: 100, close: 101, volume: 0 }));
    const ind = calculateIndicators(makeKlinesOhlcv([...warmup, ...bars]), 20, 60, 14);
    expect(ind?.cvd).toBeGreaterThan(0);
  });

  it("cvd field always exists in calculateIndicators result", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    const klines = closes.map((c, i) => ({
      openTime: i * 3600_000,
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      volume: 1000,
      closeTime: (i + 1) * 3600_000,
    }));
    const ind = calculateIndicators(klines, 20, 60, 14);
    expect(ind).not.toBeNull();
    expect(ind?.cvd).toBeDefined();
  });
});

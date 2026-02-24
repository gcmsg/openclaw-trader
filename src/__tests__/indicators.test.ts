import { describe, it, expect } from "vitest";
import { sma, ema, rsi, calculateIndicators } from "../strategy/indicators.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// 测试辅助
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
  it("计算简单移动平均", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4); // 最后3个: 3,4,5
  });

  it("period = 1 时返回最后一个值", () => {
    expect(sma([10, 20, 30], 1)).toBe(30);
  });

  it("数据长度等于 period 时正常计算", () => {
    expect(sma([2, 4, 6], 3)).toBe(4);
  });

  it("数据不足时返回 NaN", () => {
    expect(sma([1, 2], 5)).toBeNaN();
  });

  it("只有一个数据且 period=1 时正确", () => {
    expect(sma([42], 1)).toBe(42);
  });
});

// ─────────────────────────────────────────────────────
// EMA
// ─────────────────────────────────────────────────────

describe("ema()", () => {
  it("数据不足时返回 NaN", () => {
    expect(ema([1, 2], 5)).toBeNaN();
  });

  it("数据长度等于 period 时等于 SMA", () => {
    const values = [10, 20, 30];
    expect(ema(values, 3)).toBeCloseTo(sma(values, 3));
  });

  it("EMA 对新价格的权重高于旧价格", () => {
    // 序列从低到高，EMA 应高于 SMA（更贴近近期）
    const rising = [1, 2, 3, 4, 10];
    const emaVal = ema(rising, 3);
    const smaVal = sma(rising, 3); // 3,4,10 = 5.67
    expect(emaVal).toBeGreaterThan(smaVal);
  });

  it("period=1 时 EMA 等于最后一个值", () => {
    expect(ema([5, 10, 20], 1)).toBe(20);
  });
});

// ─────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────

describe("rsi()", () => {
  it("数据不足时返回 NaN", () => {
    expect(rsi([1, 2, 3], 14)).toBeNaN();
  });

  it("全部上涨时 RSI = 100", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1,2,...,20
    expect(rsi(closes, 14)).toBe(100);
  });

  it("全部下跌时 RSI = 0", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 20 - i); // 20,19,...,1
    expect(rsi(closes, 14)).toBe(0);
  });

  it("RSI 结果在 0-100 之间", () => {
    const closes = [44, 42, 45, 47, 43, 46, 48, 44, 42, 45, 47, 46, 48, 50, 49];
    const result = rsi(closes, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("震荡行情 RSI 在 40-60 之间", () => {
    // 价格上下交替
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
  it("数据不足时返回 null", () => {
    const klines = makeKlines([1, 2, 3]);
    expect(calculateIndicators(klines, 5, 10, 14)).toBeNull();
  });

  it("返回正确的 price（最后一根收盘价）", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(179); // 最后一个
  });

  it("上涨趋势中 maShort > maLong", () => {
    // 前60根平，后20根大幅拉高 → 短期均线高于长期
    const closes = [...Array(60).fill(100), ...Array(20).fill(200)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeGreaterThan(result!.maLong);
  });

  it("下跌趋势中 maShort < maLong", () => {
    // 前60根平，后20根大幅下跌 → 短期均线低于长期
    const closes = [...Array(60).fill(100), ...Array(20).fill(10)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeLessThan(result!.maLong);
  });

  it("返回 prevMaShort 和 prevMaLong", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result!.prevMaShort).toBeDefined();
    expect(result!.prevMaLong).toBeDefined();
  });
});

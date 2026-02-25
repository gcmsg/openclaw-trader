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

  it("EMA 对近期价格更敏感：大幅拉升后 maShort 应明显高于 maLong", () => {
    // 前60根低位，最后5根大幅拉高 → EMA20 应远高于 EMA60
    const closes = [...Array(70).fill(50), ...Array(10).fill(200)];
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result).not.toBeNull();
    expect(result!.maShort).toBeGreaterThan(result!.maLong); // EMA20 > EMA60
    // EMA 比 SMA 更快响应，maShort 应比旧 SMA 值更大
    expect(result!.maShort).toBeGreaterThan(100);
  });
});

// ─────────────────────────────────────────────────────
// RSI Wilder 平滑行为验证
// ─────────────────────────────────────────────────────
describe("rsi() — Wilder 平滑特性", () => {
  it("数据越多 RSI 越收敛（Wilder 平滑效果）", () => {
    // 同样的末尾震荡行情，短数据和长数据结果应有差异
    const base = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 100 : 105));
    const short = base.slice(-15); // 最少数据
    const long = base;             // 更多数据（Wilder 平滑更充分）
    const rsiShort = rsi(short, 14);
    const rsiLong = rsi(long, 14);
    // 两者都应在合理范围内
    expect(rsiShort).toBeGreaterThan(0);
    expect(rsiShort).toBeLessThan(100);
    expect(rsiLong).toBeGreaterThan(0);
    expect(rsiLong).toBeLessThan(100);
  });

  it("全部上涨时 Wilder RSI = 100", () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(rsi(closes, 14)).toBe(100);
  });

  it("全部下跌时 Wilder RSI = 0", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 30 - i);
    expect(rsi(closes, 14)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────
// CVD 累计成交量差值
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

  it("全为涨 K 线时 CVD 为正", () => {
    // 70 根全涨（满足 maLongPeriod=60）
    const bars = Array.from({ length: 70 }, (_, i) => ({
      open: 100 + i,
      close: 101 + i,   // close > open → +volume
      volume: 1000,
    }));
    const ind = calculateIndicators(makeKlinesOhlcv(bars), 20, 60, 14);
    expect(ind?.cvd).toBeGreaterThan(0);
  });

  it("全为跌 K 线时 CVD 为负", () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({
      open: 200 - i,
      close: 199 - i,   // close < open → -volume
      volume: 1000,
    }));
    const ind = calculateIndicators(makeKlinesOhlcv(bars), 20, 60, 14);
    expect(ind?.cvd).toBeLessThan(0);
  });

  it("买盘多于卖盘时 CVD 为正", () => {
    // 15 根涨（+1500）+ 5 根跌（-500）= +1000
    const bars = [
      ...Array.from({ length: 15 }, () => ({ open: 100, close: 101, volume: 100 })),
      ...Array.from({ length: 5 }, () => ({ open: 101, close: 100, volume: 100 })),
    ];
    // 需要 70 根（maLongPeriod=60），用定值填充前面
    const warmup = Array.from({ length: 50 }, () => ({ open: 100, close: 101, volume: 0 }));
    const ind = calculateIndicators(makeKlinesOhlcv([...warmup, ...bars]), 20, 60, 14);
    expect(ind?.cvd).toBeGreaterThan(0);
  });

  it("cvd 字段始终存在于 calculateIndicators 结果", () => {
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

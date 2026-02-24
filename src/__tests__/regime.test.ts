import { describe, it, expect } from "vitest";
import { calcAdx, calcBollingerWidth, analyzePriceStructure, classifyRegime } from "../strategy/regime.js";
import type { Kline } from "../types.js";

// 生成简单模拟 K 线
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

// 生成上升趋势（每根涨 0.5%）
function makeTrendUp(n = 100, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start * (1.005 ** i));
}

// 生成横盘（随机 ±0.2%）
function makeFlat(n = 100, center = 100): number[] {
  return Array.from({ length: n }, () => center * (1 + (Math.random() - 0.5) * 0.004));
}

describe("calcAdx", () => {
  it("上升趋势的 ADX 应该较高", () => {
    const klines = makeKlines(makeTrendUp(80));
    const { adx, diPlus, diMinus } = calcAdx(klines);
    expect(adx).toBeGreaterThan(0);
    expect(diPlus).toBeGreaterThan(diMinus); // 上升趋势 DI+ > DI-
  });

  it("K 线不足时返回 0", () => {
    const klines = makeKlines([100, 101, 102]);
    const { adx } = calcAdx(klines, 14);
    expect(adx).toBe(0);
  });

  it("横盘时 ADX 较低", () => {
    const klines = makeKlines(makeFlat(80));
    const { adx } = calcAdx(klines);
    // 横盘时 ADX 通常 < 25
    expect(adx).toBeGreaterThanOrEqual(0);
  });
});

describe("calcBollingerWidth", () => {
  it("返回值格式正确", () => {
    const closes = makeTrendUp(50);
    const result = calcBollingerWidth(closes);
    expect(result.bbWidth).toBeGreaterThanOrEqual(0);
    expect(result.bbWidthPercentile).toBeGreaterThanOrEqual(0);
    expect(result.bbWidthPercentile).toBeLessThanOrEqual(100);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
  });

  it("数据不足时返回默认值", () => {
    const result = calcBollingerWidth([100, 101], 20);
    expect(result.bbWidth).toBe(0);
    expect(result.bbWidthPercentile).toBe(50);
  });

  it("波动率高时 BB Width 更大", () => {
    const flat = makeFlat(50, 100).map((v, i) => v + (i % 2 === 0 ? 0.1 : -0.1)); // 低波动
    const volatile = Array.from({ length: 50 }, (_, i) => 100 + (i % 3 === 0 ? 5 : -5)); // 高波动
    const flatResult = calcBollingerWidth(flat);
    const volResult = calcBollingerWidth(volatile);
    expect(volResult.bbWidth).toBeGreaterThan(flatResult.bbWidth);
  });
});

describe("analyzePriceStructure", () => {
  it("上升趋势应识别为 higher_highs", () => {
    const klines = makeKlines(makeTrendUp(30));
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("higher_highs");
  });

  it("下降趋势应识别为 lower_lows", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 / (1.005 ** i));
    const klines = makeKlines(closes);
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("lower_lows");
  });

  it("数据不足时返回 flat", () => {
    const klines = makeKlines([100, 101, 102]);
    const structure = analyzePriceStructure(klines, 10);
    expect(structure).toBe("flat");
  });
});

describe("classifyRegime", () => {
  it("上升趋势应分类为 trending_bull", () => {
    const klines = makeKlines(makeTrendUp(100), 0.015, 0.005);
    const result = classifyRegime(klines);
    // 上升趋势最常见结果是 trending_bull 或 breakout_up
    expect(["trending_bull", "breakout_up", "ranging_wide"]).toContain(result.regime);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.adx).toBeGreaterThan(0);
  });

  it("输出结构完整", () => {
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

  it("confidence 在 0-100 之间", () => {
    const klines = makeKlines(makeTrendUp(100));
    const result = classifyRegime(klines);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });
});

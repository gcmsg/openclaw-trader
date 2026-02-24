import { describe, it, expect } from "vitest";
import { calcReturns, pearsonCorrelation, checkCorrelation } from "../strategy/correlation.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// 工具：生成测试用 K 线数组
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
  it("单根 K 线无收益率（需至少 2 根）", () => {
    expect(calcReturns(makeKlines([100]))).toEqual([]);
  });

  it("等比增长：收益率相等", () => {
    // 100 → 110 → 121：ln(1.1) 每次
    const returns = calcReturns(makeKlines([100, 110, 121]));
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 6);
    expect(returns[1]).toBeCloseTo(Math.log(1.1), 6);
  });

  it("价格不变：收益率 = 0", () => {
    const returns = calcReturns(makeKlines([50, 50, 50]));
    expect(returns).toEqual([0, 0]);
  });

  it("下跌：收益率为负", () => {
    const returns = calcReturns(makeKlines([100, 90]));
    expect(returns[0]).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────
// pearsonCorrelation
// ─────────────────────────────────────────────────────

describe("pearsonCorrelation()", () => {
  it("完全正相关 → 1", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(1, 5);
  });

  it("完全负相关 → -1", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it("不相关（正交）→ 0", () => {
    // a 偏多，b 偏空，两者无线性关系
    const a = [1, -1, 1, -1, 1];
    const b = [1, 1, -1, -1, 1];
    // 结果接近 0（不一定精确为 0，取决于数据）
    const corr = pearsonCorrelation(a, b);
    expect(Math.abs(corr)).toBeLessThan(0.6);
  });

  it("数据不足（< 2 个点）→ NaN", () => {
    expect(pearsonCorrelation([], [])).toBeNaN();
    expect(pearsonCorrelation([1], [1])).toBeNaN();
  });

  it("数组长度不同：取较短的长度计算", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6]; // 只有 3 个点
    const corr = pearsonCorrelation(a, b);
    expect(isNaN(corr)).toBe(false);
    expect(Math.abs(corr)).toBeLessThanOrEqual(1);
  });

  it("常数数组（方差=0）→ NaN", () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
});

// ─────────────────────────────────────────────────────
// checkCorrelation
// ─────────────────────────────────────────────────────

describe("checkCorrelation()", () => {
  /** 生成与 base 高度正相关的价格序列（加少量噪音）*/
  function makeCorrelatedPrices(base: number[], noise = 0.01): number[] {
    return base.map((v, i) => v * (1 + (i % 2 === 0 ? noise : -noise)));
  }

  it("无已持仓 → 不过滤", () => {
    const result = checkCorrelation("BTCUSDT", makeKlines([100, 110, 120]), new Map(), 0.7);
    expect(result.correlated).toBe(false);
  });

  it("高相关持仓（> threshold）→ 过滤", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const heldPrices = makeCorrelatedPrices(prices, 0.001); // 接近完全正相关
    const heldKlines = new Map([["ETHUSDT", makeKlines(heldPrices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.7);
    expect(result.correlated).toBe(true);
    expect(result.correlatedWith).toBe("ETHUSDT");
    expect(result.maxCorrelation).toBeGreaterThan(0.7);
    expect(result.reason).toBeTruthy();
  });

  it("低相关持仓（< threshold）→ 允许开仓", () => {
    // BTC 单调上涨，held 资产震荡（低相关）
    const newPrices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const heldPrices = Array.from({ length: 30 }, (_, i) =>
      100 + Math.sin(i * 0.8) * 10
    );
    const heldKlines = new Map([["XRPUSDT", makeKlines(heldPrices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(newPrices), heldKlines, 0.7);
    expect(result.correlated).toBe(false);
  });

  it("相同 symbol 跳过自身比较", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    const heldKlines = new Map([["BTCUSDT", makeKlines(prices)]]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.7);
    // 与自身相关但被跳过，无其他 held symbol → 不过滤
    expect(result.correlated).toBe(false);
  });

  it("数据不足（< 10 根）→ 跳过检查，允许开仓", () => {
    const shortKlines = makeKlines([100, 110, 120]); // 只有 3 根，returns 只有 2
    const heldKlines = new Map([["ETHUSDT", makeKlines([200, 210, 220])]]);
    const result = checkCorrelation("BTCUSDT", shortKlines, heldKlines, 0.7);
    expect(result.correlated).toBe(false);
  });

  it("maxCorrelation 正确返回最高值", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const heldPrices = makeCorrelatedPrices(prices, 0.005);
    const heldKlines = new Map([
      ["ETHUSDT", makeKlines(heldPrices)],
    ]);
    const result = checkCorrelation("BTCUSDT", makeKlines(prices), heldKlines, 0.99);
    // 阈值极高（0.99）→ 不过滤，但 maxCorrelation 应 > 0
    expect(result.correlated).toBe(false);
    expect(result.maxCorrelation).toBeGreaterThan(0);
  });
});

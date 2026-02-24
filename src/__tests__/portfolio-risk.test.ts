import { describe, it, expect } from "vitest";
import {
  calcCorrelationAdjustedSize,
  calcPortfolioExposure,
  type PositionWeight,
} from "../strategy/portfolio-risk.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// 测试用数据生成工具
// ─────────────────────────────────────────────────────

/** 生成一段随机游走价格序列（可控相关性） */
function makeKlines(
  length: number,
  seed: number,
  noise = 0.02,
  drift = 0
): Kline[] {
  const klines: Kline[] = [];
  let price = 1000 + seed * 100;
  const rng = mulberry32(seed);
  for (let i = 0; i < length; i++) {
    const chg = (rng() - 0.5) * noise + drift;
    price *= 1 + chg;
    klines.push({
      openTime: i * 3600000,
      open: price,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 100 + rng() * 50,
      closeTime: i * 3600000 + 3599999,
    });
  }
  return klines;
}

/** 生成与另一序列高度相关的 K 线（叠加少量独立噪音） */
function makeCorrelatedKlines(base: Kline[], noiseFactor = 0.1, seed = 99): Kline[] {
  const rng = mulberry32(seed);
  return base.map((k, i) => {
    const indepChg = (rng() - 0.5) * noiseFactor * 0.01;
    const price = k.close * (1 + indepChg);
    return {
      ...k,
      openTime: i * 3600000,
      open: price,
      high: price * 1.003,
      low: price * 0.997,
      close: price,
      closeTime: i * 3600000 + 3599999,
    };
  });
}

/** 简单伪随机数生成器（确定性测试） */
function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────
// calcCorrelationAdjustedSize()
// ─────────────────────────────────────────────────────

describe("calcCorrelationAdjustedSize()", () => {
  it("组合为空时 → 正常仓位，不缩减", () => {
    const btcKlines = makeKlines(70, 1);
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, [], { BTCUSDT: btcKlines }
    );
    expect(result.decision).toBe("normal");
    expect(result.heat).toBe(0);
    expect(result.sizeMultiplier).toBe(1);
    expect(result.adjustedPositionRatio).toBe(0.2);
  });

  it("已持仓 K 线不足 10 根 → 跳过相关性计算，正常仓位", () => {
    const btcKlines = makeKlines(70, 1);
    const ethKlines = makeKlines(5, 2); // 数据不足
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: btcKlines, ETHUSDT: ethKlines }
    );
    // ETH K 线不足 → 贡献 = 0 → heat = 0
    expect(result.heat).toBe(0);
    expect(result.decision).toBe("normal");
  });

  it("新仓 K 线不足 10 根 → 返回 normal（数据不足跳过）", () => {
    const btcKlines = makeKlines(5, 1); // 新仓数据不足
    const ethKlines = makeKlines(70, 2);
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: btcKlines, ETHUSDT: ethKlines }
    );
    expect(result.decision).toBe("normal");
  });

  it("高相关同向持仓（0.85 corr × 0.30 weight）→ 仓位缩减约 25%", () => {
    const base = makeKlines(70, 42);
    const correlated = makeCorrelatedKlines(base, 0.05, 7); // 极高相关
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: base, ETHUSDT: correlated },
      60, 0.9
    );
    // heat ≈ corr × 0.30；corr 很高（接近 1），所以 heat ≈ 0.30
    expect(result.heat).toBeGreaterThan(0.2);
    expect(result.heat).toBeLessThan(0.5);
    expect(result.sizeMultiplier).toBeLessThan(0.85);   // 至少缩减 15%
    expect(result.adjustedPositionRatio).toBeLessThan(0.2);
    expect(result.decision).toBe("reduced");
  });

  it("热度达到 maxHeat（0.9）→ 拒绝开仓（blocked）", () => {
    const base = makeKlines(70, 42);
    const c1 = makeCorrelatedKlines(base, 0.02, 7);
    const c2 = makeCorrelatedKlines(base, 0.02, 13);
    const c3 = makeCorrelatedKlines(base, 0.02, 17);
    // 三个高相关仓位，各权重 0.35
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 350, weight: 0.35 },
      { symbol: "SOLUSDT", side: "long", notionalUsdt: 350, weight: 0.35 },
      { symbol: "BNBUSDT", side: "long", notionalUsdt: 350, weight: 0.35 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: base, ETHUSDT: c1, SOLUSDT: c2, BNBUSDT: c3 },
      60, 0.9
    );
    // heat ≈ corr × 0.35 × 3 ≈ 1.0+ → blocked
    expect(result.decision).toBe("blocked");
    expect(result.heat).toBeGreaterThanOrEqual(0.9);
    expect(result.adjustedPositionRatio).toBe(0); // blocked → ratio = 0
  });

  it("反向仓位（做多 + 做空）→ 对冲效果，heat 降低", () => {
    const base = makeKlines(70, 42);
    const correlated = makeCorrelatedKlines(base, 0.02, 7);
    // ETH 持有空仓，新开 BTC 多仓（方向相反 = 对冲）
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "short", notionalUsdt: 300, weight: 0.3 },
    ];
    const resultOpposite = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: base, ETHUSDT: correlated },
      60, 0.9
    );
    // 方向相反 → 有效 corr = -|corr| → contribution < 0 → heat = max(0, negative) = 0
    expect(resultOpposite.heat).toBe(0);
    expect(resultOpposite.decision).toBe("normal");
    expect(resultOpposite.sizeMultiplier).toBe(1);
  });

  it("低相关持仓（独立随机游走）→ 仓位几乎不缩减", () => {
    const btcKlines = makeKlines(70, 1);   // 独立序列
    const ethKlines = makeKlines(70, 999); // 完全独立的随机序列
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: btcKlines, ETHUSDT: ethKlines }
    );
    // 低相关 → heat 很小 → sizeMultiplier 接近 1
    expect(result.heat).toBeLessThan(0.3);
  });

  it("adjustedPositionRatio = baseRatio × sizeMultiplier", () => {
    const base = makeKlines(70, 42);
    const correlated = makeCorrelatedKlines(base, 0.1, 7);
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 200, weight: 0.2 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.4, positions,
      { BTCUSDT: base, ETHUSDT: correlated }
    );
    expect(result.adjustedPositionRatio).toBeCloseTo(0.4 * result.sizeMultiplier, 8);
  });
});

// ─────────────────────────────────────────────────────
// calcPortfolioExposure()
// ─────────────────────────────────────────────────────

describe("calcPortfolioExposure()", () => {
  it("空组合 → 全零暴露，low 风险", () => {
    const result = calcPortfolioExposure([], 1000);
    expect(result.totalNotionalUsdt).toBe(0);
    expect(result.grossExposureRatio).toBe(0);
    expect(result.netExposureRatio).toBe(0);
    expect(result.riskLevel).toBe("low");
    expect(result.numLong).toBe(0);
    expect(result.numShort).toBe(0);
  });

  it("纯多头 → longExposureRatio 正确，netExposureRatio 正", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 200, weight: 0.2 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(result.longExposureRatio).toBeCloseTo(0.5, 5);
    expect(result.shortExposureRatio).toBe(0);
    expect(result.netExposureRatio).toBeCloseTo(0.5, 5);
    expect(result.grossExposureRatio).toBeCloseTo(0.5, 5);
    expect(result.numLong).toBe(2);
    expect(result.numShort).toBe(0);
  });

  it("多空对冲 → 净暴露接近 0，总暴露为多空之和", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
      { symbol: "ETHUSDT", side: "short", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(result.netExposureRatio).toBeCloseTo(0, 5);
    expect(result.grossExposureRatio).toBeCloseTo(0.6, 5);
  });

  it("仓位 > 60% → high 风险（无相关性数据）", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 700, weight: 0.7 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(result.grossExposureRatio).toBeCloseTo(0.7, 5);
    expect(result.riskLevel).toBe("high");
  });

  it("仓位 > 80% + 高相关（>0.75）→ extreme 风险", () => {
    const base = makeKlines(70, 42);
    const c1 = makeCorrelatedKlines(base, 0.02, 7);
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 450, weight: 0.45 },
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 450, weight: 0.45 },
    ];
    const result = calcPortfolioExposure(positions, 1000, {
      BTCUSDT: base,
      ETHUSDT: c1,
    });
    expect(result.grossExposureRatio).toBeCloseTo(0.9, 5);
    expect(result.avgPairwiseCorrelation).not.toBeNull();
    expect(result.avgPairwiseCorrelation!).toBeGreaterThan(0.75);
    expect(result.riskLevel).toBe("extreme");
  });

  it("仓位 10-30% → medium 或 low 风险", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 200, weight: 0.2 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(["low", "medium"]).toContain(result.riskLevel);
  });

  it("totalEquity = 0 → 所有比例为 0，不崩溃", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 0);
    expect(result.grossExposureRatio).toBe(0);
    expect(result.netExposureRatio).toBe(0);
  });

  it("单持仓 → avgPairwiseCorrelation 为 null（不足 2 个配对）", () => {
    const base = makeKlines(70, 42);
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 1000, { BTCUSDT: base });
    expect(result.avgPairwiseCorrelation).toBeNull();
  });
});

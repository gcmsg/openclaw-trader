import { describe, it, expect } from "vitest";
import {
  calcCorrelationAdjustedSize,
  calcPortfolioExposure,
  type PositionWeight,
} from "../strategy/portfolio-risk.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Test data generation utilities
// ─────────────────────────────────────────────────────

/** Generate a random walk price series (with controllable correlation) */
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

/** Generate klines highly correlated with another series (adding small independent noise) */
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

/** Simple PRNG (deterministic testing) */
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
  it("empty portfolio → normal position, no reduction", () => {
    const btcKlines = makeKlines(70, 1);
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, [], { BTCUSDT: btcKlines }
    );
    expect(result.decision).toBe("normal");
    expect(result.heat).toBe(0);
    expect(result.sizeMultiplier).toBe(1);
    expect(result.adjustedPositionRatio).toBe(0.2);
  });

  it("existing position klines fewer than 10 → skip correlation, normal position", () => {
    const btcKlines = makeKlines(70, 1);
    const ethKlines = makeKlines(5, 2); // Insufficient data
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: btcKlines, ETHUSDT: ethKlines }
    );
    // ETH klines insufficient → contribution = 0 → heat = 0
    expect(result.heat).toBe(0);
    expect(result.decision).toBe("normal");
  });

  it("new position klines fewer than 10 → returns normal (skip due to insufficient data)", () => {
    const btcKlines = makeKlines(5, 1); // New position data insufficient
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

  it("highly correlated same-direction position (0.85 corr x 0.30 weight) → ~25% size reduction", () => {
    const base = makeKlines(70, 42);
    const correlated = makeCorrelatedKlines(base, 0.05, 7); // Extremely high correlation
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: base, ETHUSDT: correlated },
      60, 0.9
    );
    // heat ≈ corr × 0.30; corr is very high (close to 1), so heat ≈ 0.30
    expect(result.heat).toBeGreaterThan(0.2);
    expect(result.heat).toBeLessThan(0.5);
    expect(result.sizeMultiplier).toBeLessThan(0.85);   // at least 15% reduction
    expect(result.adjustedPositionRatio).toBeLessThan(0.2);
    expect(result.decision).toBe("reduced");
  });

  it("heat reaches maxHeat (0.9) → rejects opening (blocked)", () => {
    const base = makeKlines(70, 42);
    const c1 = makeCorrelatedKlines(base, 0.02, 7);
    const c2 = makeCorrelatedKlines(base, 0.02, 13);
    const c3 = makeCorrelatedKlines(base, 0.02, 17);
    // Three highly correlated positions, each weight 0.35
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
    // heat ≈ corr × 0.35 × 3 ≈ 1.0+ -> blocked
    expect(result.decision).toBe("blocked");
    expect(result.heat).toBeGreaterThanOrEqual(0.9);
    expect(result.adjustedPositionRatio).toBe(0); // blocked → ratio = 0
  });

  it("opposite directions (long + short) → hedging effect, heat reduced", () => {
    const base = makeKlines(70, 42);
    const correlated = makeCorrelatedKlines(base, 0.02, 7);
    // ETH holds short, opening BTC long (opposite direction = hedge)
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "short", notionalUsdt: 300, weight: 0.3 },
    ];
    const resultOpposite = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: base, ETHUSDT: correlated },
      60, 0.9
    );
    // Opposite directions -> effective corr = -|corr| -> contribution < 0 -> heat = max(0, negative) = 0
    expect(resultOpposite.heat).toBe(0);
    expect(resultOpposite.decision).toBe("normal");
    expect(resultOpposite.sizeMultiplier).toBe(1);
  });

  it("low-correlation positions (independent random walks) → almost no size reduction", () => {
    const btcKlines = makeKlines(70, 1);   // Independent series
    const ethKlines = makeKlines(70, 999); // Completely independent random series
    const positions: PositionWeight[] = [
      { symbol: "ETHUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcCorrelationAdjustedSize(
      "BTCUSDT", "long", 0.2, positions,
      { BTCUSDT: btcKlines, ETHUSDT: ethKlines }
    );
    // Low correlation -> heat is small -> sizeMultiplier close to 1
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
  it("empty portfolio → zero exposure, low risk", () => {
    const result = calcPortfolioExposure([], 1000);
    expect(result.totalNotionalUsdt).toBe(0);
    expect(result.grossExposureRatio).toBe(0);
    expect(result.netExposureRatio).toBe(0);
    expect(result.riskLevel).toBe("low");
    expect(result.numLong).toBe(0);
    expect(result.numShort).toBe(0);
  });

  it("long-only → longExposureRatio correct, netExposureRatio positive", () => {
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

  it("long-short hedge → net exposure near 0, gross exposure is sum of both", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
      { symbol: "ETHUSDT", side: "short", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(result.netExposureRatio).toBeCloseTo(0, 5);
    expect(result.grossExposureRatio).toBeCloseTo(0.6, 5);
  });

  it("exposure > 60% → high risk (no correlation data)", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 700, weight: 0.7 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(result.grossExposureRatio).toBeCloseTo(0.7, 5);
    expect(result.riskLevel).toBe("high");
  });

  it("exposure > 80% + high correlation (>0.75) → extreme risk", () => {
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

  it("exposure 10-30% → medium or low risk", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 200, weight: 0.2 },
    ];
    const result = calcPortfolioExposure(positions, 1000);
    expect(["low", "medium"]).toContain(result.riskLevel);
  });

  it("totalEquity = 0 → all ratios are 0, no crash", () => {
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 0);
    expect(result.grossExposureRatio).toBe(0);
    expect(result.netExposureRatio).toBe(0);
  });

  it("single position → avgPairwiseCorrelation is null (fewer than 2 pairs)", () => {
    const base = makeKlines(70, 42);
    const positions: PositionWeight[] = [
      { symbol: "BTCUSDT", side: "long", notionalUsdt: 300, weight: 0.3 },
    ];
    const result = calcPortfolioExposure(positions, 1000, { BTCUSDT: base });
    expect(result.avgPairwiseCorrelation).toBeNull();
  });
});

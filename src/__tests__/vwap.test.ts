/**
 * VWAP tests
 */
import { describe, it, expect } from "vitest";
import { calcVwap, calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import type { Kline, Indicators, StrategyConfig } from "../types.js";

// ─── Helpers ────────────────────────────────────────────

const DAY_START = Date.UTC(2024, 0, 15); // 2024-01-15 00:00 UTC

function makeKline(
  opts: { high: number; low: number; close: number; volume: number; openTime?: number; open?: number }
): Kline {
  return {
    openTime: opts.openTime ?? DAY_START,
    open: opts.open ?? (opts.high + opts.low) / 2,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: opts.volume,
    closeTime: (opts.openTime ?? DAY_START) + 3600_000,
  };
}

/** Generate sufficient warmup klines (previous day) + current day klines */
function makeSession(dayBars: Kline[], warmupCount = 65): Kline[] {
  const prevDay = DAY_START - 86400_000;
  const warmup: Kline[] = Array.from({ length: warmupCount }, (_, i) => ({
    openTime: prevDay + i * 3600_000,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1000,
    closeTime: prevDay + (i + 1) * 3600_000,
  }));
  return [...warmup, ...dayBars];
}

// ─── calcVwap core calculation ────────────────────────────────

describe("calcVwap()", () => {
  it("single kline: VWAP = typical price", () => {
    const k = makeKline({ high: 110, low: 90, close: 100, volume: 1000 });
    const res = calcVwap([k]);
    expect(res).not.toBeNull();
    // tp = (110+90+100)/3 = 100, variance is 0
    expect(res?.vwap).toBeCloseTo(100, 4);
    expect(res?.upper1).toBeCloseTo(100, 4);
    expect(res?.lower1).toBeCloseTo(100, 4);
  });

  it("equal volumes: VWAP = simple average of typical prices", () => {
    const klines = [
      makeKline({ high: 110, low: 90, close: 100, volume: 100 }), // tp=100
      makeKline({ high: 120, low: 100, close: 110, volume: 100 }), // tp=110
      makeKline({ high: 130, low: 110, close: 120, volume: 100 }), // tp=120
    ];
    const res = calcVwap(klines);
    expect(res?.vwap).toBeCloseTo(110, 4); // (100+110+120)/3
  });

  it("high-volume kline has more weight", () => {
    const klines = [
      makeKline({ high: 200, low: 180, close: 190, volume: 1, openTime: DAY_START }),      // tp=190
      makeKline({ high: 110, low: 90, close: 100, volume: 999, openTime: DAY_START + 1 }), // tp=100
    ];
    const res = calcVwap(klines);
    // Should be close to 100 since the second bar has much higher volume
    expect(res?.vwap).toBeCloseTo(100.09, 1);
  });

  it("cross-day: only uses current day klines", () => {
    const prevDayKline = makeKline({ high: 200, low: 180, close: 190, volume: 9999, openTime: DAY_START - 3600_000 });
    const todayKline = makeKline({ high: 110, low: 90, close: 100, volume: 100, openTime: DAY_START });
    const res = calcVwap([prevDayKline, todayKline]);
    // Only today: tp = (110+90+100)/3 = 100
    expect(res?.vwap).toBeCloseTo(100, 4);
  });

  it("empty array returns null", () => {
    expect(calcVwap([])).toBeNull();
  });

  it("deviation bands: upper1 > vwap > lower1", () => {
    const klines = [
      makeKline({ high: 120, low: 80, close: 100, volume: 100, openTime: DAY_START }),
      makeKline({ high: 130, low: 90, close: 110, volume: 100, openTime: DAY_START + 1 }),
      makeKline({ high: 100, low: 60, close: 80, volume: 100, openTime: DAY_START + 2 }),
    ];
    const res = calcVwap(klines);
    expect(res).not.toBeNull();
    expect(res!.upper1).toBeGreaterThan(res!.vwap);
    expect(res!.lower1).toBeLessThan(res!.vwap);
    expect(res!.upper2).toBeGreaterThan(res!.upper1);
    expect(res!.lower2).toBeLessThan(res!.lower1);
  });
});

// ─── calculateIndicators integration ─────────────────────────

describe("calculateIndicators — VWAP integration", () => {
  it("VWAP fields are present in indicators result", () => {
    const today = [
      makeKline({ high: 110, low: 90, close: 100, volume: 1000, openTime: DAY_START }),
      makeKline({ high: 112, low: 92, close: 102, volume: 1000, openTime: DAY_START + 3600_000 }),
    ];
    const klines = makeSession(today);
    const ind = calculateIndicators(klines, 20, 60, 14);
    expect(ind).not.toBeNull();
    expect(ind?.vwap).toBeDefined();
    expect(ind?.vwapUpper1).toBeDefined();
    expect(ind?.vwapLower1).toBeDefined();
    expect(ind?.vwapUpper2).toBeDefined();
    expect(ind?.vwapLower2).toBeDefined();
  });

  it("prevPrice field is the close of the second-to-last kline", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    const klines = closes.map((c, i) => ({
      openTime: DAY_START + i * 3600_000,
      open: c,
      high: c + 2,
      low: c - 2,
      close: c,
      volume: 1000,
      closeTime: DAY_START + (i + 1) * 3600_000,
    }));
    const ind = calculateIndicators(klines, 20, 60, 14);
    // prevPrice should be the close of the second-to-last bar (168)
    expect(ind?.prevPrice).toBe(168);
  });
});

// ─── Signal conditions ─────────────────────────────────────────

interface IndOverrides { price?: number; vwap?: number; vwapUpper2?: number; vwapLower2?: number; prevPrice?: number }

function makeInd(overrides: IndOverrides = {}): Indicators {
  const base: Indicators = {
    maShort: 100,
    maLong: 100,
    rsi: 50,
    price: overrides.price ?? 100,
    volume: 1000,
    avgVolume: 1000,
    prevMaShort: 100,
    prevMaLong: 100,
  };
  if (overrides.vwap !== undefined) {
    base.vwap = overrides.vwap;
    base.vwapUpper1 = overrides.vwap + 5;
    base.vwapLower1 = overrides.vwap - 5;
    base.vwapUpper2 = overrides.vwapUpper2 ?? overrides.vwap + 10;
    base.vwapLower2 = overrides.vwapLower2 ?? overrides.vwap - 10;
  }
  if (overrides.vwapUpper2 !== undefined) base.vwapUpper2 = overrides.vwapUpper2;
  if (overrides.vwapLower2 !== undefined) base.vwapLower2 = overrides.vwapLower2;
  if (overrides.prevPrice !== undefined) base.prevPrice = overrides.prevPrice;
  return base;
}

function makeSimpleCfg(buyConds: string[], sellConds: string[]): StrategyConfig {
  return {
    paper: { initial_usdt: 10000, scenarioId: "test" },
    strategy: {
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    risk: { stop_loss_percent: 5, position_ratio: 0.2, max_positions: 4, max_position_per_symbol: 1, max_total_loss_percent: 20 },
    signals: { buy: buyConds, sell: sellConds, short: [], cover: [] },
    execution: {},
  } as unknown as StrategyConfig;
}

describe("VWAP signal conditions", () => {
  it("price_above_vwap: price > VWAP triggers buy", () => {
    const ind = makeInd({ price: 105, vwap: 100 });
    const cfg = makeSimpleCfg(["price_above_vwap"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("price_below_vwap: price < VWAP triggers sell when holding long", () => {
    const ind = makeInd({ price: 95, vwap: 100 });
    const cfg = makeSimpleCfg([], ["price_below_vwap"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("vwap_bounce: previous bar below VWAP, current bar above VWAP", () => {
    const ind = makeInd({ price: 102, vwap: 100, prevPrice: 97 }); // prev < vwap, now > vwap
    const cfg = makeSimpleCfg(["vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
    expect(sig.reason).toContain("vwap_bounce");
  });

  it("vwap_bounce: does not trigger without actual crossover", () => {
    const ind = makeInd({ price: 102, vwap: 100, prevPrice: 101 }); // prev already above vwap
    const cfg = makeSimpleCfg(["vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("vwap_breakdown: breaks below VWAP opens short", () => {
    const ind = makeInd({ price: 98, vwap: 100, prevPrice: 102 }); // prev above, now below
    const cfg = makeSimpleCfg([], []);
    cfg.signals.short = ["vwap_breakdown"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("short");
  });

  it("price_above_vwap_upper2: overbought trigger", () => {
    const ind = makeInd({ price: 115, vwap: 100, vwapUpper2: 110 });
    const cfg = makeSimpleCfg([], ["price_above_vwap_upper2"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("price_below_vwap_lower2: oversold triggers long", () => {
    const ind = makeInd({ price: 85, vwap: 100, vwapLower2: 90 });
    const cfg = makeSimpleCfg(["price_below_vwap_lower2"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("signal does not trigger when vwap is undefined", () => {
    const ind = makeInd({ price: 105 }); // vwap=undefined
    const cfg = makeSimpleCfg(["price_above_vwap", "vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });
});

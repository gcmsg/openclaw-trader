/**
 * VWAP 测试
 */
import { describe, it, expect } from "vitest";
import { calcVwap, calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import type { Kline, Indicators, StrategyConfig } from "../types.js";

// ─── 辅助 ────────────────────────────────────────────

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

/** 生成充足的 warmup K 线（前一天）+ 当日 K 线 */
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

// ─── calcVwap 核心计算 ────────────────────────────────

describe("calcVwap()", () => {
  it("单根 K 线时 VWAP = typical price", () => {
    const k = makeKline({ high: 110, low: 90, close: 100, volume: 1000 });
    const res = calcVwap([k]);
    expect(res).not.toBeNull();
    // tp = (110+90+100)/3 = 100，方差为0
    expect(res?.vwap).toBeCloseTo(100, 4);
    expect(res?.upper1).toBeCloseTo(100, 4);
    expect(res?.lower1).toBeCloseTo(100, 4);
  });

  it("成交量相等时 VWAP = 简单 tp 均值", () => {
    const klines = [
      makeKline({ high: 110, low: 90, close: 100, volume: 100 }), // tp=100
      makeKline({ high: 120, low: 100, close: 110, volume: 100 }), // tp=110
      makeKline({ high: 130, low: 110, close: 120, volume: 100 }), // tp=120
    ];
    const res = calcVwap(klines);
    expect(res?.vwap).toBeCloseTo(110, 4); // (100+110+120)/3
  });

  it("大成交量 K 线权重更高", () => {
    const klines = [
      makeKline({ high: 200, low: 180, close: 190, volume: 1, openTime: DAY_START }),      // tp=190
      makeKline({ high: 110, low: 90, close: 100, volume: 999, openTime: DAY_START + 1 }), // tp=100
    ];
    const res = calcVwap(klines);
    // 应该接近 100，因为第二根成交量大得多
    expect(res?.vwap).toBeCloseTo(100.09, 1);
  });

  it("跨日时只使用当日 K 线", () => {
    const prevDayKline = makeKline({ high: 200, low: 180, close: 190, volume: 9999, openTime: DAY_START - 3600_000 });
    const todayKline = makeKline({ high: 110, low: 90, close: 100, volume: 100, openTime: DAY_START });
    const res = calcVwap([prevDayKline, todayKline]);
    // 仅 today: tp = (110+90+100)/3 = 100
    expect(res?.vwap).toBeCloseTo(100, 4);
  });

  it("空数组返回 null", () => {
    expect(calcVwap([])).toBeNull();
  });

  it("偏差带：upper1 > vwap > lower1", () => {
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

// ─── calculateIndicators 集成 ─────────────────────────

describe("calculateIndicators — VWAP 集成", () => {
  it("VWAP 字段存在于 indicators 结果", () => {
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

  it("prevPrice 字段为前一根 K 线收盘价", () => {
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
    // prevPrice 应为倒数第二根的 close（168）
    expect(ind?.prevPrice).toBe(168);
  });
});

// ─── 信号条件 ─────────────────────────────────────────

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

describe("VWAP 信号条件", () => {
  it("price_above_vwap: 价格 > VWAP 触发买入", () => {
    const ind = makeInd({ price: 105, vwap: 100 });
    const cfg = makeSimpleCfg(["price_above_vwap"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("price_below_vwap: 价格 < VWAP 触发持多卖出", () => {
    const ind = makeInd({ price: 95, vwap: 100 });
    const cfg = makeSimpleCfg([], ["price_below_vwap"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("vwap_bounce: 前一根低于 VWAP，当前回到 VWAP 以上", () => {
    const ind = makeInd({ price: 102, vwap: 100, prevPrice: 97 }); // prev < vwap, now > vwap
    const cfg = makeSimpleCfg(["vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
    expect(sig.reason).toContain("vwap_bounce");
  });

  it("vwap_bounce: 没有真正穿越时不触发", () => {
    const ind = makeInd({ price: 102, vwap: 100, prevPrice: 101 }); // prev already above vwap
    const cfg = makeSimpleCfg(["vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("vwap_breakdown: 跌破 VWAP 做空", () => {
    const ind = makeInd({ price: 98, vwap: 100, prevPrice: 102 }); // prev above, now below
    const cfg = makeSimpleCfg([], []);
    cfg.signals.short = ["vwap_breakdown"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("short");
  });

  it("price_above_vwap_upper2: 超买触发", () => {
    const ind = makeInd({ price: 115, vwap: 100, vwapUpper2: 110 });
    const cfg = makeSimpleCfg([], ["price_above_vwap_upper2"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("price_below_vwap_lower2: 超卖触发做多", () => {
    const ind = makeInd({ price: 85, vwap: 100, vwapLower2: 90 });
    const cfg = makeSimpleCfg(["price_below_vwap_lower2"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("vwap 未定义时信号不触发", () => {
    const ind = makeInd({ price: 105 }); // vwap=undefined
    const cfg = makeSimpleCfg(["price_above_vwap", "vwap_bounce"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });
});

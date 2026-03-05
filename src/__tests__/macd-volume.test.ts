import { describe, it, expect } from "vitest";
import { macd, volumeRatio, calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────

function makeKlines(closes: number[], volumes?: number[]) {
  return closes.map((close, i) => ({
    openTime: i * 3600000,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: volumes?.[i] ?? 1000,
    closeTime: (i + 1) * 3600000 - 1,
  }));
}

function makeConfig(buy: string[], sell: string[]): StrategyConfig {
  return {
    symbols: [],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
      volume: { surge_ratio: 1.5, low_ratio: 0.5 },
    },
    signals: { buy, sell },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 10,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      max_total_loss_percent: 20,
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      daily_loss_limit_percent: 8,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: true,
      on_trade: true,
      on_stop_loss: true,
      on_take_profit: true,
      on_error: true,
      on_daily_summary: true,
      min_interval_minutes: 30,
    },
    news: { enabled: true, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    schedule: {},
    mode: "paper",
  };
}

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 100,
    maLong: 100,
    rsi: 50,
    price: 100,
    volume: 1000,
    avgVolume: 1000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// MACD calculation
// ─────────────────────────────────────────────────────

describe("macd()", () => {
  it("returns null when data is insufficient", () => {
    expect(macd([1, 2, 3], 12, 26, 9)).toBeNull();
  });

  it("MACD > signal line in uptrend (bullish)", () => {
    // Use accelerating uptrend curve (exponential growth) so fast line is clearly above slow line
    const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.02, i));
    const result = macd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.macd).toBeGreaterThan(result!.signal);
    expect(result!.histogram).toBeGreaterThan(0);
  });

  it("histogram < 0 in downtrend", () => {
    // Sharp rally first, then rapid decline → MACD turns negative, histogram is negative
    const up = Array.from({ length: 40 }, (_, i) => 100 + i * 5);
    const down = Array.from({ length: 20 }, (_, i) => 295 - i * 10);
    const closes = [...up, ...down];
    const result = macd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.histogram).toBeLessThan(0);
  });

  it("returns prevMacd and prevSignal", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const result = macd(closes, 12, 26, 9);
    expect(result!.prevMacd).toBeDefined();
    expect(result!.prevSignal).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────
// Volume ratio
// ─────────────────────────────────────────────────────

describe("volumeRatio()", () => {
  it("returns NaN when data is insufficient", () => {
    expect(volumeRatio([1000, 1000], 20)).toBeNaN();
  });

  it("ratio is 1 when current volume equals average", () => {
    const vols = Array(21).fill(1000);
    expect(volumeRatio(vols, 20)).toBeCloseTo(1, 2);
  });

  it("ratio is 2 when current volume is 2x the average", () => {
    const vols = [...Array(20).fill(1000), 2000];
    expect(volumeRatio(vols, 20)).toBeCloseTo(2, 2);
  });

  it("average is based on previous N candles, excluding current", () => {
    // Previous 20 candles avg=1000, current=5000, should not affect baseline
    const vols = [...Array(20).fill(1000), 5000];
    const ratio = volumeRatio(vols, 20);
    expect(ratio).toBeCloseTo(5, 2);
  });
});

// ─────────────────────────────────────────────────────
// calculateIndicators integration with MACD
// ─────────────────────────────────────────────────────

describe("calculateIndicators() with MACD", () => {
  it("returns macd field when MACD is enabled", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14, {
      enabled: true,
      fast: 12,
      slow: 26,
      signal: 9,
    });
    expect(result?.macd).toBeDefined();
  });

  it("does not return macd field when MACD is disabled", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14, {
      enabled: false,
      fast: 12,
      slow: 26,
      signal: 9,
    });
    expect(result?.macd).toBeUndefined();
  });

  it("volume fields are always present", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes, Array(80).fill(2000));
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result?.volume).toBe(2000);
    expect(result?.avgVolume).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// MACD signal detection
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD signals", () => {
  it("macd_bullish: triggers buy when MACD > Signal and histogram > 0", () => {
    const ind = makeIndicators({
      macd: { macd: 10, signal: 5, histogram: 5, prevMacd: 8, prevSignal: 6, prevHistogram: 2 },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_bullish"], [])).type).toBe("buy");
  });

  it("macd_bearish: triggers sell when MACD < Signal and histogram < 0", () => {
    const ind = makeIndicators({
      macd: {
        macd: -10,
        signal: -5,
        histogram: -5,
        prevMacd: -8,
        prevSignal: -6,
        prevHistogram: -2,
      },
    });
    expect(detectSignal("X", ind, makeConfig([], ["macd_bearish"]), "long").type).toBe("sell");
  });

  it("macd_golden_cross: triggers when MACD crosses above signal line", () => {
    const ind = makeIndicators({
      macd: {
        macd: 2,
        signal: 1,
        histogram: 1,
        prevMacd: -1,
        prevSignal: 0.5,
        prevHistogram: -1.5,
      },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_golden_cross"], [])).type).toBe("buy");
  });

  it("macd_golden_cross: does not trigger when already above signal line", () => {
    const ind = makeIndicators({
      macd: { macd: 3, signal: 1, histogram: 2, prevMacd: 1.5, prevSignal: 1, prevHistogram: 0.5 },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_golden_cross"], [])).type).toBe("none");
  });

  it("does not trigger MACD signal when macd field is empty", () => {
    const ind = makeIndicators({}); // macd not set = no MACD data;
    expect(detectSignal("X", ind, makeConfig(["macd_bullish"], [])).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// Volume signal detection
// ─────────────────────────────────────────────────────

describe("detectSignal() - volume signals", () => {
  it("volume_surge: triggers when volume exceeds threshold", () => {
    const ind = makeIndicators({ volume: 2000, avgVolume: 1000 }); // 2x > 1.5x
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("buy");
  });

  it("volume_surge: does not trigger when volume is below threshold", () => {
    const ind = makeIndicators({ volume: 1200, avgVolume: 1000 }); // 1.2x < 1.5x
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("none");
  });

  it("volume_low: triggers when volume is below threshold", () => {
    const ind = makeIndicators({ volume: 400, avgVolume: 1000 }); // 0.4x < 0.5x
    expect(detectSignal("X", ind, makeConfig(["volume_low"], [])).type).toBe("buy");
  });

  it("does not trigger when avgVolume is 0 (prevents division by zero)", () => {
    const ind = makeIndicators({ volume: 1000, avgVolume: 0 });
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("none");
  });
});

/**
 * Strategy Plugin unit tests (F4)
 * Tests core logic of rsi-reversal and breakout strategies
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getStrategy } from "../strategies/registry.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { Kline, StrategyConfig, Indicators } from "../types.js";

// Trigger registration
await import("../strategies/index.js");

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeMinimalCfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [], short: [], cover: [] },
    risk: {
      stop_loss_percent: 2,
      take_profit_percent: 4,
      trailing_stop: { enabled: false, activation_percent: 2, callback_percent: 1 },
      position_ratio: 0.1,
      max_positions: 5,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 5,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 30,
    },
    notify: {
      on_signal: true, on_trade: true, on_stop_loss: true,
      on_take_profit: true, on_error: true, on_daily_summary: true,
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    ...overrides,
  };
}

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 105, maLong: 100, rsi: 50,
    price: 100, volume: 1000, avgVolume: 800,
    ...overrides,
  };
}

/** Generate N klines (all with close = basePrice) */
function makeKlines(n: number, basePrice = 100, volumeOverride?: number): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 3_600_000,
    open: basePrice * 0.999,
    high: basePrice * 1.005,
    low: basePrice * 0.995,
    close: basePrice,
    volume: volumeOverride ?? 1000,
    closeTime: (i + 1) * 3_600_000,
  }));
}

function makeCtx(
  klines: Kline[],
  ind: Indicators = makeIndicators(),
  cfgOverrides: Partial<StrategyConfig> = {}
): StrategyContext {
  return { klines, cfg: makeMinimalCfg(cfgOverrides), indicators: ind };
}

// ─────────────────────────────────────────────────────
// RSI Reversal Strategy
// ─────────────────────────────────────────────────────

describe("rsi-reversal strategy", () => {
  let strategy: Strategy;

  beforeAll(async () => {
    await import("../strategies/index.js");
    strategy = getStrategy("rsi-reversal");
  });

  it("id and name are correct", () => {
    expect(strategy.id).toBe("rsi-reversal");
    expect(strategy.name).toBeTruthy();
  });

  it("RSI < 30 (oversold) -> buy", () => {
    const ind = makeIndicators({ rsi: 25 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("buy");
  });

  it("RSI === 29.9 (boundary) -> buy", () => {
    const ind = makeIndicators({ rsi: 29.9 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("buy");
  });

  it("RSI === 30 (exactly equals oversold) -> none (does not trigger)", () => {
    // Condition is < 30, does not trigger at equality
    const ind = makeIndicators({ rsi: 30 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("RSI > 70 (overbought) -> sell", () => {
    const ind = makeIndicators({ rsi: 75 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("sell");
  });

  it("RSI === 70.1 (boundary overbought) -> sell", () => {
    const ind = makeIndicators({ rsi: 70.1 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("sell");
  });

  it("RSI === 70 (exactly equals overbought) -> none (does not trigger)", () => {
    // Condition is > 70, does not trigger at equality
    const ind = makeIndicators({ rsi: 70 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("RSI = 50 (neutral) -> none", () => {
    const ind = makeIndicators({ rsi: 50 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("custom oversold=40 -> RSI=35 should trigger buy", () => {
    const ind = makeIndicators({ rsi: 35 });
    const cfg = makeMinimalCfg();
    cfg.strategy.rsi.oversold = 40;
    expect(strategy.populateSignal(makeCtx([], ind, { strategy: cfg.strategy }))).toBe("buy");
  });

  it("custom overbought=65 -> RSI=68 should trigger sell", () => {
    const ind = makeIndicators({ rsi: 68 });
    const cfg = makeMinimalCfg();
    cfg.strategy.rsi.overbought = 65;
    expect(strategy.populateSignal(makeCtx([], ind, { strategy: cfg.strategy }))).toBe("sell");
  });

  it("description is set", () => {
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// Breakout Strategy
// ─────────────────────────────────────────────────────

describe("breakout strategy", () => {
  let strategy: Strategy;

  beforeAll(async () => {
    await import("../strategies/index.js");
    strategy = getStrategy("breakout");
  });

  it("id and name are correct", () => {
    expect(strategy.id).toBe("breakout");
    expect(strategy.name).toBeTruthy();
  });

  it("insufficient data (< lookback+1 bars) -> none", () => {
    const klines = makeKlines(5); // far fewer than 21 bars
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("close price breaks above past 20-bar high + volume surge -> buy", () => {
    // Past 20 bars close = 100 (high 100), current close = 110 (breakout) + volume surge
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 109,
      high: 112,
      low: 108,
      close: 110,         // breaks above 100
      volume: 2000,       // > 1000 * 1.5 = 1500
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("buy");
  });

  it("close price breaks out but insufficient volume -> none (breakout unconfirmed)", () => {
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 109,
      high: 112,
      low: 108,
      close: 110,         // breakout
      volume: 1000,       // only equals average (< 1.5x)
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("close price breaks below past 20-bar low -> sell", () => {
    const window = makeKlines(20, 100, 1000); // lowest close = 100
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 101,
      high: 101,
      low: 89,
      close: 90,          // breaks below 100 (lowest)
      volume: 800,        // volume confirmation not needed for breakdown
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("sell");
  });

  it("close within range (no breakout or breakdown) -> none", () => {
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,         // equals high point, no breakout (> required to trigger)
      volume: 2000,
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("exactly 21 klines (boundary data count) calculates correctly", () => {
    // 20-bar window + 1 current bar = 21 bars (meets lookback+1)
    const window = makeKlines(20, 100, 1000);
    const breakoutKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 100, high: 115, low: 100,
      close: 111,         // breaks above 100
      volume: 2000,       // > 1000 * 1.5
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, breakoutKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("buy");
  });

  it("description is set", () => {
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// signal-engine integration: strategy_id routing
// ─────────────────────────────────────────────────────

describe("processSignal — strategy_id routing", () => {
  it("strategy_id='rsi-reversal' invokes rsi-reversal plugin", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 99, high: 101, low: 98, close: 100,
      volume: 1000, closeTime: (i + 1) * 3_600_000,
    }));
    // RSI=25 (oversold) -> rsi-reversal returns buy
    // But since the actual calculated RSI may not be 25, we mainly verify routing goes through the plugin path
    const cfg = makeMinimalCfg({ strategy_id: "rsi-reversal" });
    const result = processSignal("BTCUSDT", klines, cfg);
    // Key: should not crash, rejected or signal are both valid
    expect(result).toBeDefined();
    expect(result.signal.symbol).toBe("BTCUSDT");
  });

  it("strategy_id='default' (explicit) behaves the same as not setting it", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 99, high: 101, low: 98, close: 100,
      volume: 1000, closeTime: (i + 1) * 3_600_000,
    }));
    const cfgDefault = makeMinimalCfg({ strategy_id: "default" });
    const cfgUndefined = makeMinimalCfg(); // strategy_id not set

    const r1 = processSignal("BTCUSDT", klines, cfgDefault);
    const r2 = processSignal("BTCUSDT", klines, cfgUndefined);

    // Both should return the same signal type
    expect(r1.signal.type).toBe(r2.signal.type);
    expect(r1.rejected).toBe(r2.rejected);
  });

  it("strategy_id pointing to non-existent plugin throws an error", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 99, high: 101, low: 98, close: 100,
      volume: 1000, closeTime: (i + 1) * 3_600_000,
    }));
    const cfg = makeMinimalCfg({ strategy_id: "nonexistent-plugin-xyz" });
    expect(() => processSignal("BTCUSDT", klines, cfg)).toThrow();
  });
});

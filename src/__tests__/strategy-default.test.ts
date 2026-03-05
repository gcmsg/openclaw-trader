/**
 * Default Strategy behavioral consistency tests (F4)
 *
 * Verifies the default strategy plugin behaves identically to the existing detectSignal().
 * For the same indicators + cfg, both should return the same SignalType.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import { getStrategy } from "../strategies/registry.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { Indicators, StrategyConfig } from "../types.js";

// Trigger registration
await import("../strategies/index.js");

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeMinimalCfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  const base: StrategyConfig = {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: {
      buy: ["ma_bullish", "rsi_oversold"],
      sell: ["ma_bearish"],
      short: ["ma_bearish", "rsi_overbought"],
      cover: ["ma_bullish"],
    },
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
  return base;
}

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 105,
    maLong: 100,
    rsi: 50,
    price: 100,
    volume: 1000,
    avgVolume: 800,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────

describe("Default Strategy — consistent with detectSignal", () => {
  let defaultStrategy: Strategy;

  beforeAll(async () => {
    await import("../strategies/index.js");
    defaultStrategy = getStrategy("default");
  });

  function compareSignals(
    ind: Indicators,
    cfg: StrategyConfig,
    posSide?: "long" | "short",
    label = ""
  ) {
    // detectSignal (original)
    const expected = detectSignal("BTCUSDT", ind, cfg, posSide).type;

    // default strategy plugin
    const ctx: StrategyContext = {
      klines: [],
      cfg,
      indicators: ind,
      ...(posSide !== undefined ? { currentPosSide: posSide } : {}),
    };
    const actual = defaultStrategy.populateSignal(ctx);

    expect(actual, `[${label}] signalType mismatch`).toBe(expected);
  }

  it("MA bullish + RSI oversold -> buy (no position)", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 });
    compareSignals(ind, makeMinimalCfg(), undefined, "ma_bullish + rsi_oversold");
  });

  it("MA bearish + holding long -> sell", () => {
    const ind = makeIndicators({ maShort: 95, maLong: 100, rsi: 55 });
    compareSignals(ind, makeMinimalCfg(), "long", "ma_bearish with long position");
  });

  it("MA bullish + holding short -> cover (close short)", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    compareSignals(ind, makeMinimalCfg(), "short", "ma_bullish cover");
  });

  it("no conditions met -> none", () => {
    // MA bullish but RSI not oversold -> buy conditions not met (both required)
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 55 });
    compareSignals(ind, makeMinimalCfg(), undefined, "no signal conditions met");
  });

  it("MA bearish + RSI overbought -> short (no position)", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 75 });
    compareSignals(ind, makeMinimalCfg(), undefined, "ma_bearish + rsi_overbought -> short");
  });

  it("holding long only checks sell, does not trigger buy/short", () => {
    // MA bullish + RSI oversold (could trigger buy), but holding long should only check sell
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 });
    const result = defaultStrategy.populateSignal({
      klines: [], cfg: makeMinimalCfg(), indicators: ind, currentPosSide: "long",
    });
    // sell condition is ma_bearish, MA bullish means ma_bearish = false -> none
    expect(result).toBe("none");
  });

  it("holding short only checks cover, does not trigger short/sell", () => {
    // MA bearish + RSI overbought (would trigger short), but holding short only checks cover
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 75 });
    const result = defaultStrategy.populateSignal({
      klines: [], cfg: makeMinimalCfg(), indicators: ind, currentPosSide: "short",
    });
    // cover condition is ma_bullish, MA bearish means = false -> none
    expect(result).toBe("none");
  });

  it("empty short/cover conditions returns none (no position + bearish conditions not met)", () => {
    const cfg = makeMinimalCfg({ signals: { buy: [], sell: [], short: [], cover: [] } });
    const ind = makeIndicators({ rsi: 25 });
    compareSignals(ind, cfg, undefined, "empty signals");
  });

  it("default strategy id and name are correct", () => {
    expect(defaultStrategy.id).toBe("default");
    expect(defaultStrategy.name).toBeTruthy();
  });

  it("default strategy has a description", () => {
    expect(defaultStrategy.description).toBeDefined();
    expect(defaultStrategy.description!.length).toBeGreaterThan(0);
  });
});

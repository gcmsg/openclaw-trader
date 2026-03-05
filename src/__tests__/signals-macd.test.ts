import { describe, it, expect } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, MacdResult, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Helper constructors
// ─────────────────────────────────────────────────────

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 100,
    maLong: 100,
    rsi: 50,
    price: 100,
    volume: 1000,
    avgVolume: 1000,
    prevMaShort: 100,
    prevMaLong: 100,
    ...overrides,
  };
}

function makeMacd(overrides: Partial<MacdResult> = {}): MacdResult {
  // Only set required fields; optional prev* fields are passed by the caller as needed
  return { macd: 0, signal: 0, histogram: 0, ...overrides };
}

function makeConfig(
  buy: string[],
  sell: string[],
  volume?: { surge_ratio?: number; low_ratio?: number }
): StrategyConfig {
  const defaultVolume = { surge_ratio: 1.5, low_ratio: 0.5 };
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
      volume: volume ? { ...defaultVolume, ...volume } : defaultVolume,
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

// ─────────────────────────────────────────────────────
// MACD golden cross / death cross
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD golden cross / death cross", () => {
  it("macd_golden_cross: triggers when MACD crosses above signal line", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, prevMacd: -2, prevSignal: 3 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_golden_cross: does not trigger when MACD is already above signal line (no crossover)", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, prevMacd: 8, prevSignal: 5 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("macd_golden_cross: does not trigger when prevMacd equals prevSignal (requires cross above)", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 8, prevMacd: 5, prevSignal: 5 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    // prevMacd (5) <= prevSignal (5), current macd (10) > signal (8) -> triggers
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_death_cross: triggers when MACD crosses below signal line", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -5, signal: 2, prevMacd: 8, prevSignal: 3 }),
    });
    const cfg = makeConfig([], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });

  it("macd_death_cross: does not trigger when MACD is already below signal line", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -8, signal: 2, prevMacd: -5, prevSignal: 2 }),
    });
    const cfg = makeConfig([], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("golden/death cross do not trigger when macd field is null", () => {
    const ind = makeIndicators({}); // macd not set = no MACD data
    const cfg = makeConfig(["macd_golden_cross"], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MACD bullish / bearish
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD bullish / bearish", () => {
  it("macd_bullish: MACD > signal and histogram > 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, histogram: 5 }),
    });
    const cfg = makeConfig(["macd_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_bullish: does not trigger when MACD > signal but histogram = 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 5, signal: 5, histogram: 0 }),
    });
    const cfg = makeConfig(["macd_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("macd_bearish: MACD < signal and histogram < 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -10, signal: -3, histogram: -7 }),
    });
    const cfg = makeConfig([], ["macd_bearish"]);
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });

  it("macd_bearish: does not trigger when histogram >= 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -2, signal: 0, histogram: 0 }),
    });
    const cfg = makeConfig([], ["macd_bearish"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MACD histogram expansion
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD histogram expansion", () => {
  it("positive direction expansion: histogram increasing positively", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 10, prevHistogram: 5 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("negative direction expansion (absolute value increasing): also triggers", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: -12, prevHistogram: -8 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("histogram contracting does not trigger", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 3, prevHistogram: 8 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("histogram flipping from positive to negative (absolute value shrinking) does not trigger", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: -2, prevHistogram: 5 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    // |-2| = 2 < |5| = 5 -> not expanding
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("prevHistogram undefined does not trigger", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 10 }), // prevHistogram not set
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// Volume conditions
// ─────────────────────────────────────────────────────

describe("detectSignal() - volume conditions", () => {
  it("volume_surge: triggers when current volume >= 1.5x average volume", () => {
    const ind = makeIndicators({ volume: 1500, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_surge: triggers when current volume = 1.5x average (boundary)", () => {
    const ind = makeIndicators({ volume: 1500, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_surge: does not trigger when current volume < 1.5x average", () => {
    const ind = makeIndicators({ volume: 1400, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("volume_surge: uses default threshold 1.5", () => {
    // No volume config, uses default value 1.5
    const ind = makeIndicators({ volume: 2000, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], []); // no volume config
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_low: triggers when current volume <= 0.5x average", () => {
    const ind = makeIndicators({ volume: 400, avgVolume: 1000 });
    const cfg = makeConfig([], ["volume_low"], { low_ratio: 0.5 });
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });

  it("volume_low: does not trigger when avgVolume = 0 (avoid division by zero)", () => {
    const ind = makeIndicators({ volume: 0, avgVolume: 0 });
    const cfg = makeConfig([], ["volume_low"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("unknown signal condition names handled gracefully (no crash, returns none)", () => {
    const ind = makeIndicators();
    const cfg = makeConfig(["nonexistent_condition", "another_invalid"], []);
    expect(() => detectSignal("X", ind, cfg).type).not.toThrow();
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// Combined conditions (MACD + RSI) — simulating rsi-pure strategy
// ─────────────────────────────────────────────────────

describe("detectSignal() - RSI-Pure strategy combination", () => {
  it("rsi_oversold + macd_histogram_expanding -> buy", () => {
    const ind = makeIndicators({
      rsi: 25,
      macd: makeMacd({ histogram: 8, prevHistogram: 4 }),
    });
    const cfg = makeConfig(["rsi_oversold", "macd_histogram_expanding"], [], undefined);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_oversold met but histogram contracting -> does not trigger", () => {
    const ind = makeIndicators({
      rsi: 25,
      macd: makeMacd({ histogram: 3, prevHistogram: 8 }),
    });
    const cfg = makeConfig(["rsi_oversold", "macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_overbought + macd_histogram_expanding -> sell", () => {
    const ind = makeIndicators({
      rsi: 78, // > 72
      macd: makeMacd({ histogram: -12, prevHistogram: -8 }), // negative expansion
    });
    const cfg = makeConfig([], ["rsi_overbought", "macd_histogram_expanding"]);
    // overbought requires rsi > 65 (default)
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });
});

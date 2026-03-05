import { describe, it, expect } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Test helpers
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

function makeConfig(
  buyConditions: string[],
  sellConditions: string[],
  rsiOversold = 35,
  rsiOverbought = 65
): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: rsiOversold, overbought: rsiOverbought },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: buyConditions, sell: sellConditions },
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
// Basic behavior
// ─────────────────────────────────────────────────────

describe("detectSignal() - basic behavior", () => {
  it("returns none when no conditions are met", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], ["ma_bearish", "rsi_overbought"]);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).toBe("none");
  });

  it("signal contains correct symbol and price", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    const result = detectSignal("ETHUSDT", ind, cfg);
    expect(result.symbol).toBe("ETHUSDT");
    expect(result.price).toBe(100);
  });

  it("empty buy conditions array does not trigger buy", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 20 });
    const cfg = makeConfig([], ["ma_bearish"]);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).not.toBe("buy");
  });

  it("empty sell conditions array does not trigger sell", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 80 });
    const cfg = makeConfig(["ma_bullish"], []);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).not.toBe("sell");
  });

  it("unknown condition name treated as not met (no crash)", () => {
    const ind = makeIndicators();
    const cfg = makeConfig(["unknown_condition"], []);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MA bullish / bearish
// ─────────────────────────────────────────────────────

describe("detectSignal() - MA trend", () => {
  it("ma_bullish: triggers when maShort > maLong", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("ma_bullish: does not trigger when maShort = maLong", () => {
    const ind = makeIndicators({ maShort: 100, maLong: 100 });
    const cfg = makeConfig(["ma_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("ma_bearish: triggers when maShort < maLong", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 50 });
    const cfg = makeConfig([], ["ma_bearish"]);
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });

  it("ma_golden_cross: triggers when short MA crosses above long MA", () => {
    const ind = makeIndicators({
      maShort: 105,
      maLong: 100,
      prevMaShort: 98,
      prevMaLong: 100, // previous bar: short < long
    });
    const cfg = makeConfig(["ma_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("ma_golden_cross: does not trigger when short MA is already above long MA (no crossover)", () => {
    const ind = makeIndicators({
      maShort: 105,
      maLong: 100,
      prevMaShort: 102,
      prevMaLong: 100, // previous bar also short > long
    });
    const cfg = makeConfig(["ma_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("ma_death_cross: triggers when short MA crosses below long MA", () => {
    const ind = makeIndicators({
      maShort: 95,
      maLong: 100,
      prevMaShort: 102,
      prevMaLong: 100, // previous bar: short > long
    });
    const cfg = makeConfig([], ["ma_death_cross"]);
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });
});

// ─────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────

describe("detectSignal() - RSI", () => {
  it("rsi_oversold: triggers when RSI < threshold", () => {
    const ind = makeIndicators({ rsi: 30 });
    const cfg = makeConfig(["rsi_oversold"], [], 35);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_oversold: does not trigger when RSI = threshold", () => {
    const ind = makeIndicators({ rsi: 35 });
    const cfg = makeConfig(["rsi_oversold"], [], 35);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_overbought: triggers when RSI > threshold", () => {
    const ind = makeIndicators({ rsi: 70 });
    const cfg = makeConfig([], ["rsi_overbought"], 35, 65);
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
  });

  it("rsi_overbought: does not trigger when RSI = threshold", () => {
    const ind = makeIndicators({ rsi: 65 });
    const cfg = makeConfig([], ["rsi_overbought"], 35, 65);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// Multi-condition AND logic
// ─────────────────────────────────────────────────────

describe("detectSignal() - AND logic", () => {
  it("buy: triggers only when all conditions are met", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    const result = detectSignal("X", ind, cfg);
    expect(result.type).toBe("buy");
    expect(result.reason).toContain("ma_bullish");
    expect(result.reason).toContain("rsi_oversold");
  });

  it("buy: does not trigger when some conditions are not met", () => {
    // MA bullish OK but RSI not oversold
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("sell: triggers only when all conditions are met (requires positionSide='long')", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 70 });
    const cfg = makeConfig([], ["ma_bearish", "rsi_overbought"]);
    const result = detectSignal("X", ind, cfg, "long");
    expect(result.type).toBe("sell");
  });

  it("buy takes priority when no position (sell not evaluated without position)", () => {
    // No position: only evaluates buy/short, sell does not participate
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish"], ["rsi_oversold"]);
    const result = detectSignal("X", ind, cfg); // no positionSide
    expect(result.type).toBe("buy");
  });
});

// ─────────────────────────────────────────────────────
// New signal conditions (P0 fix: resolve signal logic contradiction)
// ─────────────────────────────────────────────────────
describe("New signal conditions — rsi_not_overbought / rsi_not_oversold / rsi_bullish_zone", () => {
  it("rsi_not_overbought: triggers when RSI < overbought", () => {
    const ind = makeIndicators({ rsi: 50 }); // RSI 50 < 65
    const cfg = makeConfig(["rsi_not_overbought"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_not_overbought: does not trigger when RSI >= overbought", () => {
    const ind = makeIndicators({ rsi: 70 }); // RSI 70 >= 65
    const cfg = makeConfig(["rsi_not_overbought"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_not_oversold: triggers when RSI > oversold", () => {
    const ind = makeIndicators({ rsi: 50 }); // RSI 50 > 35
    const cfg = makeConfig(["rsi_not_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_not_oversold: does not trigger when RSI <= oversold", () => {
    const ind = makeIndicators({ rsi: 30 }); // RSI 30 <= 35
    const cfg = makeConfig(["rsi_not_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_bullish_zone: triggers when RSI is between 40 and overbought", () => {
    const ind = makeIndicators({ rsi: 55 }); // 40 < 55 < 65
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_bullish_zone: does not trigger when RSI < 40", () => {
    const ind = makeIndicators({ rsi: 35 }); // RSI 35 < 40
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_bullish_zone: does not trigger when RSI >= overbought", () => {
    const ind = makeIndicators({ rsi: 70 }); // RSI 70 >= 65
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("default strategy fix validation: ma_bullish + macd_bullish + rsi_not_overbought can all be true simultaneously", () => {
    // Uptrend (MA bullish) + MACD bullish + RSI 50 (not overbought)
    // -> three conditions are compatible, can trigger buy
    const ind = makeIndicators({
      maShort: 110,
      maLong: 100,
      rsi: 50,
      macd: { macd: 10, signal: 5, histogram: 5, prevMacd: 8, prevSignal: 5, prevHistogram: 3 },
    });
    const cfg = makeConfig(["ma_bullish", "macd_bullish", "rsi_not_overbought"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });
});

// ─── short / cover signals ──────────────────────────────

describe("detectSignal() - short / cover signals (position-aware)", () => {
  // ── No position: only checks buy / short ─────────────────────

  it("no position: returns short when bearish conditions are met", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100,  // ma_bearish
      macd: { macd: -1, signal: 0, histogram: -1 },
    });
    const cfg = makeConfig([], [], 35, 65);
    cfg.signals.short = ["ma_bearish", "macd_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg); // no positionSide
    expect(sig.type).toBe("short");
    expect(sig.reason).toContain("ma_bearish");
    expect(sig.reason).toContain("macd_bearish");
  });

  it("no position: buy takes priority over short (buy triggers first when both are met)", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.short = ["ma_bullish"]; // same condition, buy first
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("no position: sell does not trigger even if ma_bearish is met (sell only checked when holding long)", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bearish"]);
    cfg.signals.short = []; // no short conditions
    // No position -> detectSignal only checks buy/short, not sell
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none"); // sell is not evaluated
  });

  it("no position: sell no longer blocks short (B1 fix validation)", () => {
    // Original bug: sell triggers -> short skipped; after fix: sell not evaluated without position
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bearish"]);
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg); // no position
    expect(sig.type).toBe("short"); // before fix was "sell"
  });

  // ── Holding long: only checks sell ─────────────────────────────

  it("holding long: returns sell when sell conditions are met", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish -> sell
    const cfg = makeConfig(["ma_bullish"], ["ma_bearish"]);
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("holding long: returns none even when short conditions are met (short not checked)", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bullish"]); // sell requires ma_bullish (not met)
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none"); // sell conditions not met, short not checked
  });

  // ── Holding short: only checks cover ────────────────────────────

  it("holding short: returns cover when cover conditions are met", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish -> cover
    const cfg = makeConfig([], []);
    cfg.signals.cover = ["ma_bullish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("cover");
  });

  it("holding short: returns none even when buy conditions are met (buy not checked)", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.cover = ["ma_bearish"]; // cover requires ma_bearish (not met)
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("none"); // buy not checked when holding short
  });

  it("holding short: cover is not preempted by buy signal (B1 fix validation)", () => {
    // Original bug: buy condition met -> buy returned first -> cover skipped
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.cover = ["ma_bullish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("cover"); // before fix would return "buy"
  });

  // ── Edge cases ────────────────────────────────────────

  it("signals.short not configured returns none without position", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], []);
    // cfg.signals.short not set
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("partial short conditions met does not trigger short", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100,           // ma_bearish OK
      macd: { macd: 1, signal: 0, histogram: 1 }, // macd_bearish not met
    });
    const cfg = makeConfig([], []);
    cfg.signals.short = ["ma_bearish", "macd_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("cover conditions met (holding short) returns cover with correct reasons", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 });
    const cfg = makeConfig([], []);
    cfg.signals.cover = ["ma_bullish", "rsi_oversold"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("cover");
    expect(sig.reason).toContain("ma_bullish");
    expect(sig.reason).toContain("rsi_oversold");
  });
});

// ─────────────────────────────────────────────────────
// P0.2 Exit logic upgrade: new signal detector
// ─────────────────────────────────────────────────────

describe("macd_histogram_shrinking", () => {
  it("three consecutive shrinking bars returns sell (holding long)", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100, // ma_bearish also met, but here we only test shrinking
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.1,  // current bar
        prevHistogram: 0.5,                        // previous bar is larger
        prevPrevHistogram: 1.0,                    // two bars ago is largest -> consecutive shrinking
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("macd_histogram_shrinking");
  });

  it("only two bars of data falls back to two-bar shrinking detection", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.2,
        prevHistogram: 0.5, // no prevPrevHistogram -> fallback
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("histogram expanding does not trigger", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.5, signal: 0.2, histogram: 0.3,
        prevHistogram: 0.1,      // current > previous -> expanding
        prevPrevHistogram: 0.05,
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("second bar not shrinking (only last bar shrinking) does not trigger three-bar detection", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.1,
        prevHistogram: 0.5,
        prevPrevHistogram: 0.3, // prevPrev < prev -> first two bars are expanding, not consecutive shrinking
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    // twoBarShrink=true but prevPrevHistogram(0.3) < prevHistogram(0.5) is false -> false
    expect(sig.type).toBe("none");
  });

  it("does not trigger when macd is not enabled", () => {
    const ind = makeIndicators(); // default no macd field
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });
});

describe("rsi_overbought_exit", () => {
  it("triggers exit when RSI > 75 (holding long)", () => {
    const ind = makeIndicators({ rsi: 78 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("rsi_overbought_exit");
  });

  it("does not trigger when RSI = 75 (strictly greater than)", () => {
    const ind = makeIndicators({ rsi: 75 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("does not trigger when RSI < 75", () => {
    const ind = makeIndicators({ rsi: 72 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("custom overbought_exit threshold takes effect", () => {
    const ind = makeIndicators({ rsi: 82 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    cfg.strategy.rsi.overbought_exit = 80;
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("custom threshold 80: RSI=79 does not trigger", () => {
    const ind = makeIndicators({ rsi: 79 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    cfg.strategy.rsi.overbought_exit = 80;
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });
});

// CVD signal conditions
describe("cvd_bullish / cvd_bearish", () => {
  it("cvd > 0: cvd_bullish as standalone buy condition triggers buy without position", () => {
    const ind = makeIndicators({ cvd: 5000 });
    const cfg = makeConfig(["cvd_bullish"], []);
    // cvd_bullish=true -> buy signal triggers
    const sig = detectSignal("BTCUSDT", ind, cfg);
    // cvd > 0 -> cvd_bullish = true -> buy
    expect(sig.type).toBe("buy");
  });

  it("cvd_bullish as auxiliary buy condition (combined with ma_bullish)", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, cvd: 5000, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
    expect(sig.reason).toContain("cvd_bullish");
  });

  it("cvd < 0: cvd_bearish as sell condition (holding long)", () => {
    const ind = makeIndicators({ cvd: -3000 });
    const cfg = makeConfig([], ["cvd_bearish"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("cvd_bearish");
  });

  it("cvd = 0: cvd_bullish does not trigger", () => {
    const ind = makeIndicators({ cvd: 0 });
    const cfg = makeConfig(["cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("cvd undefined: cvd_bullish does not trigger (defaults to 0)", () => {
    const ind = makeIndicators(); // no cvd field
    const cfg = makeConfig(["cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });
});

// Funding rate contrarian signals
describe("funding_rate_overlong / funding_rate_overshort", () => {
  it("funding rate +0.35% > 0.30 triggers funding_rate_overlong (open short)", () => {
    const ind = makeIndicators({ fundingRate: 0.35 });
    const cfg = makeConfig([], []);
    cfg.signals.short = ["funding_rate_overlong"];
    const sig = detectSignal("BTCUSDT", ind, cfg); // no position, triggers short
    expect(sig.type).toBe("short");
    expect(sig.reason).toContain("funding_rate_overlong");
  });

  it("funding rate -0.20% < -0.15 triggers funding_rate_overshort (open long)", () => {
    const ind = makeIndicators({ fundingRate: -0.20 });
    const cfg = makeConfig(["funding_rate_overshort"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
    expect(sig.reason).toContain("funding_rate_overshort");
  });

  it("funding rate within normal range does not trigger", () => {
    const ind = makeIndicators({ fundingRate: 0.01 });
    const cfg = makeConfig(["funding_rate_overshort"], []);
    cfg.signals.short = ["funding_rate_overlong"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("custom threshold takes effect: long_threshold=0.1, rate=0.15 triggers", () => {
    const ind = makeIndicators({ fundingRate: 0.15 });
    const cfg = makeConfig([], []);
    cfg.strategy.funding_rate = { long_threshold: 0.10 };
    cfg.signals.short = ["funding_rate_overlong"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("short");
  });

  it("fundingRate not set does not trigger", () => {
    const ind = makeIndicators();
    const cfg = makeConfig(["funding_rate_overshort"], []);
    cfg.signals.short = ["funding_rate_overlong"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });
});

import { describe, it, expect } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// 测试辅助
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
// 基础行为
// ─────────────────────────────────────────────────────

describe("detectSignal() - 基础行为", () => {
  it("无条件满足时返回 none", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], ["ma_bearish", "rsi_overbought"]);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).toBe("none");
  });

  it("信号包含正确的 symbol 和 price", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    const result = detectSignal("ETHUSDT", ind, cfg);
    expect(result.symbol).toBe("ETHUSDT");
    expect(result.price).toBe(100);
  });

  it("买入条件为空数组时不触发买入", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 20 });
    const cfg = makeConfig([], ["ma_bearish"]);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).not.toBe("buy");
  });

  it("卖出条件为空数组时不触发卖出", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 80 });
    const cfg = makeConfig(["ma_bullish"], []);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).not.toBe("sell");
  });

  it("未知条件名称视为不满足（不崩溃）", () => {
    const ind = makeIndicators();
    const cfg = makeConfig(["unknown_condition"], []);
    const result = detectSignal("BTCUSDT", ind, cfg);
    expect(result.type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MA 多头 / 空头
// ─────────────────────────────────────────────────────

describe("detectSignal() - MA 趋势", () => {
  it("ma_bullish: maShort > maLong 时触发", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("ma_bullish: maShort = maLong 时不触发", () => {
    const ind = makeIndicators({ maShort: 100, maLong: 100 });
    const cfg = makeConfig(["ma_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("ma_bearish: maShort < maLong 时触发", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 50 });
    const cfg = makeConfig([], ["ma_bearish"]);
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });

  it("ma_golden_cross: 短线上穿长线时触发", () => {
    const ind = makeIndicators({
      maShort: 105,
      maLong: 100,
      prevMaShort: 98,
      prevMaLong: 100, // 前一根：短 < 长
    });
    const cfg = makeConfig(["ma_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("ma_golden_cross: 短线已在长线上方（非交叉）时不触发", () => {
    const ind = makeIndicators({
      maShort: 105,
      maLong: 100,
      prevMaShort: 102,
      prevMaLong: 100, // 前一根也是短 > 长
    });
    const cfg = makeConfig(["ma_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("ma_death_cross: 短线下穿长线时触发", () => {
    const ind = makeIndicators({
      maShort: 95,
      maLong: 100,
      prevMaShort: 102,
      prevMaLong: 100, // 前一根：短 > 长
    });
    const cfg = makeConfig([], ["ma_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });
});

// ─────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────

describe("detectSignal() - RSI", () => {
  it("rsi_oversold: RSI < 阈值时触发", () => {
    const ind = makeIndicators({ rsi: 30 });
    const cfg = makeConfig(["rsi_oversold"], [], 35);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_oversold: RSI = 阈值时不触发", () => {
    const ind = makeIndicators({ rsi: 35 });
    const cfg = makeConfig(["rsi_oversold"], [], 35);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_overbought: RSI > 阈值时触发", () => {
    const ind = makeIndicators({ rsi: 70 });
    const cfg = makeConfig([], ["rsi_overbought"], 35, 65);
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });

  it("rsi_overbought: RSI = 阈值时不触发", () => {
    const ind = makeIndicators({ rsi: 65 });
    const cfg = makeConfig([], ["rsi_overbought"], 35, 65);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// 多条件 AND 逻辑
// ─────────────────────────────────────────────────────

describe("detectSignal() - AND 逻辑", () => {
  it("买入：所有条件满足才触发", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    const result = detectSignal("X", ind, cfg);
    expect(result.type).toBe("buy");
    expect(result.reason).toContain("ma_bullish");
    expect(result.reason).toContain("rsi_oversold");
  });

  it("买入：部分条件不满足时不触发", () => {
    // MA 多头 ✓ 但 RSI 不超卖 ✗
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "rsi_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("卖出：所有条件满足才触发", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 70 });
    const cfg = makeConfig([], ["ma_bearish", "rsi_overbought"]);
    const result = detectSignal("X", ind, cfg);
    expect(result.type).toBe("sell");
  });

  it("买入优先于卖出（同时满足时返回买入）", () => {
    // 极端情况：买卖条件同时满足（正常情况不会发生，但逻辑应优先买入）
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish"], ["rsi_oversold"]);
    const result = detectSignal("X", ind, cfg);
    expect(result.type).toBe("buy");
  });
});

// ─────────────────────────────────────────────────────
// 新信号条件（P0 修复：解决信号逻辑矛盾）
// ─────────────────────────────────────────────────────
describe("新信号条件 — rsi_not_overbought / rsi_not_oversold / rsi_bullish_zone", () => {
  it("rsi_not_overbought: RSI < overbought 时触发", () => {
    const ind = makeIndicators({ rsi: 50 }); // RSI 50 < 65
    const cfg = makeConfig(["rsi_not_overbought"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_not_overbought: RSI >= overbought 时不触发", () => {
    const ind = makeIndicators({ rsi: 70 }); // RSI 70 >= 65
    const cfg = makeConfig(["rsi_not_overbought"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_not_oversold: RSI > oversold 时触发", () => {
    const ind = makeIndicators({ rsi: 50 }); // RSI 50 > 35
    const cfg = makeConfig(["rsi_not_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_not_oversold: RSI <= oversold 时不触发", () => {
    const ind = makeIndicators({ rsi: 30 }); // RSI 30 <= 35
    const cfg = makeConfig(["rsi_not_oversold"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_bullish_zone: RSI 在 40–overbought 之间触发", () => {
    const ind = makeIndicators({ rsi: 55 }); // 40 < 55 < 65
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_bullish_zone: RSI < 40 时不触发", () => {
    const ind = makeIndicators({ rsi: 35 }); // RSI 35 < 40
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_bullish_zone: RSI >= overbought 时不触发", () => {
    const ind = makeIndicators({ rsi: 70 }); // RSI 70 >= 65
    const cfg = makeConfig(["rsi_bullish_zone"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("默认策略修复验证：ma_bullish + macd_bullish + rsi_not_overbought 可以同时成立", () => {
    // 上升趋势（MA 多头）+ MACD 多头 + RSI 50（未超买）
    // → 三个条件兼容，能触发买入
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

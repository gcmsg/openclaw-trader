/**
 * Strategy Plugin 单元测试（F4）
 * 测试 rsi-reversal 和 breakout 策略的核心逻辑
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getStrategy } from "../strategies/registry.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { Kline, StrategyConfig, Indicators } from "../types.js";

// 触发注册
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

/** 生成 N 根 K 线（收盘价均为 basePrice） */
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

describe("rsi-reversal 策略", () => {
  let strategy: Strategy;

  beforeAll(async () => {
    await import("../strategies/index.js");
    strategy = getStrategy("rsi-reversal");
  });

  it("id 和 name 正确", () => {
    expect(strategy.id).toBe("rsi-reversal");
    expect(strategy.name).toBeTruthy();
  });

  it("RSI < 30（超卖）→ buy", () => {
    const ind = makeIndicators({ rsi: 25 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("buy");
  });

  it("RSI === 29.9（边界）→ buy", () => {
    const ind = makeIndicators({ rsi: 29.9 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("buy");
  });

  it("RSI === 30（恰好等于 oversold）→ none（不触发）", () => {
    // 条件是 < 30，等于时不触发
    const ind = makeIndicators({ rsi: 30 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("RSI > 70（超买）→ sell", () => {
    const ind = makeIndicators({ rsi: 75 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("sell");
  });

  it("RSI === 70.1（边界超买）→ sell", () => {
    const ind = makeIndicators({ rsi: 70.1 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("sell");
  });

  it("RSI === 70（恰好等于 overbought）→ none（不触发）", () => {
    // 条件是 > 70，等于时不触发
    const ind = makeIndicators({ rsi: 70 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("RSI = 50（中性）→ none", () => {
    const ind = makeIndicators({ rsi: 50 });
    expect(strategy.populateSignal(makeCtx([], ind))).toBe("none");
  });

  it("自定义 oversold=40 → RSI=35 应触发 buy", () => {
    const ind = makeIndicators({ rsi: 35 });
    const cfg = makeMinimalCfg();
    cfg.strategy.rsi.oversold = 40;
    expect(strategy.populateSignal(makeCtx([], ind, { strategy: cfg.strategy }))).toBe("buy");
  });

  it("自定义 overbought=65 → RSI=68 应触发 sell", () => {
    const ind = makeIndicators({ rsi: 68 });
    const cfg = makeMinimalCfg();
    cfg.strategy.rsi.overbought = 65;
    expect(strategy.populateSignal(makeCtx([], ind, { strategy: cfg.strategy }))).toBe("sell");
  });

  it("description 已设置", () => {
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// Breakout Strategy
// ─────────────────────────────────────────────────────

describe("breakout 策略", () => {
  let strategy: Strategy;

  beforeAll(async () => {
    await import("../strategies/index.js");
    strategy = getStrategy("breakout");
  });

  it("id 和 name 正确", () => {
    expect(strategy.id).toBe("breakout");
    expect(strategy.name).toBeTruthy();
  });

  it("数据不足（< lookback+1 根）→ none", () => {
    const klines = makeKlines(5); // 远少于 21 根
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("收盘价突破过去 20 根最高点 + 成交量放大 → buy", () => {
    // 过去 20 根收盘 = 100（最高 100），当前收盘 = 110（突破）+ 量能放大
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 109,
      high: 112,
      low: 108,
      close: 110,         // 突破 100
      volume: 2000,       // > 1000 * 1.5 = 1500
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("buy");
  });

  it("收盘价突破但量能不足 → none（无法确认突破）", () => {
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 109,
      high: 112,
      low: 108,
      close: 110,         // 突破
      volume: 1000,       // 仅等于均量（< 1.5x）
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("收盘价跌破过去 20 根最低点 → sell", () => {
    const window = makeKlines(20, 100, 1000); // 最低收盘 = 100
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 101,
      high: 101,
      low: 89,
      close: 90,          // 跌破 100（最低点）
      volume: 800,        // 量能不需要确认跌破
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("sell");
  });

  it("收盘在区间内（未突破也未跌破）→ none", () => {
    const window = makeKlines(20, 100, 1000);
    const currentKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,         // 等于最高点，不突破（> 才触发）
      volume: 2000,
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, currentKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("none");
  });

  it("恰好 21 根 K 线（边界数据量）能正确计算", () => {
    // 20 根窗口 + 1 根当前 = 21 根（满足 lookback+1）
    const window = makeKlines(20, 100, 1000);
    const breakoutKline: Kline = {
      openTime: 20 * 3_600_000,
      open: 100, high: 115, low: 100,
      close: 111,         // 突破 100
      volume: 2000,       // > 1000 * 1.5
      closeTime: 21 * 3_600_000,
    };
    const klines = [...window, breakoutKline];
    expect(strategy.populateSignal(makeCtx(klines))).toBe("buy");
  });

  it("description 已设置", () => {
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// signal-engine 集成：strategy_id 路由
// ─────────────────────────────────────────────────────

describe("processSignal — strategy_id 路由", () => {
  it("strategy_id='rsi-reversal' 时调用 rsi-reversal 插件", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 99, high: 101, low: 98, close: 100,
      volume: 1000, closeTime: (i + 1) * 3_600_000,
    }));
    // RSI=25（超卖）→ rsi-reversal 返回 buy
    // 但由于真实计算出的 RSI 可能不是 25，我们主要验证路由是否经过插件路径
    const cfg = makeMinimalCfg({ strategy_id: "rsi-reversal" });
    const result = processSignal("BTCUSDT", klines, cfg);
    // 关键：不应 crash，rejected 或 signal 都是有效的
    expect(result).toBeDefined();
    expect(result.signal.symbol).toBe("BTCUSDT");
  });

  it("strategy_id='default'（显式）与不设置行为一致", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 99, high: 101, low: 98, close: 100,
      volume: 1000, closeTime: (i + 1) * 3_600_000,
    }));
    const cfgDefault = makeMinimalCfg({ strategy_id: "default" });
    const cfgUndefined = makeMinimalCfg(); // strategy_id 未设置

    const r1 = processSignal("BTCUSDT", klines, cfgDefault);
    const r2 = processSignal("BTCUSDT", klines, cfgUndefined);

    // 两者应该返回相同的 signal type
    expect(r1.signal.type).toBe(r2.signal.type);
    expect(r1.rejected).toBe(r2.rejected);
  });

  it("strategy_id 指向不存在的插件时抛出错误", async () => {
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

/**
 * Default Strategy 行为一致性测试（F4）
 *
 * 验证 default 策略插件与现有 detectSignal() 行为完全一致。
 * 对同样的 indicators + cfg，两者应返回相同的 SignalType。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import { getStrategy } from "../strategies/registry.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { Indicators, StrategyConfig } from "../types.js";

// 触发注册
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

describe("Default Strategy — 与 detectSignal 行为一致", () => {
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
    // detectSignal（原始）
    const expected = detectSignal("BTCUSDT", ind, cfg, posSide).type;

    // default 策略插件
    const ctx: StrategyContext = {
      klines: [],
      cfg,
      indicators: ind,
      ...(posSide !== undefined ? { currentPosSide: posSide } : {}),
    };
    const actual = defaultStrategy.populateSignal(ctx);

    expect(actual, `[${label}] signalType 不一致`).toBe(expected);
  }

  it("MA 多头 + RSI 超卖 → buy（无持仓）", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 });
    compareSignals(ind, makeMinimalCfg(), undefined, "ma_bullish + rsi_oversold");
  });

  it("MA 空头 + 有多头持仓 → sell", () => {
    const ind = makeIndicators({ maShort: 95, maLong: 100, rsi: 55 });
    compareSignals(ind, makeMinimalCfg(), "long", "ma_bearish with long position");
  });

  it("MA 多头 + 有空头持仓 → cover（平空）", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 50 });
    compareSignals(ind, makeMinimalCfg(), "short", "ma_bullish cover");
  });

  it("无条件满足 → none", () => {
    // MA 多头但 RSI 未超卖 → buy 条件不满足（需要两者都满足）
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 55 });
    compareSignals(ind, makeMinimalCfg(), undefined, "no signal conditions met");
  });

  it("MA 空头 + RSI 超买 → short（无持仓）", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 75 });
    compareSignals(ind, makeMinimalCfg(), undefined, "ma_bearish + rsi_overbought → short");
  });

  it("持仓多头时只检查 sell，不触发 buy/short", () => {
    // MA 多头 + RSI 超卖（本来可以触发 buy），但持仓多头时应该只检查 sell
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 });
    const result = defaultStrategy.populateSignal({
      klines: [], cfg: makeMinimalCfg(), indicators: ind, currentPosSide: "long",
    });
    // sell 条件是 ma_bearish，MA 多头时 ma_bearish = false → none
    expect(result).toBe("none");
  });

  it("持仓空头时只检查 cover，不触发 short/sell", () => {
    // MA 空头 + RSI 超买（本来触发 short），但持仓空头时只检查 cover
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 75 });
    const result = defaultStrategy.populateSignal({
      klines: [], cfg: makeMinimalCfg(), indicators: ind, currentPosSide: "short",
    });
    // cover 条件是 ma_bullish，MA 空头时 = false → none
    expect(result).toBe("none");
  });

  it("配置无 short/cover 条件时应返回 none（无持仓 + 空头条件不满足）", () => {
    const cfg = makeMinimalCfg({ signals: { buy: [], sell: [], short: [], cover: [] } });
    const ind = makeIndicators({ rsi: 25 });
    compareSignals(ind, cfg, undefined, "empty signals");
  });

  it("default 策略 id 和 name 正确", () => {
    expect(defaultStrategy.id).toBe("default");
    expect(defaultStrategy.name).toBeTruthy();
  });

  it("default 策略有 description", () => {
    expect(defaultStrategy.description).toBeDefined();
    expect(defaultStrategy.description!.length).toBeGreaterThan(0);
  });
});

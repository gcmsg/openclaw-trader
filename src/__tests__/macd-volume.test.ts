import { describe, it, expect } from "vitest";
import { macd, volumeRatio, calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// 测试辅助
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
    exchange: {
      name: "binance", credentials_path: ".secrets/binance.json", market: "spot",
      futures: { contract_type: "perpetual", margin_mode: "isolated" },
      leverage: { enabled: false, default: 1, max: 3 },
    },
    symbols: [],
    timeframe: "1h",
    strategy: {
      name: "test", enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
      volume: { surge_ratio: 1.5, low_ratio: 0.5 },
    },
    signals: { buy, sell },
    risk: {
      stop_loss_percent: 5, take_profit_percent: 10,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      max_total_loss_percent: 20, position_ratio: 0.2,
      max_positions: 4, max_position_per_symbol: 0.3, daily_loss_limit_percent: 8,
    },
    execution: { order_type: "market", limit_order_offset_percent: 0.1, min_order_usdt: 10, limit_order_timeout_seconds: 300 },
    notify: { on_signal: true, on_trade: true, on_stop_loss: true, on_take_profit: true, on_error: true, on_daily_summary: true, min_interval_minutes: 30 },
    paper: { initial_usdt: 1000, fee_rate: 0.001, slippage_percent: 0, report_interval_hours: 24 },
    news: { enabled: true, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    schedule: {},
    mode: "paper",
  };
}

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 100, maLong: 100, rsi: 50,
    price: 100, volume: 1000, avgVolume: 1000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// MACD 计算
// ─────────────────────────────────────────────────────

describe("macd()", () => {
  it("数据不足时返回 null", () => {
    expect(macd([1, 2, 3], 12, 26, 9)).toBeNull();
  });

  it("上涨趋势中 MACD > 信号线（多头）", () => {
    // 用加速上涨曲线（指数增长），使快线明显高于慢线
    const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.02, i));
    const result = macd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.macd).toBeGreaterThan(result!.signal);
    expect(result!.histogram).toBeGreaterThan(0);
  });

  it("下跌趋势中 histogram < 0", () => {
    // 先大幅上涨，再急速下跌 → MACD 由正转负，histogram 为负
    const up = Array.from({ length: 40 }, (_, i) => 100 + i * 5);
    const down = Array.from({ length: 20 }, (_, i) => 295 - i * 10);
    const closes = [...up, ...down];
    const result = macd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.histogram).toBeLessThan(0);
  });

  it("返回 prevMacd 和 prevSignal", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const result = macd(closes, 12, 26, 9);
    expect(result!.prevMacd).toBeDefined();
    expect(result!.prevSignal).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────
// 成交量比率
// ─────────────────────────────────────────────────────

describe("volumeRatio()", () => {
  it("数据不足时返回 NaN", () => {
    expect(volumeRatio([1000, 1000], 20)).toBeNaN();
  });

  it("当前成交量等于均量时比率为 1", () => {
    const vols = Array(21).fill(1000);
    expect(volumeRatio(vols, 20)).toBeCloseTo(1, 2);
  });

  it("当前成交量是均量 2 倍时比率为 2", () => {
    const vols = [...Array(20).fill(1000), 2000];
    expect(volumeRatio(vols, 20)).toBeCloseTo(2, 2);
  });

  it("均量基于前 N 根，不含当前 K 线", () => {
    // 前20根均量=1000，当前=5000，不应影响基准
    const vols = [...Array(20).fill(1000), 5000];
    const ratio = volumeRatio(vols, 20);
    expect(ratio).toBeCloseTo(5, 2);
  });
});

// ─────────────────────────────────────────────────────
// calculateIndicators 集成 MACD
// ─────────────────────────────────────────────────────

describe("calculateIndicators() with MACD", () => {
  it("启用 MACD 时返回 macd 字段", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14, {
      enabled: true, fast: 12, slow: 26, signal: 9,
    });
    expect(result?.macd).toBeDefined();
  });

  it("禁用 MACD 时不返回 macd 字段", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes);
    const result = calculateIndicators(klines, 20, 60, 14, {
      enabled: false, fast: 12, slow: 26, signal: 9,
    });
    expect(result?.macd).toBeUndefined();
  });

  it("成交量字段始终存在", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const klines = makeKlines(closes, Array(80).fill(2000));
    const result = calculateIndicators(klines, 20, 60, 14);
    expect(result?.volume).toBe(2000);
    expect(result?.avgVolume).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// MACD 信号检测
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD 信号", () => {
  it("macd_bullish: MACD > Signal 且柱状图 > 0 时触发买入", () => {
    const ind = makeIndicators({
      macd: { macd: 10, signal: 5, histogram: 5, prevMacd: 8, prevSignal: 6, prevHistogram: 2 },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_bullish"], [])).type).toBe("buy");
  });

  it("macd_bearish: MACD < Signal 且柱状图 < 0 时触发卖出", () => {
    const ind = makeIndicators({
      macd: { macd: -10, signal: -5, histogram: -5, prevMacd: -8, prevSignal: -6, prevHistogram: -2 },
    });
    expect(detectSignal("X", ind, makeConfig([], ["macd_bearish"])).type).toBe("sell");
  });

  it("macd_golden_cross: MACD 上穿信号线时触发", () => {
    const ind = makeIndicators({
      macd: { macd: 2, signal: 1, histogram: 1, prevMacd: -1, prevSignal: 0.5, prevHistogram: -1.5 },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_golden_cross"], [])).type).toBe("buy");
  });

  it("macd_golden_cross: 已在信号线上方时不触发", () => {
    const ind = makeIndicators({
      macd: { macd: 3, signal: 1, histogram: 2, prevMacd: 1.5, prevSignal: 1, prevHistogram: 0.5 },
    });
    expect(detectSignal("X", ind, makeConfig(["macd_golden_cross"], [])).type).toBe("none");
  });

  it("macd 字段为空时不触发 MACD 信号", () => {
    const ind = makeIndicators({ macd: undefined });
    expect(detectSignal("X", ind, makeConfig(["macd_bullish"], [])).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// 成交量信号检测
// ─────────────────────────────────────────────────────

describe("detectSignal() - 成交量信号", () => {
  it("volume_surge: 成交量超过阈值时触发", () => {
    const ind = makeIndicators({ volume: 2000, avgVolume: 1000 }); // 2x > 1.5x
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("buy");
  });

  it("volume_surge: 成交量未超阈值时不触发", () => {
    const ind = makeIndicators({ volume: 1200, avgVolume: 1000 }); // 1.2x < 1.5x
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("none");
  });

  it("volume_low: 成交量低于阈值时触发", () => {
    const ind = makeIndicators({ volume: 400, avgVolume: 1000 }); // 0.4x < 0.5x
    expect(detectSignal("X", ind, makeConfig(["volume_low"], [])).type).toBe("buy");
  });

  it("avgVolume 为 0 时不触发（防止除零）", () => {
    const ind = makeIndicators({ volume: 1000, avgVolume: 0 });
    expect(detectSignal("X", ind, makeConfig(["volume_surge"], [])).type).toBe("none");
  });
});

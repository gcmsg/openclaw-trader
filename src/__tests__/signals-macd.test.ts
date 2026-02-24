import { describe, it, expect } from "vitest";
import { detectSignal } from "../strategy/signals.js";
import type { Indicators, MacdResult, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// 辅助构造函数
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
  // 只设置必填字段，可选的 prev* 由调用方按需传入
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
// MACD 金叉 / 死叉
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD 金叉/死叉", () => {
  it("macd_golden_cross: MACD 上穿信号线时触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, prevMacd: -2, prevSignal: 3 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_golden_cross: MACD 已在信号线上方（非交叉）时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, prevMacd: 8, prevSignal: 5 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("macd_golden_cross: prevMacd 恰好等于 prevSignal 时不触发（需上穿）", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 8, prevMacd: 5, prevSignal: 5 }),
    });
    const cfg = makeConfig(["macd_golden_cross"], []);
    // prevMacd (5) <= prevSignal (5)，当前 macd (10) > signal (8) → 触发
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_death_cross: MACD 下穿信号线时触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -5, signal: 2, prevMacd: 8, prevSignal: 3 }),
    });
    const cfg = makeConfig([], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });

  it("macd_death_cross: MACD 已在信号线下方时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -8, signal: 2, prevMacd: -5, prevSignal: 2 }),
    });
    const cfg = makeConfig([], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("macd 字段为 null 时金叉/死叉不触发", () => {
    const ind = makeIndicators({}); // macd 不设置 = 无 MACD 数据; // 无 MACD 数据
    const cfg = makeConfig(["macd_golden_cross"], ["macd_death_cross"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MACD 多头 / 空头
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD 多头/空头", () => {
  it("macd_bullish: MACD > signal 且 histogram > 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 10, signal: 5, histogram: 5 }),
    });
    const cfg = makeConfig(["macd_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("macd_bullish: MACD > signal 但 histogram = 0 时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: 5, signal: 5, histogram: 0 }),
    });
    const cfg = makeConfig(["macd_bullish"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("macd_bearish: MACD < signal 且 histogram < 0", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -10, signal: -3, histogram: -7 }),
    });
    const cfg = makeConfig([], ["macd_bearish"]);
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });

  it("macd_bearish: histogram >= 0 时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ macd: -2, signal: 0, histogram: 0 }),
    });
    const cfg = makeConfig([], ["macd_bearish"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// MACD 柱状图扩张
// ─────────────────────────────────────────────────────

describe("detectSignal() - MACD histogram 扩张", () => {
  it("正方向扩张：histogram 正增大", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 10, prevHistogram: 5 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("负方向扩张（绝对值增大）：同样触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: -12, prevHistogram: -8 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("柱状图收缩时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 3, prevHistogram: 8 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("柱状图由正转负（绝对值缩小）时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: -2, prevHistogram: 5 }),
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    // |−2| = 2 < |5| = 5 → 不扩张
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("prevHistogram 未定义时不触发", () => {
    const ind = makeIndicators({
      macd: makeMacd({ histogram: 10 }), // prevHistogram 不设置,
    });
    const cfg = makeConfig(["macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// 成交量条件
// ─────────────────────────────────────────────────────

describe("detectSignal() - 成交量条件", () => {
  it("volume_surge: 当前量 >= 1.5x 均量时触发", () => {
    const ind = makeIndicators({ volume: 1500, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_surge: 当前量 = 1.5x 均量时触发（边界）", () => {
    const ind = makeIndicators({ volume: 1500, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_surge: 当前量 < 1.5x 均量时不触发", () => {
    const ind = makeIndicators({ volume: 1400, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], [], { surge_ratio: 1.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("volume_surge: 使用默认阈值 1.5", () => {
    // 没有 volume 配置，使用默认值 1.5
    const ind = makeIndicators({ volume: 2000, avgVolume: 1000 });
    const cfg = makeConfig(["volume_surge"], []); // no volume config
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("volume_low: 当前量 <= 0.5x 均量时触发", () => {
    const ind = makeIndicators({ volume: 400, avgVolume: 1000 });
    const cfg = makeConfig([], ["volume_low"], { low_ratio: 0.5 });
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });

  it("volume_low: avgVolume = 0 时不触发（避免除零）", () => {
    const ind = makeIndicators({ volume: 0, avgVolume: 0 });
    const cfg = makeConfig([], ["volume_low"]);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("未知信号条件名称被优雅处理（不崩溃，返回 none）", () => {
    const ind = makeIndicators();
    const cfg = makeConfig(["nonexistent_condition", "another_invalid"], []);
    expect(() => detectSignal("X", ind, cfg).type).not.toThrow();
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// 组合条件（MACD + RSI）— 模拟 rsi-pure 策略
// ─────────────────────────────────────────────────────

describe("detectSignal() - RSI-Pure 策略组合", () => {
  it("rsi_oversold + macd_histogram_expanding → 买入", () => {
    const ind = makeIndicators({
      rsi: 25,
      macd: makeMacd({ histogram: 8, prevHistogram: 4 }),
    });
    const cfg = makeConfig(["rsi_oversold", "macd_histogram_expanding"], [], undefined);
    expect(detectSignal("X", ind, cfg).type).toBe("buy");
  });

  it("rsi_oversold 满足但 histogram 收缩 → 不触发", () => {
    const ind = makeIndicators({
      rsi: 25,
      macd: makeMacd({ histogram: 3, prevHistogram: 8 }),
    });
    const cfg = makeConfig(["rsi_oversold", "macd_histogram_expanding"], []);
    expect(detectSignal("X", ind, cfg).type).toBe("none");
  });

  it("rsi_overbought + macd_histogram_expanding → 卖出", () => {
    const ind = makeIndicators({
      rsi: 78, // > 72
      macd: makeMacd({ histogram: -12, prevHistogram: -8 }), // 负向扩张
    });
    const cfg = makeConfig([], ["rsi_overbought", "macd_histogram_expanding"]);
    // overbought 需要 rsi > 65（默认）
    expect(detectSignal("X", ind, cfg).type).toBe("sell");
  });
});

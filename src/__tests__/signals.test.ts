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
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
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
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
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
    expect(detectSignal("X", ind, cfg, "long").type).toBe("sell");
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

  it("卖出：所有条件满足才触发（需 positionSide='long'）", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100, rsi: 70 });
    const cfg = makeConfig([], ["ma_bearish", "rsi_overbought"]);
    const result = detectSignal("X", ind, cfg, "long");
    expect(result.type).toBe("sell");
  });

  it("无持仓时 buy 优先（sell 不在无持仓时评估）", () => {
    // 无持仓：只评估 buy/short，sell 不参与
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 30 });
    const cfg = makeConfig(["ma_bullish"], ["rsi_oversold"]);
    const result = detectSignal("X", ind, cfg); // 无 positionSide
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

// ─── short / cover 信号 ──────────────────────────────

describe("detectSignal() - short / cover 信号（持仓感知）", () => {
  // ── 无持仓：只检查 buy / short ─────────────────────

  it("无持仓：空头条件满足时返回 short", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100,  // ma_bearish
      macd: { macd: -1, signal: 0, histogram: -1 },
    });
    const cfg = makeConfig([], [], 35, 65);
    cfg.signals.short = ["ma_bearish", "macd_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg); // 无 positionSide
    expect(sig.type).toBe("short");
    expect(sig.reason).toContain("ma_bearish");
    expect(sig.reason).toContain("macd_bearish");
  });

  it("无持仓：buy 优先于 short（同时满足时 buy 先触发）", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.short = ["ma_bullish"]; // 同条件，buy 先
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
  });

  it("无持仓：ma_bearish 满足时，若 sell 有条件配置仍不触发 sell（sell 只在持多时检查）", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bearish"]);
    cfg.signals.short = []; // 无 short 条件
    // 无持仓 → detectSignal 只检查 buy/short，不检查 sell
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none"); // sell 未被评估
  });

  it("无持仓：sell 不再屏蔽 short（B1 修复验证）", () => {
    // 原 bug：sell 触发 → short 被跳过；修复后：sell 不在无持仓时评估
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bearish"]);
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg); // 无持仓
    expect(sig.type).toBe("short"); // 修复前是 "sell"
  });

  // ── 持多头：只检查 sell ─────────────────────────────

  it("持多头：sell 条件满足时返回 sell", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish → sell
    const cfg = makeConfig(["ma_bullish"], ["ma_bearish"]);
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("持多头：即使 short 条件满足，也只返回 none（不检查 short）", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], ["ma_bullish"]); // sell 需 ma_bullish（未满足）
    cfg.signals.short = ["ma_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none"); // sell 条件未满足，short 不检查
  });

  // ── 持空头：只检查 cover ────────────────────────────

  it("持空头：cover 条件满足时返回 cover", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish → cover
    const cfg = makeConfig([], []);
    cfg.signals.cover = ["ma_bullish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("cover");
  });

  it("持空头：即使 buy 条件满足，也只返回 none（不检查 buy）", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.cover = ["ma_bearish"]; // cover 需 ma_bearish（未满足）
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("none"); // buy 不在持空时检查
  });

  it("持空头：cover 不被 buy 信号抢占（B1 修复验证）", () => {
    // 原 bug：buy 条件满足 → buy 先返回 → cover 被跳过
    const ind = makeIndicators({ maShort: 110, maLong: 100, rsi: 25 }); // ma_bullish
    const cfg = makeConfig(["ma_bullish"], []);
    cfg.signals.cover = ["ma_bullish"];
    const sig = detectSignal("BTCUSDT", ind, cfg, "short");
    expect(sig.type).toBe("cover"); // 修复前会返回 "buy"
  });

  // ── 边界情况 ────────────────────────────────────────

  it("signals.short 未配置时无持仓下返回 none", () => {
    const ind = makeIndicators({ maShort: 90, maLong: 100 }); // ma_bearish
    const cfg = makeConfig([], []);
    // cfg.signals.short 未设置
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("开空条件部分满足时不触发 short", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100,           // ma_bearish ✓
      macd: { macd: 1, signal: 0, histogram: 1 }, // macd_bearish ✗
    });
    const cfg = makeConfig([], []);
    cfg.signals.short = ["ma_bearish", "macd_bearish"];
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("平空条件满足（持空头）时返回 cover 并包含正确原因", () => {
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
// P0.2 出场逻辑升级：新信号检测器
// ─────────────────────────────────────────────────────

describe("macd_histogram_shrinking", () => {
  it("三根连续收缩时返回 sell（持多头）", () => {
    const ind = makeIndicators({
      maShort: 90, maLong: 100, // ma_bearish 也满足，但这里只测 shrinking
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.1,  // 当前柱
        prevHistogram: 0.5,                        // 前一根更大
        prevPrevHistogram: 1.0,                    // 前两根最大 → 连续收缩
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("macd_histogram_shrinking");
  });

  it("只有两根数据时退化为两根收缩检测", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.2,
        prevHistogram: 0.5, // 无 prevPrevHistogram → 退化
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("柱状图在扩张时不触发", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.5, signal: 0.2, histogram: 0.3,
        prevHistogram: 0.1,      // 当前 > 前一根 → 扩张
        prevPrevHistogram: 0.05,
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("第二根未收缩时（只有最后一根收缩）不触发三根检测", () => {
    const ind = makeIndicators({
      macd: {
        macd: 0.1, signal: 0.2, histogram: 0.1,
        prevHistogram: 0.5,
        prevPrevHistogram: 0.3, // prevPrev < prev → 前两根在扩张，不是连续收缩
      },
    });
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    // twoBarShrink=true but prevPrevHistogram(0.3) < prevHistogram(0.5) is false → false
    expect(sig.type).toBe("none");
  });

  it("macd 未启用时不触发", () => {
    const ind = makeIndicators(); // 默认无 macd 字段
    const cfg = makeConfig([], ["macd_histogram_shrinking"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });
});

describe("rsi_overbought_exit", () => {
  it("RSI > 75 时触发出场（持多头）", () => {
    const ind = makeIndicators({ rsi: 78 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("rsi_overbought_exit");
  });

  it("RSI = 75 时不触发（严格大于）", () => {
    const ind = makeIndicators({ rsi: 75 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("RSI < 75 时不触发", () => {
    const ind = makeIndicators({ rsi: 72 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });

  it("自定义 overbought_exit 阈值生效", () => {
    const ind = makeIndicators({ rsi: 82 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    cfg.strategy.rsi.overbought_exit = 80;
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
  });

  it("自定义阈值 80：RSI=79 不触发", () => {
    const ind = makeIndicators({ rsi: 79 });
    const cfg = makeConfig([], ["rsi_overbought_exit"]);
    cfg.strategy.rsi.overbought_exit = 80;
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("none");
  });
});

// CVD 信号条件
describe("cvd_bullish / cvd_bearish", () => {
  it("cvd > 0 时 cvd_bullish 单独作为 buy 条件，无持仓触发 buy", () => {
    const ind = makeIndicators({ cvd: 5000 });
    const cfg = makeConfig(["cvd_bullish"], []);
    // cvd_bullish=true → buy 信号触发
    const sig = detectSignal("BTCUSDT", ind, cfg);
    // cvd > 0 → cvd_bullish = true → buy
    expect(sig.type).toBe("buy");
  });

  it("cvd_bullish 作为买入辅助条件（和 ma_bullish 组合）", () => {
    const ind = makeIndicators({ maShort: 110, maLong: 100, cvd: 5000, rsi: 50 });
    const cfg = makeConfig(["ma_bullish", "cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("buy");
    expect(sig.reason).toContain("cvd_bullish");
  });

  it("cvd < 0 时 cvd_bearish 作为卖出条件（持多头）", () => {
    const ind = makeIndicators({ cvd: -3000 });
    const cfg = makeConfig([], ["cvd_bearish"]);
    const sig = detectSignal("BTCUSDT", ind, cfg, "long");
    expect(sig.type).toBe("sell");
    expect(sig.reason).toContain("cvd_bearish");
  });

  it("cvd = 0 时 cvd_bullish 不触发", () => {
    const ind = makeIndicators({ cvd: 0 });
    const cfg = makeConfig(["cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });

  it("cvd 未定义时 cvd_bullish 不触发（默认 0）", () => {
    const ind = makeIndicators(); // 无 cvd 字段
    const cfg = makeConfig(["cvd_bullish"], []);
    const sig = detectSignal("BTCUSDT", ind, cfg);
    expect(sig.type).toBe("none");
  });
});

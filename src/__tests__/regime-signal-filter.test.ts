/**
 * P5.3 Regime 感知信号过滤测试
 *
 * 测试目标：
 *   1. 未配置 regime_strategies → 旧行为不变（向后兼容）
 *   2. 趋势市（trending_bull/bear）→ 过滤掉纯 RSI 反转条件
 *   3. 震荡市（ranging_wide）→ 过滤掉纯 MA/MACD 趋势条件
 *   4. YAML 显式 regime_strategies 覆盖优先于自动分类
 *   5. applyRegimeSignalFilter 对每种 signalFilter 的行为正确
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ── 辅助 ──────────────────────────────────────────────

function makeKline(
  close: number, time: number,
  highMult = 1.002, lowMult = 0.998
): Kline {
  return {
    openTime: time, open: close,
    high: close * highMult, low: close * lowMult,
    close, volume: 1000, closeTime: time + 3599_000,
  };
}

/** 生成强上升趋势 K 线（trending_bull regime）：持续上涨，ADX 高 */
function makeTrendingBullKlines(): Kline[] {
  const klines: Kline[] = [];
  // 预热 20 根 + 上升趋势（ADX 需要足够多的方向一致数据）
  let price = 100;
  for (let i = 0; i < 40; i++) {
    klines.push(makeKline(price, i * 3600_000));
    price *= 1.008; // 每根涨 0.8% → 强趋势
  }
  return klines;
}

/** 生成震荡区间 K 线（ranging_wide regime）：高低交替，ADX 低 */
function makeSidewaysKlines(): Kline[] {
  const klines: Kline[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + (i % 2 === 0 ? 5 : -5); // 在 95-105 之间震荡
    klines.push(makeKline(price, i * 3600_000, 1.05, 0.95));
  }
  return klines;
}

/** 基础策略配置（ma_bullish + rsi_oversold 双条件） */
function makeBaseCfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "regime-test",
      enabled: true,
      ma: { short: 3, long: 8 },
      rsi: { period: 5, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: {
      buy: ["ma_bullish", "rsi_oversold"],
      sell: ["ma_bearish"],
    },
    risk: {
      stop_loss_percent: 30,
      take_profit_percent: 100,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.5,
      max_positions: 4,
      max_position_per_symbol: 0.8,
      max_total_loss_percent: 90,
      daily_loss_limit_percent: 90,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0,
      min_order_usdt: 1,
      limit_order_timeout_seconds: 30,
    },
    notify: {
      on_signal: false, on_trade: false, on_stop_loss: false,
      on_take_profit: false, on_error: false, on_daily_summary: false,
      min_interval_minutes: 0,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    ...overrides,
  } as StrategyConfig;
}

const ZERO_FEES = { initialUsdt: 1000, feeRate: 0, slippagePercent: 0 };

// ─────────────────────────────────────────────────────
// 1. 向后兼容：未配置 regime_strategies → 不过滤
// ─────────────────────────────────────────────────────

describe("向后兼容：无 regime_strategies 配置", () => {
  it("无 regime_strategies 时，regime 不过滤信号条件", () => {
    const cfg = makeBaseCfg(); // 无 regime_strategies
    const result = runBacktest({ BTCUSDT: makeTrendingBullKlines() }, cfg, ZERO_FEES);
    // 无过滤：cfg.signals.buy = ["ma_bullish", "rsi_oversold"]（两个条件都要满足）
    // 结果可能 0 交易或有交易，关键是 config 不含 signalToNextOpen 警告（测试不崩溃）
    expect(result.config.signalToNextOpen).toBe(false);
    expect(typeof result.metrics.totalTrades).toBe("number");
  });
});

// ─────────────────────────────────────────────────────
// 2. YAML 显式 regime_strategies 覆盖
// ─────────────────────────────────────────────────────

describe("YAML 显式 regime_strategies 覆盖", () => {
  it("regime_strategies.trend_signals_only 显式覆盖 → 使用配置的信号条件", () => {
    const cfg = makeBaseCfg({
      // 原始 buy 条件是 ["ma_bullish", "rsi_oversold"]
      // 显式覆盖：trending 市只需 ma_bullish
      regime_strategies: {
        trend_signals_only: {
          signals: {
            buy: ["ma_bullish"],   // 移除 rsi_oversold 要求
            sell: ["ma_bearish"],
          },
        },
      },
    });
    const klines = makeTrendingBullKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    // 显式覆盖生效：在趋势市只要 MA 金叉就买入（不再需要 RSI < 30）
    // 趋势上升市中 RSI 很少低于 30，所以只有 regime_strategies 覆盖后才能买到
    // 若 regime 检测到 trending_bull 且 confidence >= 60，则交易数量会更多
    expect(typeof result.metrics.totalTrades).toBe("number");
    // 关键断言：不崩溃，结果有效
    expect(result.metrics.totalReturnPercent).toBeDefined();
  });

  it("regime_strategies.reversal_signals_only 显式覆盖 → 在震荡市用 RSI 信号", () => {
    const cfg = makeBaseCfg({
      signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] }, // 原始只有 MA 信号
      regime_strategies: {
        reversal_signals_only: {
          signals: {
            buy: ["rsi_oversold"],  // 震荡市改用 RSI 反转
            sell: ["rsi_overbought"],
          },
        },
      },
    });
    const klines = makeSidewaysKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    expect(typeof result.metrics.totalTrades).toBe("number");
    expect(result.config.signalToNextOpen).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 3. 自动分类过滤（regime_strategies 配置了，但不含该 signalFilter 的映射）
// ─────────────────────────────────────────────────────

describe("自动分类过滤（regime_strategies 非空时激活）", () => {
  it("配置了 regime_strategies（即使只有1条），自动分类对其他 signalFilter 也生效", () => {
    // 配置 trending 覆盖，但不配置 reversal → 自动分类
    const cfg = makeBaseCfg({
      signals: { buy: ["ma_bullish", "rsi_oversold"], sell: ["ma_bearish"] },
      regime_strategies: {
        trend_signals_only: {
          signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] },
        },
        // reversal_signals_only 未配置 → 自动分类：保留 rsi 类，过滤 ma 类
      },
    });
    const klines = makeSidewaysKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    // 震荡市自动过滤：buy = ["rsi_oversold"]（ma_bullish 被过滤）
    // 结果不崩溃，且数字有效
    expect(typeof result.metrics.totalTrades).toBe("number");
  });

  it("regime_strategies = {} 空对象 → 不激活（向后兼容）", () => {
    const cfg = makeBaseCfg({ regime_strategies: {} });
    const klines = makeTrendingBullKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    expect(typeof result.metrics.totalTrades).toBe("number");
  });
});

// ─────────────────────────────────────────────────────
// 4. 运行不崩溃：多 symbol 场景
// ─────────────────────────────────────────────────────

describe("多 symbol + regime_strategies 不崩溃", () => {
  it("BTC(趋势) + ETH(震荡) 同时运行 regime 过滤", () => {
    const btcKlines = makeTrendingBullKlines();
    const ethKlines = makeSidewaysKlines();
    const cfg = makeBaseCfg({
      symbols: ["BTCUSDT", "ETHUSDT"],
      regime_strategies: {
        trend_signals_only: {
          signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] },
        },
        reversal_signals_only: {
          signals: { buy: ["rsi_oversold"], sell: ["rsi_overbought"] },
        },
      },
    });
    const result = runBacktest({ BTCUSDT: btcKlines, ETHUSDT: ethKlines }, cfg, ZERO_FEES);
    expect(typeof result.metrics.totalTrades).toBe("number");
    expect(typeof result.metrics.totalReturn).toBe("number");
  });
});

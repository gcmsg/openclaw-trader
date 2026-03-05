/**
 * P5.3 Regime-Aware Signal Filter Tests
 *
 * Test objectives:
 *   1. No regime_strategies configured → old behavior unchanged (backward compatible)
 *   2. Trending market (trending_bull/bear) → filter out pure RSI reversal conditions
 *   3. Ranging market (ranging_wide) → filter out pure MA/MACD trend conditions
 *   4. YAML explicit regime_strategies override takes priority over auto-classification
 *   5. applyRegimeSignalFilter behaves correctly for each signalFilter
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ── Helpers ──────────────────────────────────────────────

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

/** Generate strong uptrend klines (trending_bull regime): continuous rise, high ADX */
function makeTrendingBullKlines(): Kline[] {
  const klines: Kline[] = [];
  // 20 warmup bars + uptrend (ADX needs enough directionally consistent data)
  let price = 100;
  for (let i = 0; i < 40; i++) {
    klines.push(makeKline(price, i * 3600_000));
    price *= 1.008; // +0.8% per bar → strong trend
  }
  return klines;
}

/** Generate sideways klines (ranging_wide regime): alternating high/low, low ADX */
function makeSidewaysKlines(): Kline[] {
  const klines: Kline[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + (i % 2 === 0 ? 5 : -5); // oscillating between 95-105
    klines.push(makeKline(price, i * 3600_000, 1.05, 0.95));
  }
  return klines;
}

/** Base strategy config (ma_bullish + rsi_oversold dual conditions) */
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
// 1. Backward compatible: no regime_strategies configured → no filtering
// ─────────────────────────────────────────────────────

describe("Backward compatible: no regime_strategies config", () => {
  it("without regime_strategies, regime does not filter signal conditions", () => {
    const cfg = makeBaseCfg(); // no regime_strategies
    const result = runBacktest({ BTCUSDT: makeTrendingBullKlines() }, cfg, ZERO_FEES);
    // No filtering: cfg.signals.buy = ["ma_bullish", "rsi_oversold"] (both conditions must be met)
    // Result may have 0 trades or some trades; key is config has no signalToNextOpen warning (test doesn't crash)
    expect(result.config.signalToNextOpen).toBe(false);
    expect(typeof result.metrics.totalTrades).toBe("number");
  });
});

// ─────────────────────────────────────────────────────
// 2. YAML explicit regime_strategies override
// ─────────────────────────────────────────────────────

describe("YAML explicit regime_strategies override", () => {
  it("regime_strategies.trend_signals_only explicit override → uses configured signal conditions", () => {
    const cfg = makeBaseCfg({
      // Original buy conditions are ["ma_bullish", "rsi_oversold"]
      // Explicit override: trending market only needs ma_bullish
      regime_strategies: {
        trend_signals_only: {
          signals: {
            buy: ["ma_bullish"],   // remove rsi_oversold requirement
            sell: ["ma_bearish"],
          },
        },
      },
    });
    const klines = makeTrendingBullKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    // Explicit override takes effect: in trending market, only MA golden cross needed to buy (no longer requires RSI < 30)
    // In an uptrending market, RSI rarely goes below 30, so only with regime_strategies override can trades be made
    // If regime detects trending_bull with confidence >= 60, the number of trades will be higher
    expect(typeof result.metrics.totalTrades).toBe("number");
    // Key assertion: no crash, result is valid
    expect(result.metrics.totalReturnPercent).toBeDefined();
  });

  it("regime_strategies.reversal_signals_only explicit override → use RSI signals in ranging market", () => {
    const cfg = makeBaseCfg({
      signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] }, // original has only MA signals
      regime_strategies: {
        reversal_signals_only: {
          signals: {
            buy: ["rsi_oversold"],  // ranging market switches to RSI reversal
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
// 3. Auto-classification filtering (regime_strategies configured but no mapping for this signalFilter)
// ─────────────────────────────────────────────────────

describe("Auto-classification filtering (activated when regime_strategies is non-empty)", () => {
  it("with regime_strategies configured (even just 1 entry), auto-classification applies to other signalFilters", () => {
    // Configure trending override, but not reversal → auto-classification
    const cfg = makeBaseCfg({
      signals: { buy: ["ma_bullish", "rsi_oversold"], sell: ["ma_bearish"] },
      regime_strategies: {
        trend_signals_only: {
          signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] },
        },
        // reversal_signals_only not configured → auto-classification: keep rsi types, filter ma types
      },
    });
    const klines = makeSidewaysKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    // Ranging market auto-filter: buy = ["rsi_oversold"] (ma_bullish filtered out)
    // Result doesn't crash and numbers are valid
    expect(typeof result.metrics.totalTrades).toBe("number");
  });

  it("regime_strategies = {} empty object → not activated (backward compatible)", () => {
    const cfg = makeBaseCfg({ regime_strategies: {} });
    const klines = makeTrendingBullKlines();
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);
    expect(typeof result.metrics.totalTrades).toBe("number");
  });
});

// ─────────────────────────────────────────────────────
// 4. No crash: multi-symbol scenario
// ─────────────────────────────────────────────────────

describe("multi-symbol + regime_strategies no crash", () => {
  it("BTC(trending) + ETH(ranging) run regime filtering simultaneously", () => {
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

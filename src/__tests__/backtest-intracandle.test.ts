/**
 * P6.3 — Backtest Intra-candle Simulation Tests
 *
 * Test scenarios:
 * - Same candle low hits stop loss (long should trigger)
 * - Same candle high hits take profit (long should trigger)
 * - Same candle low hits stop loss AND high hits take profit (stop loss takes priority)
 * - Short mirror tests (high hits stop loss, low hits take profit, priority)
 * - Trailing stop uses kline.high/low to update (intracandle mode)
 * - intracandle=false backward compatible mode
 * - Time stop
 *
 * Note: warmupBars = max(MA.long=5, RSI.period=3) + 10 = 15
 *       The "test kline" close values after the entry signal kline are carefully
 *       designed to prevent re-entry (when MA3 ~ MA5, ma_bullish/ma_bearish won't trigger)
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────

/** Create a custom kline (open equals close) */
function makeKline(close: number, high: number, low: number, time: number): Kline {
  return { openTime: time, open: close, high, low, close, volume: 1000, closeTime: time + 3599_000 };
}

/** Create a flat kline (high/low tightly around close +/-0.1%) */
function flatKline(price: number, time: number): Kline {
  return makeKline(price, price * 1.001, price * 0.999, time);
}

/**
 * Create warmupCount flat warmup klines + subsequent klines (1h time step).
 * The time parameter of each kline in extras is ignored and rewritten as offset + i*1h.
 */
function buildKlines(warmupPrice: number, warmupCount: number, extras: Kline[]): Kline[] {
  const warmup = Array.from({ length: warmupCount }, (_, i) =>
    flatKline(warmupPrice, i * 3_600_000)
  );
  const offset = warmupCount * 3_600_000;
  const shifted = extras.map((k, i) => ({
    ...k,
    openTime: offset + i * 3_600_000,
    closeTime: offset + i * 3_600_000 + 3_599_000,
  }));
  return [...warmup, ...shifted];
}

/**
 * Long strategy config
 * signal: ma_bullish = MA3 > MA5 -> buy; ma_bearish = MA3 < MA5 -> sell
 */
function makeLongCfg(overrides: {
  stopLoss?: number;
  takeProfit?: number;
  trailingEnabled?: boolean;
  trailingActivation?: number;
  trailingCallback?: number;
  timeStopHours?: number;
} = {}): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "long-intracandle-test",
      enabled: true,
      ma: { short: 3, long: 5 },
      rsi: { period: 3, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: ["ma_bullish"], sell: ["ma_bearish"], short: [], cover: [] },
    risk: {
      stop_loss_percent: overrides.stopLoss ?? 5,
      take_profit_percent: overrides.takeProfit ?? 10,
      trailing_stop: {
        enabled: overrides.trailingEnabled ?? false,
        activation_percent: overrides.trailingActivation ?? 5,
        callback_percent: overrides.trailingCallback ?? 3,
      },
      position_ratio: 0.5,
      max_positions: 4,
      max_position_per_symbol: 0.8,
      max_total_loss_percent: 50,
      daily_loss_limit_percent: 50,
      ...(overrides.timeStopHours !== undefined ? { time_stop_hours: overrides.timeStopHours } : {}),
    },
    execution: { order_type: "market", limit_order_offset_percent: 0, min_order_usdt: 1, limit_order_timeout_seconds: 30 },
    notify: { on_signal: false, on_trade: false, on_stop_loss: false, on_take_profit: false, on_error: false, on_daily_summary: false, min_interval_minutes: 0 },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
  };
}

/** Short strategy config */
function makeShortCfg(overrides: {
  stopLoss?: number;
  takeProfit?: number;
  trailingEnabled?: boolean;
  trailingActivation?: number;
  trailingCallback?: number;
} = {}): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "short-intracandle-test",
      enabled: true,
      ma: { short: 3, long: 5 },
      rsi: { period: 3, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [], short: ["ma_bearish"], cover: ["ma_bullish"] },
    risk: {
      stop_loss_percent: overrides.stopLoss ?? 5,
      take_profit_percent: overrides.takeProfit ?? 10,
      trailing_stop: {
        enabled: overrides.trailingEnabled ?? false,
        activation_percent: overrides.trailingActivation ?? 5,
        callback_percent: overrides.trailingCallback ?? 3,
      },
      position_ratio: 0.5,
      max_positions: 4,
      max_position_per_symbol: 0.8,
      max_total_loss_percent: 50,
      daily_loss_limit_percent: 50,
    },
    execution: { order_type: "market", limit_order_offset_percent: 0, min_order_usdt: 1, limit_order_timeout_seconds: 30 },
    notify: { on_signal: false, on_trade: false, on_stop_loss: false, on_take_profit: false, on_error: false, on_daily_summary: false, min_interval_minutes: 0 },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
  };
}

// Zero fees/slippage (eliminate variables during testing)
const ZERO_FEES = { initialUsdt: 1000, feeRate: 0, slippagePercent: 0 };

// ─────────────────────────────────────────────────────
// Long tests
// ─────────────────────────────────────────────────────

describe("P6.3 Long — intracandle=true (default)", () => {
  /**
   * Test 1: Same candle low hits stop loss (should trigger)
   *
   * Entry price = 101 (warmup at 100, kline[15] close=101 triggers ma_bullish)
   * stopLoss = 101 * 0.95 = 95.95
   *
   * Test kline close=98 (< 101 so MA3 < MA5, prevents re-entry)
   *   high=100 (above stop loss, close mode would not trigger)
   *   low=94 (below stop loss, intracandle should trigger)
   * Expected: stop_loss triggers, exitPrice ~ 95.95
   */
  it("long: same candle low hits stop loss (close does not reach, intracandle should trigger)", () => {
    const entryPrice = 101;
    const stopLossPct = 5;
    const stopLossPrice = entryPrice * (1 - stopLossPct / 100); // 95.95

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),                     // kline[15]: ma_bullish -> open long at 101
      makeKline(98, 100, 94, 3_600_000),     // kline[16]: close=98, low=94 < 95.95 -> stop loss
    ]);

    const cfg = makeLongCfg({ stopLoss: stopLossPct });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    // Filter by reason (not total count, to avoid re-entry + end_of_data interference)
    const stopLossTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "stop_loss"
    );
    expect(stopLossTrades.length).toBeGreaterThanOrEqual(1);
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
  });

  /**
   * Test 2: Same candle high hits take profit (should trigger)
   *
   * Entry price = 101, takeProfit = 101 * 1.10 = 111.1
   *
   * Test kline close=97 (MA3 < MA5 prevents re-entry)
   *   high=115 (exceeds 111.1, intracandle take profit)
   *   low=96 (does not trigger stop loss)
   * Expected: take_profit triggers, exitPrice ~ 111.1
   */
  it("long: same candle high hits take profit (close does not reach, intracandle should trigger)", () => {
    const entryPrice = 101;
    const takeProfitPct = 10;
    const takeProfitPrice = entryPrice * (1 + takeProfitPct / 100); // 111.1

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(97, 115, 96, 3_600_000),   // close=97, high=115 > 111.1 -> take profit
    ]);

    const cfg = makeLongCfg({ takeProfit: takeProfitPct });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const takeProfitTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "take_profit"
    );
    expect(takeProfitTrades.length).toBeGreaterThanOrEqual(1);
    expect(takeProfitTrades[0]?.exitPrice).toBeCloseTo(takeProfitPrice, 1);
  });

  /**
   * Test 3: Same candle low hits stop loss AND high hits take profit -> stop loss takes priority (conservative model)
   *
   * Test kline: close=105 (MA3>MA5, possible re-entry, verify with stop_loss)
   *   high=115 (> takeProfit=111.1)
   *   low=94 (< stopLoss=95.95)
   * Expected: stop_loss triggers, no take_profit trade (first exit should be stop loss)
   */
  it("long: same candle low hits stop loss + high hits take profit -> stop loss takes priority (conservative assumption)", () => {
    const entryPrice = 101;
    const stopLossPrice = entryPrice * (1 - 5 / 100);    // 95.95
    const takeProfitPrice = entryPrice * (1 + 10 / 100); // 111.1

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      // close=105, high=115 > 111.1, low=94 < 95.95 -> stop loss takes priority
      makeKline(105, 115, 94, 3_600_000),
      flatKline(100, 7_200_000), // post-stop-loss kline, no re-entry
    ]);

    const cfg = makeLongCfg({ stopLoss: 5, takeProfit: 10 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "stop_loss"
    );
    const takeProfitTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "take_profit"
    );

    expect(stopLossTrades.length).toBeGreaterThanOrEqual(1);
    // First exit should be stop loss, no take profit should occur
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
    expect(takeProfitTrades.length).toBe(0); // take profit should not trigger (stop loss takes priority)
    expect(stopLossTrades[0]?.exitPrice).not.toBeCloseTo(takeProfitPrice, 0);
  });

  /**
   * Test 4: intracandle=false backward compatible - close does not reach stop loss -> does not trigger
   *
   * Same kline (low < stopLoss), but intracandle=false uses close for comparison
   * close=98 > stopLoss=95.95 -> does not trigger stop loss
   * Expected: no stop_loss trade, has end_of_data close
   */
  it("long: intracandle=false when close does not reach stop loss -> does not trigger (backward compatible)", () => {
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(98, 100, 94, 3_600_000),  // close=98 > stopLoss, low=94 < stopLoss
    ]);

    const cfg = makeLongCfg({ stopLoss: 5 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "stop_loss"
    );
    // Close mode: stop loss does not trigger
    expect(stopLossTrades.length).toBe(0);
    // Has end_of_data close (position held until the end)
    const endTrades = result.trades.filter((t) => t.exitReason === "end_of_data");
    expect(endTrades.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Test 5: Long trailing stop uses kline.high to update highestPrice
   *
   * Entry price 101, trailingActivation=5%, callback=3%
   * kline[16]: high=108 -> gain 6.9% >= 5% -> activates trailing stop
   *   -> stopPrice = 108 * 0.97 = 104.76
   *   -> low=103 <= 104.76 -> trailing stop triggers
   * close=97 ensures MA3 < MA5, prevents re-entry
   */
  it("long: trailing stop uses kline.high to update highestPrice (intracandle mode)", () => {
    const highestPrice = 108;
    const callbackPct = 3;
    const expectedStopPrice = highestPrice * (1 - callbackPct / 100); // 104.76

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      // close=97 (MA3<MA5, prevents re-entry), high=108 (activates trailing), low=103 (triggers trailing)
      makeKline(97, 108, 103, 3_600_000),
    ]);

    const cfg = makeLongCfg({
      stopLoss: 20,        // set far to avoid early trigger
      takeProfit: 50,      // set high to avoid early trigger
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: callbackPct,
    });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const trailingTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "trailing_stop"
    );
    expect(trailingTrades.length).toBeGreaterThanOrEqual(1);
    expect(trailingTrades[0]?.exitPrice).toBeCloseTo(expectedStopPrice, 0);
  });

  /**
   * Test 6: Time stop (time_stop_hours)
   *
   * Position held for 3h with no profit (pnlPct=0 <= 0) -> time stop triggers
   * flatKline(101) sequence: MA3 and MA5 both approach 101, no re-entry triggered
   */
  it("long: time_stop_hours triggers time stop (position timeout with no profit)", () => {
    const timeStopHours = 3;
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),          // extras[0]: open position
      flatKline(101, 3_600_000),  // extras[1]: 1h
      flatKline(101, 7_200_000),  // extras[2]: 2h
      flatKline(101, 10_800_000), // extras[3]: 3h (holdMs=3h, pnlPct=0 -> time stop)
    ]);

    const cfg = makeLongCfg({ timeStopHours });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const timeTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "time_stop"
    );
    expect(timeTrades.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────
// Short tests
// ─────────────────────────────────────────────────────

describe("P6.3 Short — intracandle=true (default)", () => {
  /**
   * Test 7: Short — high hits stop loss (intracandle should trigger)
   *
   * Short entry price = 99 (warmup at 100, kline[15] close=99 triggers ma_bearish)
   * stopLoss = 99 * 1.05 = 103.95 (price rises above = stop loss)
   *
   * Test kline: close=101 (MA3=MA5=100, no re-entry signal)
   *   high=105 (> 103.95, intracandle stop loss)
   *   low=98 (does not trigger take profit)
   */
  it("short: same candle high hits stop loss (close does not reach, intracandle should trigger)", () => {
    const entryPrice = 99;
    const stopLossPct = 5;
    const stopLossPrice = entryPrice * (1 + stopLossPct / 100); // 103.95

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),                    // kline[15]: ma_bearish -> open short at 99
      makeKline(101, 105, 98, 3_600_000),  // close=101, high=105 > 103.95 -> stop loss
    ]);

    const cfg = makeShortCfg({ stopLoss: stopLossPct });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    expect(stopLossTrades.length).toBeGreaterThanOrEqual(1);
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
  });

  /**
   * Test 8: Short — low hits take profit (intracandle should trigger)
   *
   * Short entry price = 99, takeProfit = 99 * 0.90 = 89.1 (price falls below = take profit)
   *
   * Test kline: close=101 (MA3=MA5=100, no re-entry)
   *   high=95 (does not trigger stop loss)
   *   low=88 (< 89.1, intracandle take profit)
   */
  it("short: same candle low hits take profit (close does not reach, intracandle should trigger)", () => {
    const entryPrice = 99;
    const takeProfitPct = 10;
    const takeProfitPrice = entryPrice * (1 - takeProfitPct / 100); // 89.1

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      makeKline(101, 95, 88, 3_600_000),  // close=101, low=88 < 89.1 -> take profit
    ]);

    const cfg = makeShortCfg({ takeProfit: takeProfitPct });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const takeProfitTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "take_profit"
    );
    expect(takeProfitTrades.length).toBeGreaterThanOrEqual(1);
    expect(takeProfitTrades[0]?.exitPrice).toBeCloseTo(takeProfitPrice, 1);
  });

  /**
   * Test 9: Short — high hits stop loss AND low hits take profit -> stop loss takes priority
   *
   * Test kline: close=105 (MA3>MA5, prevents re-shorting)
   *   high=106 (> stopLoss=103.95)
   *   low=87 (< takeProfit=89.1)
   * Expected: stop_loss triggers (priority), no take_profit trade
   */
  it("short: same candle high hits stop loss + low hits take profit -> stop loss takes priority (conservative assumption)", () => {
    const entryPrice = 99;
    const stopLossPrice = entryPrice * (1 + 5 / 100);    // 103.95
    const takeProfitPrice = entryPrice * (1 - 10 / 100); // 89.1

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      // close=105(MA3>MA5), high=106>103.95, low=87<89.1 -> stop loss takes priority
      makeKline(105, 106, 87, 3_600_000),
    ]);

    const cfg = makeShortCfg({ stopLoss: 5, takeProfit: 10 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    const takeProfitTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "take_profit"
    );

    expect(stopLossTrades.length).toBeGreaterThanOrEqual(1);
    expect(takeProfitTrades.length).toBe(0); // stop loss takes priority, no take profit
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
    expect(stopLossTrades[0]?.exitPrice).not.toBeCloseTo(takeProfitPrice, 0);
  });

  /**
   * Test 10: Short intracandle=false — close does not reach stop loss -> does not trigger
   *
   * kline high=105 > stopLoss=103.95, but close=101 < stopLoss -> intracandle=false does not trigger
   */
  it("short: intracandle=false when close does not reach stop loss -> does not trigger (backward compatible)", () => {
    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      makeKline(101, 105, 98, 3_600_000),  // close=101 < 103.95, high=105 > 103.95
    ]);

    const cfg = makeShortCfg({ stopLoss: 5 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    // Close mode: stop loss does not trigger (close=101 < stopLoss=103.95)
    expect(stopLossTrades.length).toBe(0);
  });

  /**
   * Test 11: Short trailing stop uses kline.low to update lowestPrice
   *
   * Entry price 99, activation=5%, callback=3%
   * kline[16]: low=93 -> drop = (99-93)/99 ~ 6% >= 5% -> activates trailing stop
   *   -> stopPrice = 93 * 1.03 = 95.79
   *   -> high=96 >= 95.79 -> trailing stop triggers
   * close=101 (MA3=MA5, no re-entry)
   */
  it("short: trailing stop uses kline.low to update lowestPrice (intracandle mode)", () => {
    const lowestPrice = 93;
    const callbackPct = 3;
    const expectedStopPrice = lowestPrice * (1 + callbackPct / 100); // 95.79

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      // close=101(MA3=MA5, no signal), low=93 (activates trailing, gain~6%), high=96 (triggers trailing, 96>=95.79)
      makeKline(101, 96, 93, 3_600_000),
    ]);

    const cfg = makeShortCfg({
      stopLoss: 30,        // set far to avoid early trigger
      takeProfit: 50,      // set far to avoid early trigger
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: callbackPct,
    });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    const trailingTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "trailing_stop"
    );
    expect(trailingTrades.length).toBeGreaterThanOrEqual(1);
    expect(trailingTrades[0]?.exitPrice).toBeCloseTo(expectedStopPrice, 0);
  });
});

// ─────────────────────────────────────────────────────
// Intracandle comparison tests
// ─────────────────────────────────────────────────────

describe("P6.3 — intracandle behavior comparison (true vs false)", () => {
  /**
   * Test 12: Same klines, intracandle=true triggers stop loss, intracandle=false does not
   *
   * kline: close=98, high=100, low=94 (low < stopLoss=95.95, close > stopLoss)
   */
  it("intracandle=true triggers stop loss vs intracandle=false does not trigger", () => {
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(98, 100, 94, 3_600_000),  // close=98 > 95.95 > low=94
    ]);
    const cfg = makeLongCfg({ stopLoss: 5 });

    const resultOn  = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: true });
    const resultOff = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossOn  = resultOn.trades.filter((t) => t.side === "sell" && t.exitReason === "stop_loss");
    const stopLossOff = resultOff.trades.filter((t) => t.side === "sell" && t.exitReason === "stop_loss");

    expect(stopLossOn.length).toBeGreaterThanOrEqual(1);  // intracandle=true: stop loss triggers
    expect(stopLossOff.length).toBe(0);                   // intracandle=false: close=98 > stopLoss, does not trigger
  });
});

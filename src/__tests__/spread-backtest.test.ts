/**
 * Bid/Ask Spread modeling — backtest tests
 *
 * System behavior notes (relevant to test design):
 *  - doBuy does not set pos.side; long positions can only exit through stop_loss/take_profit/end_of_data,
 *    not through signal sell (detectSignal requires positionSide==="long" to return sell)
 *  - doOpenShort does not create trade records; doCoverShort creates cover records,
 *    where entryPrice = pos.entryPrice (the spread-adjusted price at short open)
 *
 * Test coverage:
 *  1. spread=0: behavior unchanged
 *  2. spread=5: long buy price is higher (buy at ask)
 *  3. spread=5: long sell price is lower (sell at bid)
 *  4. Short open (cover.entryPrice) sells at bid: lower with spread=5
 *  5. Short close (cover.exitPrice) buys at ask: higher with spread=5
 *  6. spread + slippage stacking calculation
 *  7. Backtest result spread impact on PnL
 *  8. cfg.risk.spread_bps config source
 *  9. BacktestResult.config.spreadBps field
 *  10. CLI parseArgs --spread parameter
 *
 * warmupBars = max(ma.long=5, rsi.period=3) + 10 = 15
 * Using 16 warmup bars to ensure sufficient indicator warmup period
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import { parseBacktestArgs } from "../backtest/cli-args.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─── Helper functions ───────────────────────────────────────

function makeKline(close: number, time: number, highMult = 1.001, lowMult = 0.999): Kline {
  return {
    openTime: time,
    open: close,
    high: close * highMult,
    low: close * lowMult,
    close,
    volume: 1000,
    closeTime: time + 3599_000,
  };
}

/** Generate warmup klines + tail klines (auto-rewrite timestamps) */
function withWarmup(warmupPrice: number, warmupCount: number, tail: Kline[]): Kline[] {
  const warmup = Array.from({ length: warmupCount }, (_, i) =>
    makeKline(warmupPrice, i * 3600_000)
  );
  const offset = warmupCount * 3600_000;
  const shifted = tail.map((k, i) => ({
    ...k,
    openTime: offset + i * 3600_000,
    closeTime: offset + i * 3600_000 + 3599_000,
  }));
  return [...warmup, ...shifted];
}

/**
 * Long trade kline sequence:
 *   16 warmup bars @100 -> close=101 triggers ma_bullish (buy) -> end_of_data @101 closes
 *   Entry/exit close are both 101, convenient for verifying spread adjustments
 */
function makeLongOnlyKlines(): Kline[] {
  return withWarmup(100, 16, [makeKline(101, 0)]);
}

/**
 * Long trade + drop klines:
 *   Buy @101, last bar @90 (end_of_data), entry and exit close differ
 */
function makeLongWithDropKlines(): Kline[] {
  return withWarmup(100, 16, [
    makeKline(101, 0), // buy signal
    makeKline(101, 1), // hold
    makeKline(90, 2),  // end_of_data at 90
  ]);
}

/**
 * Short trade kline sequence:
 *   16 warmup bars @100 -> close=95 triggers ma_bearish (open short) -> end_of_data @95 closes
 *   Entry/exit close are both 95
 */
function makeShortOnlyKlines(): Kline[] {
  return withWarmup(100, 16, [makeKline(95, 0)]);
}

/** Long strategy config (fee=0, slippage controlled by opts) */
function makeLongCfg(spreadBpsInCfg?: number): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "spread-test-long",
      enabled: true,
      ma: { short: 3, long: 5 },
      rsi: { period: 3, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] },
    risk: {
      stop_loss_percent: 50,      // large stop loss to prevent triggering before end_of_data
      take_profit_percent: 200,   // large take profit to prevent early trigger
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.5,
      max_positions: 4,
      max_position_per_symbol: 0.8,
      max_total_loss_percent: 90,
      daily_loss_limit_percent: 90,
      ...(spreadBpsInCfg !== undefined ? { spread_bps: spreadBpsInCfg } : {}),
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
  };
}

/** Short strategy config */
function makeShortCfg(spreadBpsInCfg?: number): StrategyConfig {
  return {
    ...makeLongCfg(spreadBpsInCfg),
    strategy: {
      name: "spread-test-short",
      enabled: true,
      ma: { short: 3, long: 5 },
      rsi: { period: 3, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: {
      buy: [],
      sell: [],
      short: ["ma_bearish"],
      cover: ["ma_bullish"],
    },
  };
}

const ZERO_FEES = { initialUsdt: 1000, feeRate: 0, slippagePercent: 0 };

// ─────────────────────────────────────────────────────
// 1. spread=0: behavior unchanged
// ─────────────────────────────────────────────────────

describe("spread=0: behavior unchanged", () => {
  it("spread=0 buy price = close x 1 (no extra cost)", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 0,
    });

    const buyTrade = result.trades.find((t) => t.side === "buy");
    expect(buyTrade).toBeDefined();
    expect(buyTrade!.entryPrice).toBeCloseTo(101, 6); // no slippage no spread -> exactly close
  });

  it("spread=0 sell price (end_of_data) = close x 1", () => {
    const klines = makeLongOnlyKlines(); // buy + end_of_data@101
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 0,
    });

    const sellTrade = result.trades.find((t) => t.side === "sell");
    expect(sellTrade).toBeDefined();
    expect(sellTrade!.exitPrice).toBeCloseTo(101, 6);
  });

  it("spreadBps=0 and omitting spreadBps produce identical results", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const rNone = runBacktest({ BTCUSDT: klines }, makeLongCfg(), ZERO_FEES);
    expect(r0.metrics.totalReturn).toBeCloseTo(rNone.metrics.totalReturn, 10);
  });
});

// ─────────────────────────────────────────────────────
// 2. spread=5: long buys at ask (higher entry price)
// ─────────────────────────────────────────────────────

describe("spread=5: long buys at ask", () => {
  it("buy price = close x (1 + 5/20000)", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 5,
    });

    const buyTrade = result.trades.find((t) => t.side === "buy");
    expect(buyTrade).toBeDefined();
    const expected = 101 * (1 + 5 / 20000);
    expect(buyTrade!.entryPrice).toBeCloseTo(expected, 6);
  });

  it("spread=5 buy price > spread=0 buy price", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const buy0 = r0.trades.find((t) => t.side === "buy");
    const buy5 = r5.trades.find((t) => t.side === "buy");
    expect(buy5!.entryPrice).toBeGreaterThan(buy0!.entryPrice);
  });
});

// ─────────────────────────────────────────────────────
// 3. spread=5: long sells at bid (lower exit price)
// ─────────────────────────────────────────────────────

describe("spread=5: long sells at bid", () => {
  it("sell price (end_of_data) = close x (1 - 5/20000)", () => {
    const klines = makeLongOnlyKlines(); // entry + exit both at close=101
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 5,
    });

    const sellTrade = result.trades.find((t) => t.side === "sell");
    expect(sellTrade).toBeDefined();
    const expected = 101 * (1 - 5 / 20000);
    expect(sellTrade!.exitPrice).toBeCloseTo(expected, 6);
  });

  it("spread=5 sell price < spread=0 sell price", () => {
    const klines = makeLongWithDropKlines(); // exit at close=90
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const sell0 = r0.trades.find((t) => t.side === "sell");
    const sell5 = r5.trades.find((t) => t.side === "sell");
    expect(sell5!.exitPrice).toBeLessThan(sell0!.exitPrice);
  });
});

// ─────────────────────────────────────────────────────
// 4. Short open: sells at bid (lower entryPrice)
// ─────────────────────────────────────────────────────

describe("Short open: sells at bid", () => {
  it("short open entryPrice (cover.entryPrice) = close x (1 - 5/20000)", () => {
    const klines = makeShortOnlyKlines(); // short at 95, end_of_data cover at 95
    const result = runBacktest({ BTCUSDT: klines }, makeShortCfg(), {
      ...ZERO_FEES,
      spreadBps: 5,
    });

    const coverTrade = result.trades.find((t) => t.side === "cover");
    expect(coverTrade).toBeDefined();
    const expected = 95 * (1 - 5 / 20000);
    expect(coverTrade!.entryPrice).toBeCloseTo(expected, 6);
  });

  it("spread=5 short open entryPrice < spread=0 short open entryPrice", () => {
    const klines = makeShortOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const cover0 = r0.trades.find((t) => t.side === "cover");
    const cover5 = r5.trades.find((t) => t.side === "cover");
    expect(cover0).toBeDefined();
    expect(cover5).toBeDefined();
    expect(cover5!.entryPrice).toBeLessThan(cover0!.entryPrice);
  });
});

// ─────────────────────────────────────────────────────
// 5. Short close: buys at ask (higher exitPrice)
// ─────────────────────────────────────────────────────

describe("Short close: buys at ask", () => {
  it("cover exitPrice (cover.exitPrice) = close x (1 + 5/20000)", () => {
    const klines = makeShortOnlyKlines(); // cover at close=95
    const result = runBacktest({ BTCUSDT: klines }, makeShortCfg(), {
      ...ZERO_FEES,
      spreadBps: 5,
    });

    const coverTrade = result.trades.find((t) => t.side === "cover");
    expect(coverTrade).toBeDefined();
    const expected = 95 * (1 + 5 / 20000);
    expect(coverTrade!.exitPrice).toBeCloseTo(expected, 6);
  });

  it("spread=5 cover exitPrice > spread=0 cover exitPrice", () => {
    const klines = makeShortOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const cover0 = r0.trades.find((t) => t.side === "cover");
    const cover5 = r5.trades.find((t) => t.side === "cover");
    expect(cover5!.exitPrice).toBeGreaterThan(cover0!.exitPrice);
  });
});

// ─────────────────────────────────────────────────────
// 6. spread + slippage stacking
// ─────────────────────────────────────────────────────

describe("spread + slippage stacking", () => {
  it("long buy: execPrice = close x (1 + slip/100 + spread/20000)", () => {
    const klines = makeLongOnlyKlines();
    const slip = 0.1;
    const spread = 5;
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000,
      feeRate: 0,
      slippagePercent: slip,
      spreadBps: spread,
    });

    const buyTrade = result.trades.find((t) => t.side === "buy");
    expect(buyTrade).toBeDefined();
    const expected = 101 * (1 + slip / 100 + spread / 20000);
    expect(buyTrade!.entryPrice).toBeCloseTo(expected, 5);
  });

  it("long sell: execPrice = close x (1 - slip/100 - spread/20000)", () => {
    const klines = makeLongOnlyKlines();
    const slip = 0.1;
    const spread = 5;
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000,
      feeRate: 0,
      slippagePercent: slip,
      spreadBps: spread,
    });

    const sellTrade = result.trades.find((t) => t.side === "sell");
    expect(sellTrade).toBeDefined();
    const expected = 101 * (1 - slip / 100 - spread / 20000); // exit at same close=101
    expect(sellTrade!.exitPrice).toBeCloseTo(expected, 5);
  });

  it("spread=0 slippage=0.05 and slippagePercent=0.05 without spread produce identical results", () => {
    const klines = makeLongOnlyKlines();
    const rA = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000, feeRate: 0, slippagePercent: 0.05, spreadBps: 0,
    });
    const rB = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000, feeRate: 0, slippagePercent: 0.05,
    });
    expect(rA.metrics.totalReturn).toBeCloseTo(rB.metrics.totalReturn, 10);
  });

  it("short open: execPrice = close x (1 - slip/100 - spread/20000)", () => {
    const klines = makeShortOnlyKlines();
    const slip = 0.1;
    const spread = 8;
    const result = runBacktest({ BTCUSDT: klines }, makeShortCfg(), {
      initialUsdt: 1000,
      feeRate: 0,
      slippagePercent: slip,
      spreadBps: spread,
    });

    const coverTrade = result.trades.find((t) => t.side === "cover");
    expect(coverTrade).toBeDefined();
    const expected = 95 * (1 - slip / 100 - spread / 20000);
    expect(coverTrade!.entryPrice).toBeCloseTo(expected, 5);
  });

  it("short close: execPrice = close x (1 + slip/100 + spread/20000)", () => {
    const klines = makeShortOnlyKlines();
    const slip = 0.1;
    const spread = 8;
    const result = runBacktest({ BTCUSDT: klines }, makeShortCfg(), {
      initialUsdt: 1000,
      feeRate: 0,
      slippagePercent: slip,
      spreadBps: spread,
    });

    const coverTrade = result.trades.find((t) => t.side === "cover");
    expect(coverTrade).toBeDefined();
    const expected = 95 * (1 + slip / 100 + spread / 20000);
    expect(coverTrade!.exitPrice).toBeCloseTo(expected, 5);
  });
});

// ─────────────────────────────────────────────────────
// 7. spread impact on PnL
// ─────────────────────────────────────────────────────

describe("spread impact on PnL", () => {
  it("long: spread=5 total return < spread=0", () => {
    // buy @101 sell @101: spread=0 PnL~0, spread=5 PnL < 0 (round-trip spread cost)
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });
    expect(r5.metrics.totalReturn).toBeLessThan(r0.metrics.totalReturn);
  });

  it("short: spread=5 total return < spread=0", () => {
    // open short @95 cover @95: spread=0 PnL~0, spread=5 double-sided spread causes loss
    const klines = makeShortOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 5 });
    expect(r5.metrics.totalReturn).toBeLessThan(r0.metrics.totalReturn);
  });

  it("larger spread causes more PnL loss (monotonically decreasing)", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });
    const r20 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 20 });
    expect(r0.metrics.totalReturn).toBeGreaterThan(r5.metrics.totalReturn);
    expect(r5.metrics.totalReturn).toBeGreaterThan(r20.metrics.totalReturn);
  });
});

// ─────────────────────────────────────────────────────
// 8. cfg.risk.spread_bps config source
// ─────────────────────────────────────────────────────

describe("cfg.risk.spread_bps config source", () => {
  it("cfg.risk.spread_bps=5 is equivalent to opts.spreadBps=5 (same buy price)", () => {
    const klines = makeLongOnlyKlines();
    const rCfg = runBacktest({ BTCUSDT: klines }, makeLongCfg(5), ZERO_FEES);
    const rOpts = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const buyCfg = rCfg.trades.find((t) => t.side === "buy");
    const buyOpts = rOpts.trades.find((t) => t.side === "buy");
    expect(buyCfg!.entryPrice).toBeCloseTo(buyOpts!.entryPrice, 8);
  });

  it("opts.spreadBps takes priority over cfg.risk.spread_bps", () => {
    const klines = makeLongOnlyKlines();
    // cfg=10 bps, opts=5 bps -> opts=5 takes priority
    const rPriority = runBacktest({ BTCUSDT: klines }, makeLongCfg(10), {
      ...ZERO_FEES,
      spreadBps: 5,
    });
    const r5Only = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 5,
    });
    const buyPriority = rPriority.trades.find((t) => t.side === "buy");
    const buy5 = r5Only.trades.find((t) => t.side === "buy");
    expect(buyPriority!.entryPrice).toBeCloseTo(buy5!.entryPrice, 8);
  });
});

// ─────────────────────────────────────────────────────
// 9. BacktestResult.config.spreadBps
// ─────────────────────────────────────────────────────

describe("BacktestResult.config.spreadBps", () => {
  it("result.config.spreadBps returns the passed spreadBps value", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 7,
    });
    expect(result.config.spreadBps).toBe(7);
  });

  it("result.config.spreadBps is 0 when spreadBps is not passed", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), ZERO_FEES);
    expect(result.config.spreadBps).toBe(0);
  });

  it("result.config.spreadBps is correct when configured via cfg.risk.spread_bps", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(3), ZERO_FEES);
    expect(result.config.spreadBps).toBe(3);
  });
});

// ─────────────────────────────────────────────────────
// 10. CLI parseArgs --spread parameter parsing
// ─────────────────────────────────────────────────────

describe("CLI parseArgs: --spread parameter", () => {
  it("--spread 5 -> spreadBps = 5", () => {
    const args = parseBacktestArgs(["--spread", "5"]);
    expect(args.spreadBps).toBe(5);
  });

  it("--spread 10.5 -> spreadBps = 10.5", () => {
    const args = parseBacktestArgs(["--spread", "10.5"]);
    expect(args.spreadBps).toBeCloseTo(10.5, 5);
  });

  it("no --spread -> spreadBps = 0 (default)", () => {
    const args = parseBacktestArgs([]);
    expect(args.spreadBps).toBe(0);
  });

  it("--spread 0 -> spreadBps = 0", () => {
    const args = parseBacktestArgs(["--spread", "0"]);
    expect(args.spreadBps).toBe(0);
  });

  it("--spread mixed with other parameters parses correctly", () => {
    const args = parseBacktestArgs(["--days", "30", "--spread", "5", "--no-save"]);
    expect(args.days).toBe(30);
    expect(args.spreadBps).toBe(5);
    expect(args.save).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 11. signalToNextOpen — signal delayed by one kline execution (eliminates look-ahead bias)
// ─────────────────────────────────────────────────────

describe("signalToNextOpen — execute at next kline open price", () => {
  /**
   * Setup: 16 warmup bars (price stable @ 100) -> MA bullish signal at kline N (close=110)
   *       -> next bar open price = 115 (gap up)
   *
   * Expected:
   *   signalToNextOpen=false -> entryPrice ~ 110 (with slippage, current bar close)
   *   signalToNextOpen=true  -> entryPrice ~ 115 (with slippage, next bar open)
   */
  function makeNextOpenKlines(): Kline[] {
    const WARMUP = 16;
    const WARMUP_PRICE = 100;
    const SIGNAL_CLOSE = 110; // MA bullish signal trigger
    const NEXT_OPEN = 115;    // next bar open price (gap up)

    const warmup = Array.from({ length: WARMUP }, (_, i) =>
      makeKline(WARMUP_PRICE, i * 3600_000)
    );

    // Signal kline: close > warmup -> triggers MA bullish
    const signalKline: Kline = {
      openTime: WARMUP * 3600_000,
      open: WARMUP_PRICE,
      high: SIGNAL_CLOSE * 1.001,
      low: WARMUP_PRICE * 0.999,
      close: SIGNAL_CLOSE,
      volume: 1000,
      closeTime: WARMUP * 3600_000 + 3599_000,
    };

    // Next bar: opens with gap to 115, closes at 120 (continued rally)
    const nextKline: Kline = {
      openTime: (WARMUP + 1) * 3600_000,
      open: NEXT_OPEN,
      high: 125,
      low: 113,
      close: 120,
      volume: 1000,
      closeTime: (WARMUP + 1) * 3600_000 + 3599_000,
    };

    // Add a few more bars for position stop/take profit processing
    const trailing = Array.from({ length: 5 }, (_, i) =>
      makeKline(120, (WARMUP + 2 + i) * 3600_000)
    );

    return [...warmup, signalKline, nextKline, ...trailing];
  }

  it("signalToNextOpen=false (default) -> buy uses current bar close (entryPrice ~ close=110)", () => {
    const klines = makeNextOpenKlines();
    const cfg = makeLongCfg();
    const result = runBacktest(
      { BTCUSDT: klines },
      cfg,
      { ...ZERO_FEES, slippagePercent: 0 }
    );

    const buy = result.trades.find((t) => t.side === "buy");
    expect(buy).toBeDefined();
    // No signalToNextOpen -> current bar close=110 execution (BacktestTrade field is entryPrice)
    expect(buy!.entryPrice).toBeCloseTo(110, 1);
    expect(result.config.signalToNextOpen).toBe(false);
  });

  it("signalToNextOpen=true -> buy uses next bar open price (entryPrice ~ open=115)", () => {
    const klines = makeNextOpenKlines();
    const cfg = makeLongCfg();
    const result = runBacktest(
      { BTCUSDT: klines },
      cfg,
      { ...ZERO_FEES, slippagePercent: 0, signalToNextOpen: true }
    );

    const buy = result.trades.find((t) => t.side === "buy");
    expect(buy).toBeDefined();
    // signalToNextOpen=true -> next bar open=115 execution (entryPrice should be close to 115)
    expect(buy!.entryPrice).toBeGreaterThan(110);  // not current bar close
    expect(buy!.entryPrice).toBeCloseTo(115, 0);   // close to next bar open
    expect(result.config.signalToNextOpen).toBe(true);
  });

  it("signalToNextOpen=true -> result.config.signalToNextOpen = true", () => {
    const klines = makeNextOpenKlines();
    const result = runBacktest(
      { BTCUSDT: klines },
      makeLongCfg(),
      { ...ZERO_FEES, signalToNextOpen: true }
    );
    expect(result.config.signalToNextOpen).toBe(true);
  });

  it("signalToNextOpen=false -> result.config.signalToNextOpen = false", () => {
    const klines = makeNextOpenKlines();
    const result = runBacktest(
      { BTCUSDT: klines },
      makeLongCfg(),
      { ...ZERO_FEES, signalToNextOpen: false }
    );
    expect(result.config.signalToNextOpen).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 12. CLI parseArgs --next-open parameter
// ─────────────────────────────────────────────────────

describe("CLI parseArgs: --next-open parameter", () => {
  it("--next-open -> signalToNextOpen = true", () => {
    const args = parseBacktestArgs(["--next-open"]);
    expect(args.signalToNextOpen).toBe(true);
  });

  it("no --next-open -> signalToNextOpen = false (default)", () => {
    const args = parseBacktestArgs([]);
    expect(args.signalToNextOpen).toBe(false);
  });

  it("--next-open mixed with other parameters parses correctly", () => {
    const args = parseBacktestArgs(["--days", "30", "--next-open", "--spread", "5"]);
    expect(args.days).toBe(30);
    expect(args.signalToNextOpen).toBe(true);
    expect(args.spreadBps).toBe(5);
  });
});

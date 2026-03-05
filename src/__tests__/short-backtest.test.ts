/**
 * Short backtest layer tests
 * Note: warmupBars = max(MA.long=5, RSI.period=3) + 10 = 15
 *       Test klines must be > 15 bars, first 15 bars used for warmup
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─── Helpers ───────────────────────────────────────────

function makeKlines(closes: number[], startTime = 0): Kline[] {
  return closes.map((close, i) => ({
    openTime: startTime + i * 3600_000,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1000,
    closeTime: startTime + i * 3600_000 + 3599_000,
  }));
}

function makeKlineWithHL(close: number, high: number, low: number, time: number): Kline {
  return { openTime: time, open: close, high, low, close, volume: 1000, closeTime: time + 3599_000 };
}

/** Generate n flat warmup klines (at price), followed by trailingKlines */
function withWarmup(price: number, warmupCount: number, trailingKlines: Kline[]): Kline[] {
  const warmup = Array.from({ length: warmupCount }, (_, i) =>
    makeKlineWithHL(price, price * 1.002, price * 0.998, i * 3600_000)
  );
  const offset = warmupCount * 3600_000;
  const shifted = trailingKlines.map((k, i) => ({
    ...k,
    openTime: offset + i * 3600_000,
    closeTime: offset + i * 3600_000 + 3599_000,
  }));
  return [...warmup, ...shifted];
}

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
      name: "short-test",
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
    risk: {
      stop_loss_percent: overrides.stopLoss ?? 5,
      take_profit_percent: overrides.takeProfit ?? 10,
      trailing_stop: {
        enabled: overrides.trailingEnabled ?? false,
        activation_percent: overrides.trailingActivation ?? 5,
        callback_percent: overrides.trailingCallback ?? 2,
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

const OPTS = { initialUsdt: 1000, feeRate: 0, slippagePercent: 0 };

// ─── Basic short open/close ──────────────────────────────

describe("runBacktest - basic short flow", () => {
  it("Price decline: forced close after short open, generates profit (cover trades exist)", () => {
    // 15 flat warmup bars @100, then continuous decline -> MA3 < MA5 -> short signal
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const covers = result.trades.filter((t) => t.side === "cover");
    expect(covers.length).toBeGreaterThan(0);

    const totalPnl = covers.reduce((s, t) => s + t.pnl, 0);
    expect(totalPnl).toBeGreaterThan(0); // Price dropped, short profits
  });

  it("Short position closed with end_of_data at backtest end", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const endCovers = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "end_of_data"
    );
    expect(endCovers.length).toBeGreaterThan(0);
  });

  it("Price rise: no short during bullish trend (no short signal when ma_bullish)", () => {
    const trailingPrices = [101, 102, 103, 104, 105, 106, 107];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const shorts = result.trades.filter((t) => t.side === "short");
    expect(shorts).toHaveLength(0); // No short opening during uptrend
  });
});

// ─── Short stop loss (price rises above stop loss line) ─────────────────────

describe("runBacktest - short stop loss", () => {
  it("High price hits stop loss line after short open: triggers stop_loss, exits with loss", () => {
    // After 16 bars @100 warmup, bar 17 close=95 (MA3<MA5) triggers short open
    // entry~95, stopLoss=95*1.05=99.75
    // Bar 18 high=102 >= 99.75 -> triggers stop_loss
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // Short signal: MA3=(100+100+95)/3=98.3 < MA5=99
      makeKlineWithHL(95, 102, 90, 1), // High 102 >= stopLoss(99.75) -> stop_loss
    ];
    const klines = withWarmup(100, 16, trailingKlines);
    const cfg = makeShortCfg({ stopLoss: 5 });

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const stopLossExits = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    expect(stopLossExits.length).toBeGreaterThan(0);
    expect(stopLossExits[0]!.pnl).toBeLessThan(0); // Exits with loss
  });
});

// ─── Short take profit (price drops below take profit line) ─────────────────────

describe("runBacktest - short take profit", () => {
  it("Low price hits take profit line after short open: triggers take_profit, exits with profit", () => {
    // entry~95, takeProfit=95*0.9=85.5
    // Bar 18 low=84 <= 85.5 -> triggers take_profit
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // Short open entry~95
      makeKlineWithHL(95, 96, 84, 1),  // Low 84 <= takeProfit(85.5) -> take_profit
    ];
    const klines = withWarmup(100, 16, trailingKlines);
    const cfg = makeShortCfg({ takeProfit: 10 });

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const tpExits = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "take_profit"
    );
    expect(tpExits.length).toBeGreaterThan(0);
    expect(tpExits[0]!.pnl).toBeGreaterThan(0); // Exits with profit
  });
});

// ─── Short trailing stop ──────────────────────────────────

describe("runBacktest - short trailing stop", () => {
  it("Price drops to activate then rebounds: triggers trailing stop", () => {
    // 16 bars @100 warmup, close=95 triggers short open (entry~95)
    // bar1: low=88 (down 7.4% > activation threshold 5%, activated), high=96 (96>=88*1.02=89.76 -> triggered)
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // Short open entry~95
      makeKlineWithHL(90, 96, 88, 1),  // low=88 activated, high=96 > 89.76 -> trailing stop
    ];
    const klines = withWarmup(100, 16, trailingKlines);
    const cfg = makeShortCfg({
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: 2,
      takeProfit: 50,
    });

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const trailingExits = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "trailing_stop"
    );
    expect(trailingExits.length).toBeGreaterThan(0);
    expect(trailingExits[0]!.pnl).toBeGreaterThan(0); // Trailing stop also exits with profit
  });
});

// ─── perSymbol stats + metrics ───────────────────────

describe("runBacktest - perSymbol stats & metrics", () => {
  it("Cover trades counted in perSymbol trade stats", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const btcStats = result.perSymbol["BTCUSDT"]!;
    expect(btcStats.trades).toBeGreaterThan(0);
    expect(btcStats.pnl).toBeGreaterThan(0); // Short profits in declining market
  });

  it("metrics.totalReturn is positive when short profits", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);
    expect(result.metrics.totalReturn).toBeGreaterThan(0);
  });
});

// ─── Long backward compatibility ──────────────────────────────────

describe("runBacktest - long backward compatibility", () => {
  it("Pure long strategy does not produce cover trades", () => {
    const trailingPrices = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg: StrategyConfig = {
      ...makeShortCfg(),
      signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] },
    };

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    expect(result.trades.filter((t) => t.side === "cover")).toHaveLength(0);
    expect(result.trades.filter((t) => t.side === "short")).toHaveLength(0);
  });
});

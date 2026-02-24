/**
 * 空头回测层测试
 * 注意：warmupBars = max(MA.long=5, RSI.period=3) + 10 = 15
 *       测试 K 线必须 > 15 根，前 15 根用于预热
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─── 辅助 ───────────────────────────────────────────

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

/** 生成 n 根平稳预热 K 线（价格 price），再接 trailingKlines */
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

// ─── 基础空头开仓/平仓 ──────────────────────────────

describe("runBacktest - 空头基础流程", () => {
  it("价格下跌：开空后强制平仓，产生盈利（cover 交易存在）", () => {
    // 15根平稳预热@100，之后持续下跌 → MA3 < MA5 → short 信号
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const covers = result.trades.filter((t) => t.side === "cover");
    expect(covers.length).toBeGreaterThan(0);

    const totalPnl = covers.reduce((s, t) => s + t.pnl, 0);
    expect(totalPnl).toBeGreaterThan(0); // 价格跌了，空头赚钱
  });

  it("回测结束时空头仓位以 end_of_data 平仓", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const endCovers = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "end_of_data"
    );
    expect(endCovers.length).toBeGreaterThan(0);
  });

  it("价格上涨：多头趋势时不开空（ma_bullish 时无 short 信号）", () => {
    const trailingPrices = [101, 102, 103, 104, 105, 106, 107];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const shorts = result.trades.filter((t) => t.side === "short");
    expect(shorts).toHaveLength(0); // 上涨期不开空
  });
});

// ─── 空头止损（价格涨破止损线）─────────────────────

describe("runBacktest - 空头止损", () => {
  it("开空后高价触及止损线：触发 stop_loss，亏损出场", () => {
    // 16根@100预热后，第17根close=95（MA3<MA5）触发开空
    // entry≈95，stopLoss=95*1.05=99.75
    // 第18根高价=102 >= 99.75 → 触发 stop_loss
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // 开空信号：MA3=(100+100+95)/3=98.3 < MA5=99
      makeKlineWithHL(95, 102, 90, 1), // 高价102 >= stopLoss(99.75) → stop_loss
    ];
    const klines = withWarmup(100, 16, trailingKlines);
    const cfg = makeShortCfg({ stopLoss: 5 });

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const stopLossExits = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    expect(stopLossExits.length).toBeGreaterThan(0);
    expect(stopLossExits[0]!.pnl).toBeLessThan(0); // 亏损出场
  });
});

// ─── 空头止盈（价格跌破止盈线）─────────────────────

describe("runBacktest - 空头止盈", () => {
  it("开空后低价触及止盈线：触发 take_profit，盈利出场", () => {
    // entry≈95，takeProfit=95*0.9=85.5
    // 第18根低价=84 <= 85.5 → 触发 take_profit
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // 开空 entry≈95
      makeKlineWithHL(95, 96, 84, 1),  // 低价84 <= takeProfit(85.5) → take_profit
    ];
    const klines = withWarmup(100, 16, trailingKlines);
    const cfg = makeShortCfg({ takeProfit: 10 });

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const tpExits = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "take_profit"
    );
    expect(tpExits.length).toBeGreaterThan(0);
    expect(tpExits[0]!.pnl).toBeGreaterThan(0); // 盈利出场
  });
});

// ─── 空头追踪止损 ──────────────────────────────────

describe("runBacktest - 空头追踪止损", () => {
  it("价格下跌激活后反弹：触发追踪止损（trailing_stop）", () => {
    // 16根@100预热，close=95触发开空（entry≈95）
    // bar1: low=88（跌7.4%>激活阈值5%，激活），high=96（96>=88*1.02=89.76 → 触发）
    const trailingKlines = [
      makeKlineWithHL(95, 96, 94, 0),  // 开空 entry≈95
      makeKlineWithHL(90, 96, 88, 1),  // low=88激活，high=96 > 89.76 → 追踪止损
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
    expect(trailingExits[0]!.pnl).toBeGreaterThan(0); // 追踪止损也是有盈利的出场
  });
});

// ─── perSymbol 统计 + metrics ───────────────────────

describe("runBacktest - perSymbol 统计 & metrics", () => {
  it("cover 交易计入 perSymbol trades 统计", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);

    const btcStats = result.perSymbol["BTCUSDT"]!;
    expect(btcStats.trades).toBeGreaterThan(0);
    expect(btcStats.pnl).toBeGreaterThan(0); // 空头在下跌市场中盈利
  });

  it("空头盈利时 metrics.totalReturn 为正", () => {
    const trailingPrices = [98, 96, 94, 92, 90, 88, 86, 84, 82, 80];
    const klines = withWarmup(100, 16, makeKlines(trailingPrices));
    const cfg = makeShortCfg();

    const result = runBacktest({ BTCUSDT: klines }, cfg, OPTS);
    expect(result.metrics.totalReturn).toBeGreaterThan(0);
  });
});

// ─── 多头向后兼容 ──────────────────────────────────

describe("runBacktest - 多头向后兼容", () => {
  it("纯多头策略不产生 cover 交易", () => {
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

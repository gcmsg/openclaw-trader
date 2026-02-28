/**
 * Bid/Ask Spread 建模 — 回测测试
 *
 * 系统特性说明（与测试设计相关）：
 *  - doBuy 不设置 pos.side，长仓只能通过 stop_loss/take_profit/end_of_data 退出，
 *    不通过信号 sell（detectSignal 需要 positionSide==="long" 才返回 sell）
 *  - doOpenShort 不创建交易记录；doCoverShort 创建 cover 记录，
 *    其中 entryPrice = pos.entryPrice（开空时经过 spread 调整的价格）
 *
 * 测试覆盖：
 *  1. spread=0 时行为不变
 *  2. spread=5 时多头买入价更高（买在 ask）
 *  3. spread=5 时多头卖出价更低（卖在 bid）
 *  4. 空头开仓（cover.entryPrice）卖在 bid：spread=5 时更低
 *  5. 空头平仓（cover.exitPrice）买在 ask：spread=5 时更高
 *  6. spread + slippage 叠加计算正确
 *  7. 回测结果 spread 影响 PnL
 *  8. cfg.risk.spread_bps 配置来源
 *  9. BacktestResult.config.spreadBps 字段
 *  10. CLI parseArgs --spread 参数
 *
 * warmupBars = max(ma.long=5, rsi.period=3) + 10 = 15
 * 使用 16 根预热确保充足的指标热身期
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import { parseBacktestArgs } from "../backtest/cli-args.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─── 辅助函数 ───────────────────────────────────────

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

/** 生成预热 K 线 + 尾部 K 线（自动重写时间戳） */
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
 * 多头交易 K 线序列：
 *   16 根预热@100 → close=101 触发 ma_bullish（买入） → end_of_data@101 平仓
 *   入场/出场 close 均为 101，方便验证 spread 调整
 */
function makeLongOnlyKlines(): Kline[] {
  return withWarmup(100, 16, [makeKline(101, 0)]);
}

/**
 * 多头交易+下跌 K 线：
 *   买入@101，末根@90（end_of_data），入场和出场 close 不同
 */
function makeLongWithDropKlines(): Kline[] {
  return withWarmup(100, 16, [
    makeKline(101, 0), // buy signal
    makeKline(101, 1), // hold
    makeKline(90, 2),  // end_of_data at 90
  ]);
}

/**
 * 空头交易 K 线序列：
 *   16 根预热@100 → close=95 触发 ma_bearish（开空） → end_of_data@95 平仓
 *   入场/出场 close 均为 95
 */
function makeShortOnlyKlines(): Kline[] {
  return withWarmup(100, 16, [makeKline(95, 0)]);
}

/** 多头策略配置（fee=0, slippage 由 opts 控制） */
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
      stop_loss_percent: 50,      // 大止损，防止 end_of_data 前触发
      take_profit_percent: 200,   // 大止盈，防止被提前触发
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

/** 空头策略配置 */
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
// 1. spread=0 时行为不变
// ─────────────────────────────────────────────────────

describe("spread=0：行为不变", () => {
  it("spread=0 买入价 = close × 1（无额外成本）", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 0,
    });

    const buyTrade = result.trades.find((t) => t.side === "buy");
    expect(buyTrade).toBeDefined();
    expect(buyTrade!.entryPrice).toBeCloseTo(101, 6); // 无 slippage 无 spread → 恰好 close
  });

  it("spread=0 卖出价（end_of_data）= close × 1", () => {
    const klines = makeLongOnlyKlines(); // buy + end_of_data@101
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 0,
    });

    const sellTrade = result.trades.find((t) => t.side === "sell");
    expect(sellTrade).toBeDefined();
    expect(sellTrade!.exitPrice).toBeCloseTo(101, 6);
  });

  it("spreadBps=0 与不传 spreadBps 结果完全一致", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const rNone = runBacktest({ BTCUSDT: klines }, makeLongCfg(), ZERO_FEES);
    expect(r0.metrics.totalReturn).toBeCloseTo(rNone.metrics.totalReturn, 10);
  });
});

// ─────────────────────────────────────────────────────
// 2. spread=5：多头买在 ask（入场价更高）
// ─────────────────────────────────────────────────────

describe("spread=5：多头买在 ask", () => {
  it("买入价 = close × (1 + 5/20000)", () => {
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

  it("spread=5 买入价 > spread=0 买入价", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const buy0 = r0.trades.find((t) => t.side === "buy");
    const buy5 = r5.trades.find((t) => t.side === "buy");
    expect(buy5!.entryPrice).toBeGreaterThan(buy0!.entryPrice);
  });
});

// ─────────────────────────────────────────────────────
// 3. spread=5：多头卖在 bid（出场价更低）
// ─────────────────────────────────────────────────────

describe("spread=5：多头卖在 bid", () => {
  it("卖出价（end_of_data）= close × (1 - 5/20000)", () => {
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

  it("spread=5 卖出价 < spread=0 卖出价", () => {
    const klines = makeLongWithDropKlines(); // exit at close=90
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const sell0 = r0.trades.find((t) => t.side === "sell");
    const sell5 = r5.trades.find((t) => t.side === "sell");
    expect(sell5!.exitPrice).toBeLessThan(sell0!.exitPrice);
  });
});

// ─────────────────────────────────────────────────────
// 4. 空头开仓：卖在 bid（entryPrice 更低）
// ─────────────────────────────────────────────────────

describe("空头开仓：卖在 bid", () => {
  it("开空 entryPrice（cover.entryPrice）= close × (1 - 5/20000)", () => {
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

  it("spread=5 开空 entryPrice < spread=0 开空 entryPrice", () => {
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
// 5. 空头平仓：买在 ask（exitPrice 更高）
// ─────────────────────────────────────────────────────

describe("空头平仓：买在 ask", () => {
  it("平空 exitPrice（cover.exitPrice）= close × (1 + 5/20000)", () => {
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

  it("spread=5 平空 exitPrice > spread=0 平空 exitPrice", () => {
    const klines = makeShortOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const cover0 = r0.trades.find((t) => t.side === "cover");
    const cover5 = r5.trades.find((t) => t.side === "cover");
    expect(cover5!.exitPrice).toBeGreaterThan(cover0!.exitPrice);
  });
});

// ─────────────────────────────────────────────────────
// 6. spread + slippage 叠加
// ─────────────────────────────────────────────────────

describe("spread + slippage 叠加", () => {
  it("多头买入：execPrice = close × (1 + slip/100 + spread/20000)", () => {
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

  it("多头卖出：execPrice = close × (1 - slip/100 - spread/20000)", () => {
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

  it("spread=0 slippage=0.05 与 slippagePercent=0.05 无 spread 结果一致", () => {
    const klines = makeLongOnlyKlines();
    const rA = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000, feeRate: 0, slippagePercent: 0.05, spreadBps: 0,
    });
    const rB = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      initialUsdt: 1000, feeRate: 0, slippagePercent: 0.05,
    });
    expect(rA.metrics.totalReturn).toBeCloseTo(rB.metrics.totalReturn, 10);
  });

  it("空头开仓：execPrice = close × (1 - slip/100 - spread/20000)", () => {
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

  it("空头平仓：execPrice = close × (1 + slip/100 + spread/20000)", () => {
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
// 7. spread 影响 PnL
// ─────────────────────────────────────────────────────

describe("spread 影响 PnL", () => {
  it("多头：spread=5 时总收益 < spread=0", () => {
    // 买@101 卖@101：spread=0 时 PnL≈0，spread=5 时 PnL < 0（来回 spread 成本）
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });
    expect(r5.metrics.totalReturn).toBeLessThan(r0.metrics.totalReturn);
  });

  it("空头：spread=5 时总收益 < spread=0", () => {
    // 开空@95 平空@95：spread=0 时 PnL≈0，spread=5 时双边 spread 导致亏损
    const klines = makeShortOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeShortCfg(), { ...ZERO_FEES, spreadBps: 5 });
    expect(r5.metrics.totalReturn).toBeLessThan(r0.metrics.totalReturn);
  });

  it("spread 越大，PnL 损失越多（单调递减）", () => {
    const klines = makeLongOnlyKlines();
    const r0 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 0 });
    const r5 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });
    const r20 = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 20 });
    expect(r0.metrics.totalReturn).toBeGreaterThan(r5.metrics.totalReturn);
    expect(r5.metrics.totalReturn).toBeGreaterThan(r20.metrics.totalReturn);
  });
});

// ─────────────────────────────────────────────────────
// 8. cfg.risk.spread_bps 配置来源
// ─────────────────────────────────────────────────────

describe("cfg.risk.spread_bps 配置来源", () => {
  it("cfg.risk.spread_bps=5 与 opts.spreadBps=5 等价（买入价相同）", () => {
    const klines = makeLongOnlyKlines();
    const rCfg = runBacktest({ BTCUSDT: klines }, makeLongCfg(5), ZERO_FEES);
    const rOpts = runBacktest({ BTCUSDT: klines }, makeLongCfg(), { ...ZERO_FEES, spreadBps: 5 });

    const buyCfg = rCfg.trades.find((t) => t.side === "buy");
    const buyOpts = rOpts.trades.find((t) => t.side === "buy");
    expect(buyCfg!.entryPrice).toBeCloseTo(buyOpts!.entryPrice, 8);
  });

  it("opts.spreadBps 优先级高于 cfg.risk.spread_bps", () => {
    const klines = makeLongOnlyKlines();
    // cfg=10 bps, opts=5 bps → 以 opts=5 为准
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
  it("result.config.spreadBps 返回传入的 spreadBps 值", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), {
      ...ZERO_FEES,
      spreadBps: 7,
    });
    expect(result.config.spreadBps).toBe(7);
  });

  it("未传 spreadBps 时 result.config.spreadBps 为 0", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(), ZERO_FEES);
    expect(result.config.spreadBps).toBe(0);
  });

  it("通过 cfg.risk.spread_bps 配置时 result.config.spreadBps 正确", () => {
    const klines = makeLongOnlyKlines();
    const result = runBacktest({ BTCUSDT: klines }, makeLongCfg(3), ZERO_FEES);
    expect(result.config.spreadBps).toBe(3);
  });
});

// ─────────────────────────────────────────────────────
// 10. CLI parseArgs --spread 参数解析
// ─────────────────────────────────────────────────────

describe("CLI parseArgs：--spread 参数", () => {
  it("--spread 5 → spreadBps = 5", () => {
    const args = parseBacktestArgs(["--spread", "5"]);
    expect(args.spreadBps).toBe(5);
  });

  it("--spread 10.5 → spreadBps = 10.5", () => {
    const args = parseBacktestArgs(["--spread", "10.5"]);
    expect(args.spreadBps).toBeCloseTo(10.5, 5);
  });

  it("无 --spread → spreadBps = 0（默认值）", () => {
    const args = parseBacktestArgs([]);
    expect(args.spreadBps).toBe(0);
  });

  it("--spread 0 → spreadBps = 0", () => {
    const args = parseBacktestArgs(["--spread", "0"]);
    expect(args.spreadBps).toBe(0);
  });

  it("--spread 与其他参数混合解析正确", () => {
    const args = parseBacktestArgs(["--days", "30", "--spread", "5", "--no-save"]);
    expect(args.days).toBe(30);
    expect(args.spreadBps).toBe(5);
    expect(args.save).toBe(false);
  });
});

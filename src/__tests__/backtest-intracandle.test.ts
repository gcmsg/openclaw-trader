/**
 * P6.3 — 回测蜡烛内模拟（Intra-candle Simulation）测试
 *
 * 测试场景：
 * - 同一根 K 线内 low 触及止损（多头应触发）
 * - 同一根 K 线内 high 触及止盈（多头应触发）
 * - 同一根 K 线内 low 触及止损且 high 触及止盈（止损优先）
 * - 空头镜像测试（high 触止损、low 触止盈、优先级）
 * - 追踪止损用 kline.high/low 更新（intracandle 模式）
 * - intracandle=false 向后兼容模式
 * - 时间止损
 *
 * 注意：warmupBars = max(MA.long=5, RSI.period=3) + 10 = 15
 *       入场信号 kline 后的"测试 kline"的 close 值经过精心设计以防止重新入场
 *       （当 MA3 ≈ MA5 时不触发 ma_bullish/ma_bearish）
 */

import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────

/** 创建一根自定义 K 线（open 与 close 相同） */
function makeKline(close: number, high: number, low: number, time: number): Kline {
  return { openTime: time, open: close, high, low, close, volume: 1000, closeTime: time + 3599_000 };
}

/** 创建一根平稳 K 线（high/low 紧贴 close ±0.1%） */
function flatKline(price: number, time: number): Kline {
  return makeKline(price, price * 1.001, price * 0.999, time);
}

/**
 * 创建 warmupCount 根平稳预热 K 线 + 后续 K 线（时间步长 1h）
 * extras 数组中每根 K 线的时间由索引决定（传入的 time 参数被忽略，重写为 offset + i*1h）
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
 * 多头策略配置
 * signal: ma_bullish = MA3 > MA5 → 买入；ma_bearish = MA3 < MA5 → 卖出
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

/** 空头策略配置 */
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

// 零手续费/滑点（测试时消除变量）
const ZERO_FEES = { initialUsdt: 1000, feeRate: 0, slippagePercent: 0 };

// ─────────────────────────────────────────────────────
// 多头测试
// ─────────────────────────────────────────────────────

describe("P6.3 多头 — intracandle=true（默认）", () => {
  /**
   * 测试 1: 同一根 K 线内 low 触及止损（应触发）
   *
   * 入场价 = 101（warmup at 100，kline[15] close=101 触发 ma_bullish）
   * stopLoss = 101 * 0.95 = 95.95
   *
   * 测试 kline close=98（< 101 使 MA3 < MA5，防重新入场）
   *   high=100（高于止损，close 模式不触发）
   *   low=94（低于止损，intracandle 应触发）
   * 期望: stop_loss 触发，exitPrice ≈ 95.95
   */
  it("多头: 同一根K线 low 触及止损（close 未触及，intracandle 应触发）", () => {
    const entryPrice = 101;
    const stopLossPct = 5;
    const stopLossPrice = entryPrice * (1 - stopLossPct / 100); // 95.95

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),                     // kline[15]: ma_bullish → 开多 at 101
      makeKline(98, 100, 94, 3_600_000),     // kline[16]: close=98, low=94 < 95.95 → 止损
    ]);

    const cfg = makeLongCfg({ stopLoss: stopLossPct });
    const result = runBacktest({ BTCUSDT: klines }, cfg, ZERO_FEES);

    // 按原因过滤（不依赖总数量，防止重新入场后 end_of_data 干扰）
    const stopLossTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "stop_loss"
    );
    expect(stopLossTrades.length).toBeGreaterThanOrEqual(1);
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
  });

  /**
   * 测试 2: 同一根 K 线内 high 触及止盈（应触发）
   *
   * 入场价 = 101，takeProfit = 101 * 1.10 = 111.1
   *
   * 测试 kline close=97（MA3 < MA5 防重新入场）
   *   high=115（超过 111.1，intracandle 止盈）
   *   low=96（不触止损）
   * 期望: take_profit 触发，exitPrice ≈ 111.1
   */
  it("多头: 同一根K线 high 触及止盈（close 未触及，intracandle 应触发）", () => {
    const entryPrice = 101;
    const takeProfitPct = 10;
    const takeProfitPrice = entryPrice * (1 + takeProfitPct / 100); // 111.1

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(97, 115, 96, 3_600_000),   // close=97, high=115 > 111.1 → 止盈
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
   * 测试 3: 同一根 K 线内 low 触止损 且 high 触止盈 → 止损优先（保守模型）
   *
   * 测试 kline: close=105（MA3>MA5，可能重新入场，用 stop_loss 验证）
   *   high=115（> takeProfit=111.1）
   *   low=94（< stopLoss=95.95）
   * 期望：stop_loss 触发，且无 take_profit 交易（首次出场应为止损）
   */
  it("多头: 同一根K线 low触止损 + high触止盈 → 止损优先（保守假设）", () => {
    const entryPrice = 101;
    const stopLossPrice = entryPrice * (1 - 5 / 100);    // 95.95
    const takeProfitPrice = entryPrice * (1 + 10 / 100); // 111.1

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      // close=105, high=115 > 111.1, low=94 < 95.95 → 止损优先
      makeKline(105, 115, 94, 3_600_000),
      flatKline(100, 7_200_000), // 止损后无重新入场 kline
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
    // 首次出场应为止损，不应有止盈
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
    expect(takeProfitTrades.length).toBe(0); // 不应触发止盈（止损优先）
    expect(stopLossTrades[0]?.exitPrice).not.toBeCloseTo(takeProfitPrice, 0);
  });

  /**
   * 测试 4: intracandle=false 向后兼容 — close 未触及止损 → 不触发
   *
   * 同样的 kline（low < stopLoss），但 intracandle=false 时用 close 判断
   * close=98 > stopLoss=95.95 → 不触发止损
   * 期望：无 stop_loss 交易，有 end_of_data 平仓
   */
  it("多头: intracandle=false 时 close 未触止损 → 不触发（向后兼容）", () => {
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(98, 100, 94, 3_600_000),  // close=98 > stopLoss，low=94 < stopLoss
    ]);

    const cfg = makeLongCfg({ stopLoss: 5 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "sell" && t.exitReason === "stop_loss"
    );
    // close 模式下止损不触发
    expect(stopLossTrades.length).toBe(0);
    // 有 end_of_data 平仓（position 保持到最后）
    const endTrades = result.trades.filter((t) => t.exitReason === "end_of_data");
    expect(endTrades.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * 测试 5: 多头追踪止损用 kline.high 更新 highestPrice
   *
   * 入场价 101，trailingActivation=5%，callback=3%
   * kline[16]: high=108 → 涨幅 6.9% >= 5% → 激活追踪止损
   *   → stopPrice = 108 * 0.97 = 104.76
   *   → low=103 <= 104.76 → 追踪止损触发
   * close=97 确保 MA3 < MA5，防重新入场
   */
  it("多头: 追踪止损用 kline.high 更新 highestPrice（intracandle 模式）", () => {
    const highestPrice = 108;
    const callbackPct = 3;
    const expectedStopPrice = highestPrice * (1 - callbackPct / 100); // 104.76

    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      // close=97（MA3<MA5，防重新入场），high=108（激活追踪），low=103（触发追踪）
      makeKline(97, 108, 103, 3_600_000),
    ]);

    const cfg = makeLongCfg({
      stopLoss: 20,        // 止损设远，避免提前触发
      takeProfit: 50,      // 止盈设高，避免提前触发
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
   * 测试 6: 时间止损（time_stop_hours）
   *
   * 持仓 3h 后价格无盈利（pnlPct=0 <= 0）→ 时间止损触发
   * flatKline(101) 序列：MA3 与 MA5 均趋近 101，不触发重新入场
   */
  it("多头: time_stop_hours 触发时间止损（持仓超时且无盈利）", () => {
    const timeStopHours = 3;
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),          // extras[0]: 开仓
      flatKline(101, 3_600_000),  // extras[1]: 1h
      flatKline(101, 7_200_000),  // extras[2]: 2h
      flatKline(101, 10_800_000), // extras[3]: 3h（holdMs=3h, pnlPct=0 → 时间止损）
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
// 空头测试
// ─────────────────────────────────────────────────────

describe("P6.3 空头 — intracandle=true（默认）", () => {
  /**
   * 测试 7: 空头 — high 触及止损（intracandle 应触发）
   *
   * 空头入场价 = 99（warmup at 100，kline[15] close=99 触发 ma_bearish）
   * stopLoss = 99 * 1.05 = 103.95（价格涨破 = 止损）
   *
   * 测试 kline: close=101（MA3=MA5=100，无重新入场信号）
   *   high=105（> 103.95，intracandle 止损）
   *   low=98（不触止盈）
   */
  it("空头: 同一根K线 high 触及止损（close 未触及，intracandle 应触发）", () => {
    const entryPrice = 99;
    const stopLossPct = 5;
    const stopLossPrice = entryPrice * (1 + stopLossPct / 100); // 103.95

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),                    // kline[15]: ma_bearish → 开空 at 99
      makeKline(101, 105, 98, 3_600_000),  // close=101, high=105 > 103.95 → 止损
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
   * 测试 8: 空头 — low 触及止盈（intracandle 应触发）
   *
   * 空头入场价 = 99，takeProfit = 99 * 0.90 = 89.1（价格跌破 = 止盈）
   *
   * 测试 kline: close=101（MA3=MA5=100，无重新入场）
   *   high=95（不触止损）
   *   low=88（< 89.1，intracandle 止盈）
   */
  it("空头: 同一根K线 low 触及止盈（close 未到，intracandle 应触发）", () => {
    const entryPrice = 99;
    const takeProfitPct = 10;
    const takeProfitPrice = entryPrice * (1 - takeProfitPct / 100); // 89.1

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      makeKline(101, 95, 88, 3_600_000),  // close=101, low=88 < 89.1 → 止盈
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
   * 测试 9: 空头 — high 触止损 且 low 触止盈 → 止损优先
   *
   * 测试 kline: close=105（MA3>MA5，阻止重新入空）
   *   high=106（> stopLoss=103.95）
   *   low=87（< takeProfit=89.1）
   * 期望：stop_loss 触发（优先），不应有 take_profit 交易
   */
  it("空头: 同一根K线 high触止损 + low触止盈 → 止损优先（保守假设）", () => {
    const entryPrice = 99;
    const stopLossPrice = entryPrice * (1 + 5 / 100);    // 103.95
    const takeProfitPrice = entryPrice * (1 - 10 / 100); // 89.1

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      // close=105(MA3>MA5), high=106>103.95, low=87<89.1 → 止损优先
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
    expect(takeProfitTrades.length).toBe(0); // 止损优先，不应有止盈
    expect(stopLossTrades[0]?.exitPrice).toBeCloseTo(stopLossPrice, 1);
    expect(stopLossTrades[0]?.exitPrice).not.toBeCloseTo(takeProfitPrice, 0);
  });

  /**
   * 测试 10: 空头 intracandle=false — close 未触止损 → 不触发
   *
   * kline high=105 > stopLoss=103.95，但 close=101 < stopLoss → intracandle=false 不触发
   */
  it("空头: intracandle=false 时 close 未触止损 → 不触发（向后兼容）", () => {
    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      makeKline(101, 105, 98, 3_600_000),  // close=101 < 103.95，high=105 > 103.95
    ]);

    const cfg = makeShortCfg({ stopLoss: 5 });
    const result = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossTrades = result.trades.filter(
      (t) => t.side === "cover" && t.exitReason === "stop_loss"
    );
    // close 模式下止损不触发（close=101 < stopLoss=103.95）
    expect(stopLossTrades.length).toBe(0);
  });

  /**
   * 测试 11: 空头追踪止损用 kline.low 更新 lowestPrice
   *
   * 入场价 99，activation=5%，callback=3%
   * kline[16]: low=93 → 跌幅 = (99-93)/99 ≈ 6% >= 5% → 激活追踪止损
   *   → stopPrice = 93 * 1.03 = 95.79
   *   → high=96 >= 95.79 → 追踪止损触发
   * close=101（MA3=MA5，无重新入场）
   */
  it("空头: 追踪止损用 kline.low 更新 lowestPrice（intracandle 模式）", () => {
    const lowestPrice = 93;
    const callbackPct = 3;
    const expectedStopPrice = lowestPrice * (1 + callbackPct / 100); // 95.79

    const klines = buildKlines(100, 15, [
      flatKline(99, 0),
      // close=101(MA3=MA5，无信号), low=93（激活追踪，gain≈6%）, high=96（触发追踪，96>=95.79）
      makeKline(101, 96, 93, 3_600_000),
    ]);

    const cfg = makeShortCfg({
      stopLoss: 30,        // 止损设远，避免提前触发
      takeProfit: 50,      // 止盈设远，避免提前触发
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
// intracandle 对比测试
// ─────────────────────────────────────────────────────

describe("P6.3 — intracandle 行为对比（true vs false）", () => {
  /**
   * 测试 12: 相同 klines，intracandle=true 触发止损，intracandle=false 不触发
   *
   * kline: close=98, high=100, low=94（low < stopLoss=95.95，close > stopLoss）
   */
  it("intracandle=true 触发止损 vs intracandle=false 不触发", () => {
    const klines = buildKlines(100, 15, [
      flatKline(101, 0),
      makeKline(98, 100, 94, 3_600_000),  // close=98 > 95.95 > low=94
    ]);
    const cfg = makeLongCfg({ stopLoss: 5 });

    const resultOn  = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: true });
    const resultOff = runBacktest({ BTCUSDT: klines }, cfg, { ...ZERO_FEES, intracandle: false });

    const stopLossOn  = resultOn.trades.filter((t) => t.side === "sell" && t.exitReason === "stop_loss");
    const stopLossOff = resultOff.trades.filter((t) => t.side === "sell" && t.exitReason === "stop_loss");

    expect(stopLossOn.length).toBeGreaterThanOrEqual(1);  // intracandle=true: 止损触发
    expect(stopLossOff.length).toBe(0);                   // intracandle=false: close=98 > stopLoss，不触发
  });
});

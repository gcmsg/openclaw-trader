/**
 * 回测指标计算单元测试
 */

import { describe, it, expect } from "vitest";
import { calculateMetrics } from "../backtest/metrics.js";
import type { BacktestTrade, EquityPoint } from "../backtest/metrics.js";

// ─────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────

function makeSellTrade(
  symbol: string,
  pnl: number,
  pnlPercent: number,
  exitReason: BacktestTrade["exitReason"] = "signal",
  holdingHours = 8
): BacktestTrade {
  const now = Date.now();
  return {
    symbol,
    side: "sell",
    entryTime: now - holdingHours * 3_600_000,
    exitTime: now,
    entryPrice: 100,
    exitPrice: 100 * (1 + pnlPercent),
    quantity: 1,
    cost: 100,
    proceeds: 100 + pnl,
    pnl,
    pnlPercent,
    exitReason,
  };
}

function makeEquityCurve(values: number[]): EquityPoint[] {
  return values.map((equity, i) => ({ time: i * 3_600_000, equity }));
}

// ─────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────

describe("calculateMetrics — 基础统计", () => {
  it("空交易时返回零值", () => {
    const m = calculateMetrics([], 1000, makeEquityCurve([1000]));
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.totalReturn).toBe(0);
    expect(m.totalReturnPercent).toBe(0);
    expect(m.sharpeRatio).toBe(0);
    expect(m.maxDrawdown).toBe(0);
  });

  it("全部盈利交易", () => {
    const trades = [
      makeSellTrade("BTCUSDT", 10, 0.1),
      makeSellTrade("ETHUSDT", 20, 0.2),
      makeSellTrade("BNBUSDT", 5, 0.05),
    ];
    const equity = makeEquityCurve([1000, 1010, 1030, 1035]);
    const m = calculateMetrics(trades, 1000, equity);

    expect(m.totalTrades).toBe(3);
    expect(m.wins).toBe(3);
    expect(m.losses).toBe(0);
    expect(m.winRate).toBe(1);
    expect(m.totalReturn).toBe(35); // 1035 - 1000
    expect(m.totalReturnPercent).toBeCloseTo(3.5);
    expect(m.profitFactor).toBe(Infinity);
    expect(m.stopLossCount).toBe(0);
  });

  it("全部亏损交易", () => {
    const trades = [
      makeSellTrade("BTCUSDT", -10, -0.1, "stop_loss"),
      makeSellTrade("ETHUSDT", -15, -0.15, "stop_loss"),
    ];
    const equity = makeEquityCurve([1000, 990, 975]);
    const m = calculateMetrics(trades, 1000, equity);

    expect(m.totalTrades).toBe(2);
    expect(m.wins).toBe(0);
    expect(m.losses).toBe(2);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.stopLossCount).toBe(2);
  });

  it("混合交易：胜率和盈亏比正确", () => {
    const trades = [
      makeSellTrade("BTC", 20, 0.2), // 赢
      makeSellTrade("ETH", -10, -0.1), // 输
      makeSellTrade("BNB", 30, 0.3), // 赢
      makeSellTrade("SOL", -5, -0.05), // 输
    ];
    const equity = makeEquityCurve([1000, 1020, 1010, 1040, 1035]);
    const m = calculateMetrics(trades, 1000, equity);

    expect(m.totalTrades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(2);
    expect(m.winRate).toBe(0.5);

    // 利润因子 = 总盈(50) / 总亏(15) ≈ 3.33
    expect(m.profitFactor).toBeCloseTo(50 / 15, 1);

    // 均盈 = (20% + 30%) / 2 = 25%
    expect(m.avgWinPercent).toBeCloseTo(25);
    // 均亏 = (10% + 5%) / 2 = 7.5%
    expect(m.avgLossPercent).toBeCloseTo(7.5);
    // 盈亏比 = 25 / 7.5 ≈ 3.33
    expect(m.winLossRatio).toBeCloseTo(25 / 7.5, 1);
  });
});

describe("calculateMetrics — 最大回撤", () => {
  it("无回撤时为 0", () => {
    const m = calculateMetrics([], 1000, makeEquityCurve([1000, 1010, 1020, 1030]));
    expect(m.maxDrawdown).toBe(0);
  });

  it("单次 50% 回撤", () => {
    // 1000 → 2000 → 1000（回撤 50%）
    const m = calculateMetrics([], 1000, makeEquityCurve([1000, 1500, 2000, 1500, 1000]));
    expect(m.maxDrawdown).toBeCloseTo(50, 0); // 50%
    expect(m.maxDrawdownUsdt).toBeCloseTo(1000, 0);
  });

  it("多峰取最大回撤", () => {
    // 峰1: 1200→1000 (16.7%)，峰2: 1500→1100 (26.7%)
    const equity = [1000, 1200, 1000, 1300, 1500, 1100];
    const m = calculateMetrics([], 1000, makeEquityCurve(equity));
    // 最大回撤应约为 26.7%
    expect(m.maxDrawdown).toBeGreaterThan(25);
    expect(m.maxDrawdown).toBeLessThan(28);
  });
});

describe("calculateMetrics — 出场原因统计", () => {
  it("各类出场原因正确计数", () => {
    const trades = [
      makeSellTrade("BTC", 10, 0.1, "signal"),
      makeSellTrade("ETH", 15, 0.15, "take_profit"),
      makeSellTrade("BNB", -5, -0.05, "stop_loss"),
      makeSellTrade("SOL", 8, 0.08, "trailing_stop"),
      makeSellTrade("XRP", 3, 0.03, "end_of_data"),
    ];
    const m = calculateMetrics(trades, 1000, makeEquityCurve([1000, 1031]));

    expect(m.signalExitCount).toBe(1);
    expect(m.takeProfitCount).toBe(1);
    expect(m.stopLossCount).toBe(1);
    expect(m.trailingStopCount).toBe(1);
    expect(m.endOfDataCount).toBe(1);
    expect(m.totalTrades).toBe(5);
  });
});

describe("calculateMetrics — 极值", () => {
  it("最佳和最差交易", () => {
    const trades = [
      makeSellTrade("BTC", 50, 0.5),
      makeSellTrade("ETH", -30, -0.3),
      makeSellTrade("BNB", 10, 0.1),
    ];
    const m = calculateMetrics(trades, 1000, makeEquityCurve([1000, 1030]));

    expect(m.bestTradePct).toBeCloseTo(50); // 50%
    expect(m.worstTradePct).toBeCloseTo(-30); // -30%
  });
});

describe("calculateMetrics — 平均持仓时长", () => {
  it("正确计算平均持仓小时数", () => {
    const trades = [
      makeSellTrade("BTC", 10, 0.1, "signal", 4), // 4h
      makeSellTrade("ETH", -5, -0.05, "signal", 12), // 12h
      makeSellTrade("BNB", 8, 0.08, "signal", 8), // 8h
    ];
    const m = calculateMetrics(trades, 1000, makeEquityCurve([1000, 1013]));

    expect(m.avgHoldingHours).toBeCloseTo(8, 0); // (4+12+8)/3 = 8
  });
});

describe("calculateMetrics — 夏普比率", () => {
  it("稳定上涨时夏普为正", () => {
    // 权益单调上涨，正夏普
    const equity = [1000, 1010, 1020, 1030, 1040, 1050];
    const m = calculateMetrics([], 1000, makeEquityCurve(equity));
    expect(m.sharpeRatio).toBeGreaterThan(0);
  });

  it("持续下跌时夏普为负", () => {
    const equity = [1000, 990, 980, 970, 960];
    const m = calculateMetrics([], 1000, makeEquityCurve(equity));
    expect(m.sharpeRatio).toBeLessThan(0);
  });

  it("权益不变时夏普为 0", () => {
    const equity = [1000, 1000, 1000, 1000];
    const m = calculateMetrics([], 1000, makeEquityCurve(equity));
    expect(m.sharpeRatio).toBe(0);
  });
});

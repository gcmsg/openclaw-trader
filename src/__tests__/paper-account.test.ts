import { describe, it, expect, beforeEach } from "vitest";
import {
  paperBuy,
  paperSell,
  calcTotalEquity,
  getAccountSummary,
  updateTrailingStop,
  type PaperAccount,
  type PaperPosition,
} from "../paper/account.js";

// 无滑点的默认配置（让计算保持整洁）
const NO_SLIP = { slippagePercent: 0, feeRate: 0.001 };

// ─────────────────────────────────────────────────────
// 测试辅助：创建干净的虚拟账户（不读写文件）
// ─────────────────────────────────────────────────────

function makeAccount(overrides: Partial<PaperAccount> = {}): PaperAccount {
  return {
    initialUsdt: 1000,
    usdt: 1000,
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// paperBuy
// ─────────────────────────────────────────────────────

describe("paperBuy()", () => {
  let account: PaperAccount;
  beforeEach(() => { account = makeAccount(); });

  it("成功买入后 USDT 减少、持仓增加", () => {
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade).not.toBeNull();
    expect(account.usdt).toBeLessThan(1000);
    expect(account.positions["BTCUSDT"]).toBeDefined();
  });

  it("买入金额 = 总资产 * positionRatio", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    // 总资产 1000 * 20% = 200 USDT
    expect(account.usdt).toBeCloseTo(1000 - 200, 1);
  });

  it("持仓数量 = (投入 - 手续费) / 价格", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const pos = account.positions["BTCUSDT"];
    const spent = 200;
    const expectedQty = (spent * (1 - 0.001)) / 50000;
    expect(pos.quantity).toBeCloseTo(expectedQty, 8);
  });

  it("买入时设置止损价格（默认 5%）", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, stopLossPercent: 5, ...NO_SLIP });
    const pos = account.positions["BTCUSDT"];
    expect(pos.stopLoss).toBeCloseTo(50000 * 0.95, 0);
  });

  it("买入时设置止盈价格（默认 15%）", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, takeProfitPercent: 15, ...NO_SLIP });
    const pos = account.positions["BTCUSDT"];
    expect(pos.takeProfit).toBeCloseTo(50000 * 1.15, 0);
  });

  it("同一币种已有持仓时不重复买入", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const trade2 = paperBuy(account, "BTCUSDT", 48000, "test2", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade2).toBeNull();
    expect(account.usdt).toBeCloseTo(800, 1);
  });

  it("余额不足时不买入", () => {
    account.usdt = 0;
    account.initialUsdt = 0;
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade).toBeNull();
  });

  it("低于最小下单金额时不买入", () => {
    account.usdt = 30;
    account.initialUsdt = 30;
    // 30 * 20% = 6 USDT < minOrderUsdt=10
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, minOrderUsdt: 10, ...NO_SLIP });
    expect(trade).toBeNull();
  });

  it("买入后添加到 trades 记录", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(account.trades).toHaveLength(1);
    expect(account.trades[0].side).toBe("buy");
    expect(account.trades[0].symbol).toBe("BTCUSDT");
  });

  it("可以买入不同币种", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    paperBuy(account, "ETHUSDT", 2000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(Object.keys(account.positions)).toHaveLength(2);
  });

  it("滑点使成交价略高于当前价", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, slippagePercent: 0.1, feeRate: 0 });
    const pos = account.positions["BTCUSDT"];
    // 滑点 0.1% → execPrice = 50050
    expect(pos.entryPrice).toBeCloseTo(50050, 0);
  });
});

// ─────────────────────────────────────────────────────
// paperSell
// ─────────────────────────────────────────────────────

describe("paperSell()", () => {
  let account: PaperAccount;
  beforeEach(() => {
    account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "setup", { positionRatio: 0.2, ...NO_SLIP });
  });

  it("卖出后持仓清空、USDT 增加", () => {
    const usdtBefore = account.usdt;
    paperSell(account, "BTCUSDT", 55000, "sell test", NO_SLIP);
    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(account.usdt).toBeGreaterThan(usdtBefore);
  });

  it("没有持仓时卖出返回 null", () => {
    const trade = paperSell(account, "ETHUSDT", 2000, "test", NO_SLIP);
    expect(trade).toBeNull();
  });

  it("盈利交易：pnl > 0", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test", NO_SLIP);
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeGreaterThan(0);
    expect(trade!.pnlPercent).toBeGreaterThan(0);
  });

  it("亏损交易：pnl < 0，dailyLoss 累计增加", () => {
    const trade = paperSell(account, "BTCUSDT", 40000, "test", NO_SLIP);
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeLessThan(0);
    expect(account.dailyLoss.loss).toBeGreaterThan(0);
  });

  it("卖出手续费从收入中扣除", () => {
    const pos = account.positions["BTCUSDT"];
    const grossUsdt = pos.quantity * 50000;
    const expectedFee = grossUsdt * 0.001;
    const trade = paperSell(account, "BTCUSDT", 50000, "test", NO_SLIP);
    expect(trade!.fee).toBeCloseTo(expectedFee, 4);
  });

  it("卖出后添加到 trades 记录", () => {
    paperSell(account, "BTCUSDT", 55000, "test", NO_SLIP);
    const sells = account.trades.filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].pnl).toBeDefined();
  });

  it("盈亏百分比计算正确（约 +20%，扣除双边手续费）", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test", NO_SLIP);
    // 50000 → 60000 = +20%，扣除买卖各 0.1% 约 19.8%
    expect(trade!.pnlPercent!).toBeCloseTo(0.198, 1);
  });

  it("滑点使卖出成交价略低于当前价", () => {
    const trade = paperSell(account, "BTCUSDT", 50000, "test", { slippagePercent: 0.1, feeRate: 0 });
    // 滑点 0.1% → execPrice = 49950
    expect(trade!.price).toBeCloseTo(49950, 0);
  });
});

// ─────────────────────────────────────────────────────
// calcTotalEquity
// ─────────────────────────────────────────────────────

describe("calcTotalEquity()", () => {
  it("无持仓时 = USDT 余额", () => {
    const account = makeAccount({ usdt: 500 });
    expect(calcTotalEquity(account, {})).toBe(500);
  });

  it("有持仓时 = USDT + 持仓市值", () => {
    const account = makeAccount({ usdt: 1000, initialUsdt: 1000 });
    paperBuy(account, "ETHUSDT", 2000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const equity = calcTotalEquity(account, { ETHUSDT: 2500 });
    expect(equity).toBeGreaterThan(1000);
  });

  it("币种价格未提供时跳过该持仓", () => {
    const account = makeAccount({ usdt: 800 });
    paperBuy(account, "ETHUSDT", 2000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const equity = calcTotalEquity(account, {});
    expect(equity).toBe(account.usdt);
  });
});

// ─────────────────────────────────────────────────────
// getAccountSummary
// ─────────────────────────────────────────────────────

describe("getAccountSummary()", () => {
  it("初始账户盈亏为 0", () => {
    const account = makeAccount();
    const summary = getAccountSummary(account, {});
    expect(summary.totalPnl).toBe(0);
    expect(summary.totalPnlPercent).toBe(0);
  });

  it("无交易时胜率为 0", () => {
    const account = makeAccount();
    const summary = getAccountSummary(account, {});
    expect(summary.winRate).toBe(0);
  });

  it("胜率计算：2胜1负 = 66.7%", () => {
    const account = makeAccount();
    account.trades = [
      { id: "1", symbol: "A", side: "sell", quantity: 1, price: 110, usdtAmount: 109.89, fee: 0.11, slippage: 0, timestamp: 1, reason: "", pnl: 9, pnlPercent: 0.09 },
      { id: "2", symbol: "B", side: "sell", quantity: 1, price: 90, usdtAmount: 89.91, fee: 0.09, slippage: 0, timestamp: 2, reason: "", pnl: -11, pnlPercent: -0.11 },
      { id: "3", symbol: "C", side: "sell", quantity: 1, price: 120, usdtAmount: 119.88, fee: 0.12, slippage: 0, timestamp: 3, reason: "", pnl: 19, pnlPercent: 0.19 },
    ];
    const summary = getAccountSummary(account, {});
    expect(summary.winRate).toBeCloseTo(2 / 3, 2);
  });

  it("持仓未实现盈亏计算正确", () => {
    const account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const prices = { BTCUSDT: 60000 };
    const summary = getAccountSummary(account, prices);
    const pos = summary.positions.find((p) => p.symbol === "BTCUSDT")!;
    expect(pos.unrealizedPnl).toBeGreaterThan(0);
    expect(pos.unrealizedPnlPercent).toBeCloseTo(0.2, 1);
  });

  it("持仓摘要包含止损和止盈价格", () => {
    const account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, stopLossPercent: 5, takeProfitPercent: 15, ...NO_SLIP });
    const summary = getAccountSummary(account, { BTCUSDT: 50000 });
    const pos = summary.positions[0];
    expect(pos.stopLoss).toBeCloseTo(47500, 0);
    expect(pos.takeProfit).toBeCloseTo(57500, 0);
  });
});

// ─────────────────────────────────────────────────────
// updateTrailingStop
// ─────────────────────────────────────────────────────

describe("updateTrailingStop()", () => {
  function makePos(entryPrice: number): PaperPosition {
    return {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice,
      entryTime: Date.now(),
      stopLoss: entryPrice * 0.95,
      takeProfit: entryPrice * 1.15,
    };
  }

  it("盈利未达激活阈值时不激活", () => {
    const pos = makePos(50000);
    // 涨到 52000（+4%），激活阈值 5%
    const exit = updateTrailingStop(pos, 52000, { activationPercent: 5, callbackPercent: 2 });
    expect(exit).toBe(false);
    expect(pos.trailingStop?.active).toBe(false);
  });

  it("盈利达到激活阈值后追踪止损激活", () => {
    const pos = makePos(50000);
    // 涨到 53000（+6% > 5% 阈值），激活
    updateTrailingStop(pos, 53000, { activationPercent: 5, callbackPercent: 2 });
    expect(pos.trailingStop?.active).toBe(true);
  });

  it("激活后价格回撤超过 callback 触发平仓", () => {
    const pos = makePos(50000);
    // 涨到 55000（+10%），激活追踪，最高价 55000
    updateTrailingStop(pos, 55000, { activationPercent: 5, callbackPercent: 2 });
    // 从 55000 回撤 2% = 53900，继续下跌到 53000 → 触发
    const exit = updateTrailingStop(pos, 53900, { activationPercent: 5, callbackPercent: 2 });
    expect(exit).toBe(true);
  });

  it("价格创新高时更新 highestPrice", () => {
    const pos = makePos(50000);
    updateTrailingStop(pos, 55000, { activationPercent: 5, callbackPercent: 2 });
    updateTrailingStop(pos, 58000, { activationPercent: 5, callbackPercent: 2 });
    expect(pos.trailingStop?.highestPrice).toBe(58000);
  });
});

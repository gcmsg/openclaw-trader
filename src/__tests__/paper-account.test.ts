import { describe, it, expect, beforeEach } from "vitest";
import {
  paperBuy,
  paperSell,
  calcTotalEquity,
  getAccountSummary,
  type PaperAccount,
} from "../paper/account.js";

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
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    expect(trade).not.toBeNull();
    expect(account.usdt).toBeLessThan(1000);
    expect(account.positions["BTCUSDT"]).toBeDefined();
  });

  it("买入金额 = 总资产 * positionRatio", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    // 总资产 1000 * 20% = 200 USDT
    expect(account.usdt).toBeCloseTo(1000 - 200, 1);
  });

  it("持仓数量 = (投入 - 手续费) / 价格", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    const pos = account.positions["BTCUSDT"];
    const feeRate = 0.001;
    const spent = 200;
    const expectedQty = (spent * (1 - feeRate)) / 50000;
    expect(pos.quantity).toBeCloseTo(expectedQty, 8);
  });

  it("同一币种已有持仓时不重复买入", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    const trade2 = paperBuy(account, "BTCUSDT", 48000, "test2", 0.2);
    expect(trade2).toBeNull();
    expect(account.usdt).toBeCloseTo(800, 1); // 只买了一次
  });

  it("余额不足时不买入", () => {
    account.usdt = 10; // 几乎没钱
    // 10 * 20% = 2 USDT，但 totalEquity 也只有 10
    // 小金额可能买得进，让我用更极端的例子
    account.usdt = 0;
    account.initialUsdt = 0;
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    expect(trade).toBeNull();
  });

  it("买入后添加到 trades 记录", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    expect(account.trades).toHaveLength(1);
    expect(account.trades[0].side).toBe("buy");
    expect(account.trades[0].symbol).toBe("BTCUSDT");
  });

  it("可以买入不同币种", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    paperBuy(account, "ETHUSDT", 2000, "test", 0.2);
    expect(Object.keys(account.positions)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────
// paperSell
// ─────────────────────────────────────────────────────

describe("paperSell()", () => {
  let account: PaperAccount;
  beforeEach(() => {
    account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "setup", 0.2);
  });

  it("卖出后持仓清空、USDT 增加", () => {
    const usdtBefore = account.usdt;
    paperSell(account, "BTCUSDT", 55000, "sell test");
    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(account.usdt).toBeGreaterThan(usdtBefore);
  });

  it("没有持仓时卖出返回 null", () => {
    const trade = paperSell(account, "ETHUSDT", 2000, "test");
    expect(trade).toBeNull();
  });

  it("盈利交易：pnl > 0", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test"); // 买50000卖60000
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeGreaterThan(0);
    expect(trade!.pnlPercent).toBeGreaterThan(0);
  });

  it("亏损交易：pnl < 0", () => {
    const trade = paperSell(account, "BTCUSDT", 40000, "test"); // 买50000卖40000
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeLessThan(0);
    expect(trade!.pnlPercent).toBeLessThan(0);
  });

  it("卖出手续费从收入中扣除", () => {
    const pos = account.positions["BTCUSDT"];
    const grossUsdt = pos.quantity * 50000;
    const expectedFee = grossUsdt * 0.001;
    const trade = paperSell(account, "BTCUSDT", 50000, "test"); // 原价卖出
    expect(trade!.fee).toBeCloseTo(expectedFee, 4);
  });

  it("卖出后添加到 trades 记录", () => {
    paperSell(account, "BTCUSDT", 55000, "test");
    const sellTrades = account.trades.filter((t) => t.side === "sell");
    expect(sellTrades).toHaveLength(1);
    expect(sellTrades[0].pnl).toBeDefined();
  });

  it("盈亏百分比计算正确（约 20%）", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test");
    // 50000 → 60000 = 20%，扣除买卖手续费约 19.8%
    expect(trade!.pnlPercent!).toBeCloseTo(0.198, 1);
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
    paperBuy(account, "ETHUSDT", 2000, "test", 0.2);
    // 买入花费 200 USDT，还剩 800，持有约 0.0999 ETH
    const prices = { ETHUSDT: 2500 }; // 涨价 25%
    const equity = calcTotalEquity(account, prices);
    expect(equity).toBeGreaterThan(1000); // 总资产应大于初始值
  });

  it("币种价格未提供时跳过该持仓", () => {
    const account = makeAccount({ usdt: 800 });
    paperBuy(account, "ETHUSDT", 2000, "test", 0.2);
    // 不提供 ETHUSDT 价格
    const equity = calcTotalEquity(account, {});
    expect(equity).toBe(account.usdt); // 只算 USDT
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
    // 模拟 2 胜 1 负的卖出记录
    account.trades = [
      { id: "1", symbol: "A", side: "sell", quantity: 1, price: 110, usdtAmount: 109.89, fee: 0.11, timestamp: 1, reason: "", pnl: 9, pnlPercent: 0.09 },
      { id: "2", symbol: "B", side: "sell", quantity: 1, price: 90, usdtAmount: 89.91, fee: 0.09, timestamp: 2, reason: "", pnl: -11, pnlPercent: -0.11 },
      { id: "3", symbol: "C", side: "sell", quantity: 1, price: 120, usdtAmount: 119.88, fee: 0.12, timestamp: 3, reason: "", pnl: 19, pnlPercent: 0.19 },
    ];
    const summary = getAccountSummary(account, {});
    expect(summary.winRate).toBeCloseTo(2 / 3, 2);
  });

  it("持仓未实现盈亏计算正确", () => {
    const account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "test", 0.2);
    const prices = { BTCUSDT: 60000 };
    const summary = getAccountSummary(account, prices);
    const pos = summary.positions.find((p) => p.symbol === "BTCUSDT")!;
    expect(pos.unrealizedPnl).toBeGreaterThan(0);
    expect(pos.unrealizedPnlPercent).toBeCloseTo(0.2, 1);
  });
});

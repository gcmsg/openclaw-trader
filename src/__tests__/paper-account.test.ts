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

// Default config with no slippage (keeps calculations clean)
const NO_SLIP = { slippagePercent: 0, feeRate: 0.001 };

// ─────────────────────────────────────────────────────
// Test helper: create a clean virtual account (no file I/O)
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
  beforeEach(() => {
    account = makeAccount();
  });

  it("after successful buy, USDT decreases and position is added", () => {
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade).not.toBeNull();
    expect(account.usdt).toBeLessThan(1000);
    expect(account.positions["BTCUSDT"]).toBeDefined();
  });

  it("buy amount = total equity * positionRatio", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    // Total equity 1000 * 20% = 200 USDT
    expect(account.usdt).toBeCloseTo(1000 - 200, 1);
  });

  it("position quantity = (invested - fee) / price", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const pos = account.positions["BTCUSDT"]!;
    const spent = 200;
    const expectedQty = (spent * (1 - 0.001)) / 50000;
    expect(pos.quantity).toBeCloseTo(expectedQty, 8);
  });

  it("sets stop-loss price on buy (default 5%)", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.2,
      stopLossPercent: 5,
      ...NO_SLIP,
    });
    const pos = account.positions["BTCUSDT"]!;
    expect(pos.stopLoss).toBeCloseTo(50000 * 0.95, 0);
  });

  it("sets take-profit price on buy (default 15%)", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.2,
      takeProfitPercent: 15,
      ...NO_SLIP,
    });
    const pos = account.positions["BTCUSDT"]!;
    expect(pos.takeProfit).toBeCloseTo(50000 * 1.15, 0);
  });

  it("does not buy again when already holding the same symbol", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const trade2 = paperBuy(account, "BTCUSDT", 48000, "test2", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade2).toBeNull();
    expect(account.usdt).toBeCloseTo(800, 1);
  });

  it("does not buy when balance is insufficient", () => {
    account.usdt = 0;
    account.initialUsdt = 0;
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(trade).toBeNull();
  });

  it("does not buy when below minimum order amount", () => {
    account.usdt = 30;
    account.initialUsdt = 30;
    // 30 * 20% = 6 USDT < minOrderUsdt=10
    const trade = paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.2,
      minOrderUsdt: 10,
      ...NO_SLIP,
    });
    expect(trade).toBeNull();
  });

  it("adds to trades record after buy", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(account.trades).toHaveLength(1);
    expect(account.trades[0]!.side).toBe("buy");
    expect(account.trades[0]!.symbol).toBe("BTCUSDT");
  });

  it("can buy different symbols", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    paperBuy(account, "ETHUSDT", 2000, "test", { positionRatio: 0.2, ...NO_SLIP });
    expect(Object.keys(account.positions)).toHaveLength(2);
  });

  it("slippage makes execution price slightly higher than current price", () => {
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.2,
      slippagePercent: 0.1,
      feeRate: 0,
    });
    const pos = account.positions["BTCUSDT"]!;
    // Slippage 0.1% → execPrice = 50050
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

  it("after sell, position is cleared and USDT increases", () => {
    const usdtBefore = account.usdt;
    paperSell(account, "BTCUSDT", 55000, "sell test", NO_SLIP);
    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(account.usdt).toBeGreaterThan(usdtBefore);
  });

  it("returns null when selling without a position", () => {
    const trade = paperSell(account, "ETHUSDT", 2000, "test", NO_SLIP);
    expect(trade).toBeNull();
  });

  it("profitable trade: pnl > 0", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test", NO_SLIP);
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeGreaterThan(0);
    expect(trade!.pnlPercent).toBeGreaterThan(0);
  });

  it("losing trade: pnl < 0, dailyLoss accumulates", () => {
    const trade = paperSell(account, "BTCUSDT", 40000, "test", NO_SLIP);
    expect(trade).not.toBeNull();
    expect(trade!.pnl).toBeLessThan(0);
    expect(account.dailyLoss.loss).toBeGreaterThan(0);
  });

  it("sell fee deducted from proceeds", () => {
    const pos = account.positions["BTCUSDT"]!;
    const grossUsdt = pos.quantity * 50000;
    const expectedFee = grossUsdt * 0.001;
    const trade = paperSell(account, "BTCUSDT", 50000, "test", NO_SLIP);
    expect(trade!.fee).toBeCloseTo(expectedFee, 4);
  });

  it("adds to trades record after sell", () => {
    paperSell(account, "BTCUSDT", 55000, "test", NO_SLIP);
    const sells = account.trades.filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]!.pnl).toBeDefined();
  });

  it("PnL percentage calculated correctly (approx +20%, deducting round-trip fees)", () => {
    const trade = paperSell(account, "BTCUSDT", 60000, "test", NO_SLIP);
    // 50000 → 60000 = +20%, deducting 0.1% buy+sell fees ~19.8%
    expect(trade!.pnlPercent!).toBeCloseTo(0.198, 1);
  });

  it("slippage makes sell execution price slightly lower than current price", () => {
    const trade = paperSell(account, "BTCUSDT", 50000, "test", {
      slippagePercent: 0.1,
      feeRate: 0,
    });
    // Slippage 0.1% → execPrice = 49950
    expect(trade!.price).toBeCloseTo(49950, 0);
  });
});

// ─────────────────────────────────────────────────────
// calcTotalEquity
// ─────────────────────────────────────────────────────

describe("calcTotalEquity()", () => {
  it("equals USDT balance when no positions", () => {
    const account = makeAccount({ usdt: 500 });
    expect(calcTotalEquity(account, {})).toBe(500);
  });

  it("equals USDT + position market value when holding positions", () => {
    const account = makeAccount({ usdt: 1000, initialUsdt: 1000 });
    paperBuy(account, "ETHUSDT", 2000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const equity = calcTotalEquity(account, { ETHUSDT: 2500 });
    expect(equity).toBeGreaterThan(1000);
  });

  it("skips position when symbol price is not provided", () => {
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
  it("initial account PnL is 0", () => {
    const account = makeAccount();
    const summary = getAccountSummary(account, {});
    expect(summary.totalPnl).toBe(0);
    expect(summary.totalPnlPercent).toBe(0);
  });

  it("win rate is 0 with no trades", () => {
    const account = makeAccount();
    const summary = getAccountSummary(account, {});
    expect(summary.winRate).toBe(0);
  });

  it("win rate calculation: 2 wins 1 loss = 66.7%", () => {
    const account = makeAccount();
    account.trades = [
      {
        id: "1",
        symbol: "A",
        side: "sell",
        quantity: 1,
        price: 110,
        usdtAmount: 109.89,
        fee: 0.11,
        slippage: 0,
        timestamp: 1,
        reason: "",
        pnl: 9,
        pnlPercent: 0.09,
      },
      {
        id: "2",
        symbol: "B",
        side: "sell",
        quantity: 1,
        price: 90,
        usdtAmount: 89.91,
        fee: 0.09,
        slippage: 0,
        timestamp: 2,
        reason: "",
        pnl: -11,
        pnlPercent: -0.11,
      },
      {
        id: "3",
        symbol: "C",
        side: "sell",
        quantity: 1,
        price: 120,
        usdtAmount: 119.88,
        fee: 0.12,
        slippage: 0,
        timestamp: 3,
        reason: "",
        pnl: 19,
        pnlPercent: 0.19,
      },
    ];
    const summary = getAccountSummary(account, {});
    expect(summary.winRate).toBeCloseTo(2 / 3, 2);
  });

  it("unrealized PnL for positions calculated correctly", () => {
    const account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.2, ...NO_SLIP });
    const prices = { BTCUSDT: 60000 };
    const summary = getAccountSummary(account, prices);
    const pos = summary.positions.find((p) => p.symbol === "BTCUSDT")!;
    expect(pos.unrealizedPnl).toBeGreaterThan(0);
    expect(pos.unrealizedPnlPercent).toBeCloseTo(0.2, 1);
  });

  it("position summary includes stop-loss and take-profit prices", () => {
    const account = makeAccount();
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.2,
      stopLossPercent: 5,
      takeProfitPercent: 15,
      ...NO_SLIP,
    });
    const summary = getAccountSummary(account, { BTCUSDT: 50000 });
    const pos = summary.positions[0]!;
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

  it("does not activate when profit has not reached activation threshold", () => {
    const pos = makePos(50000);
    // Rose to 52000 (+4%), activation threshold 5%
    const exit = updateTrailingStop(pos, 52000, { activationPercent: 5, callbackPercent: 2 });
    expect(exit).toBe(false);
    expect(pos.trailingStop?.active).toBe(false);
  });

  it("trailing stop activates when profit reaches activation threshold", () => {
    const pos = makePos(50000);
    // Rose to 53000 (+6% > 5% threshold), activates
    updateTrailingStop(pos, 53000, { activationPercent: 5, callbackPercent: 2 });
    expect(pos.trailingStop?.active).toBe(true);
  });

  it("triggers close when price pulls back beyond callback after activation", () => {
    const pos = makePos(50000);
    // Rose to 55000 (+10%), trailing activated, highest price 55000
    updateTrailingStop(pos, 55000, { activationPercent: 5, callbackPercent: 2 });
    // Pulled back 2% from 55000 = 53900, continues to drop to 53000 → triggers
    const exit = updateTrailingStop(pos, 53900, { activationPercent: 5, callbackPercent: 2 });
    expect(exit).toBe(true);
  });

  it("updates highestPrice when price makes new highs", () => {
    const pos = makePos(50000);
    updateTrailingStop(pos, 55000, { activationPercent: 5, callbackPercent: 2 });
    updateTrailingStop(pos, 58000, { activationPercent: 5, callbackPercent: 2 });
    expect(pos.trailingStop?.highestPrice).toBe(58000);
  });
});

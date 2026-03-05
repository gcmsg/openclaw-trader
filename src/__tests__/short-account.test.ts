/**
 * Short account layer tests
 * Coverage: paperOpenShort / paperCoverShort / calcTotalEquity / updateTrailingStop (short direction)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type PaperAccount,
  type PaperPosition,
  paperBuy,
  paperOpenShort,
  paperCoverShort,
  calcTotalEquity,
  updateTrailingStop,
  getAccountSummary,
} from "../paper/account.js";

// ─── Helpers ───────────────────────────────────────────

function makeAccount(usdt = 10_000): PaperAccount {
  return {
    initialUsdt: usdt,
    usdt,
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
  };
}

const BASE_OPTS = {
  feeRate: 0,           // Zero fees for easier value verification
  slippagePercent: 0,   // Zero slippage
  stopLossPercent: 5,
  takeProfitPercent: 15,
  positionRatio: 0.2,
};

// ─── paperOpenShort ──────────────────────────────────

describe("paperOpenShort", () => {
  let account: PaperAccount;
  beforeEach(() => { account = makeAccount(); });

  it("Normal short open: locks margin, records trade(side=short)", () => {
    const trade = paperOpenShort(account, "BTCUSDT", 100, "ma_bearish", BASE_OPTS);
    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("short");
    // Locked margin = 10000 * 0.2 = 2000
    expect(account.usdt).toBeCloseTo(8000, 5);
    // Position direction
    const pos = account.positions["BTCUSDT"];
    expect(pos).toBeDefined();
    expect(pos!.side).toBe("short");
    expect(pos!.entryPrice).toBeCloseTo(100);
    expect(pos!.quantity).toBeCloseTo(20); // 2000 / 100
    expect(pos!.marginUsdt).toBeCloseTo(2000);
  });

  it("Stop loss price above entry price (short stop loss direction is reversed)", () => {
    paperOpenShort(account, "BTCUSDT", 100, "test", BASE_OPTS);
    const pos = account.positions["BTCUSDT"]!;
    // Stop loss = 100 * 1.05 = 105 (loss when price rises)
    expect(pos.stopLoss).toBeCloseTo(105);
    // Take profit = 100 * 0.85 = 85 (profit when price drops)
    expect(pos.takeProfit).toBeCloseTo(85);
  });

  it("Rejects short open when same symbol already has a position", () => {
    paperOpenShort(account, "BTCUSDT", 100, "test1", BASE_OPTS);
    const trade2 = paperOpenShort(account, "BTCUSDT", 100, "test2", BASE_OPTS);
    expect(trade2).toBeNull();
  });

  it("Rejects short open when long position exists (same symbol)", () => {
    paperBuy(account, "BTCUSDT", 100, "buy", BASE_OPTS);
    const trade = paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("Returns null when margin is insufficient", () => {
    const broke = makeAccount(5); // Only 5 USDT
    const trade = paperOpenShort(broke, "BTCUSDT", 100, "test", {
      ...BASE_OPTS,
      minOrderUsdt: 10,
    });
    expect(trade).toBeNull();
  });

  it("Margin correctly deducted with fees", () => {
    const opts = { ...BASE_OPTS, feeRate: 0.001 };
    paperOpenShort(account, "BTCUSDT", 100, "test", opts);
    // marginToLock = 2000, fee = 2, actualMargin = 1998, qty = 1998/100 = 19.98
    const pos = account.positions["BTCUSDT"]!;
    expect(pos.marginUsdt).toBeCloseTo(1998);
    expect(pos.quantity).toBeCloseTo(19.98);
    expect(account.usdt).toBeCloseTo(8000); // Deducted amount is marginToLock=2000
  });

  it("With slippage, execution price is lower than market price (unfavorable for short side)", () => {
    const opts = { ...BASE_OPTS, slippagePercent: 0.1 };
    paperOpenShort(account, "BTCUSDT", 100, "test", opts);
    const pos = account.positions["BTCUSDT"]!;
    // Slippage 0.1%, market price 100 -> execPrice = 99.9
    expect(pos.entryPrice).toBeCloseTo(99.9);
  });
});

// ─── paperCoverShort ─────────────────────────────────

describe("paperCoverShort", () => {
  let account: PaperAccount;
  beforeEach(() => {
    account = makeAccount();
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // After short open: usdt=8000, pos.qty=20, pos.margin=2000
  });

  it("Price drop: correctly calculates profit and returns margin", () => {
    // Price drops from 100 to 80 (down 20%)
    const trade = paperCoverShort(account, "BTCUSDT", 80, "cover", BASE_OPTS);
    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("cover");
    // pnl = (100-80) * 20 = 400
    expect(trade!.pnl).toBeCloseTo(400);
    // pnlPercent = 400/2000 = 0.2
    expect(trade!.pnlPercent).toBeCloseTo(0.2);
    // Returned: 8000 + 2000 + 400 = 10400
    expect(account.usdt).toBeCloseTo(10400);
    // Position cleared
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("Price rise: correctly calculates loss and deducts margin", () => {
    // Price rises from 100 to 110 (up 10%)
    const trade = paperCoverShort(account, "BTCUSDT", 110, "stop_loss", BASE_OPTS);
    expect(trade).not.toBeNull();
    // pnl = (100-110) * 20 = -200
    expect(trade!.pnl).toBeCloseTo(-200);
    // Returned: 2000 - 200 = 1800 -> usdt = 8000+1800 = 9800
    expect(account.usdt).toBeCloseTo(9800);
    // Loss recorded in dailyLoss
    expect(account.dailyLoss.loss).toBeCloseTo(200);
  });

  it("Returns null when no short position exists", () => {
    const trade = paperCoverShort(account, "ETHUSDT", 100, "test", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("Returns null when trying to cover a long position (side=long)", () => {
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    const trade = paperCoverShort(account, "ETHUSDT", 100, "test", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("Extreme loss (price doubles): margin zeroed at most, no negative balance", () => {
    // Price rises from 100 to 200 (loss = 20 * 100 = 2000 = entire margin)
    paperCoverShort(account, "BTCUSDT", 200, "liquidate", BASE_OPTS);
    // usdt should not be negative
    expect(account.usdt).toBeGreaterThanOrEqual(8000); // At least 8000 (margin zeroed)
  });

  it("pnl is correct with fees", () => {
    const opts = { ...BASE_OPTS, feeRate: 0.001 };
    paperOpenShort(account, "ETHUSDT", 100, "open", opts);
    // ETHUSDT: equity=10000, margin=2000-2=1998, qty=19.98
    // Cover price 80: gross=19.98*80=1598.4, fee=1.598, pnl=(100-80)*19.98-1.598=399.6-1.598=398.0
    const pos = account.positions["ETHUSDT"]!;
    const trade = paperCoverShort(account, "ETHUSDT", 80, "cover", opts);
    expect(trade).not.toBeNull();
    const expectedPnl = (100 - 80) * pos.quantity - 80 * pos.quantity * 0.001;
    expect(trade!.pnl).toBeCloseTo(expectedPnl, 2);
  });
});

// ─── calcTotalEquity (short) ──────────────────────────

describe("calcTotalEquity with short positions", () => {
  it("Total equity increases with unrealized short profit", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // usdt=8000, pos.margin=2000, qty=20
    // Price drops to 80: unrealizedPnl = (100-80)*20 = 400
    const equity = calcTotalEquity(account, { BTCUSDT: 80 });
    expect(equity).toBeCloseTo(10400); // 8000 + 2000 + 400
  });

  it("Total equity decreases with unrealized short loss", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // Price rises to 110: unrealizedPnl = (100-110)*20 = -200
    const equity = calcTotalEquity(account, { BTCUSDT: 110 });
    expect(equity).toBeCloseTo(9800); // 8000 + 2000 - 200
  });

  it("Total equity correct when holding both long and short", () => {
    const account = makeAccount(10_000);
    // Open long ETH: equity=10000, usdt becomes 8000, eth.qty=20
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    // Open short BTC: calcTotalEquity only receives { BTCUSDT:100 }, ETHUSDT skipped (no price)
    //   -> equity=8000 (usdt only), marginToLock=1600, qty=16, usdt=6400
    paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);

    // ETH rises to 120 (long profit), BTC rises to 110 (short loss)
    const equity = calcTotalEquity(account, { ETHUSDT: 120, BTCUSDT: 110 });
    // usdt=6400, ETH: 20*120=2400, BTC short: 1600+(100-110)*16=1440
    expect(equity).toBeCloseTo(10240);
  });

  it("Skips position when no price data available", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const equity = calcTotalEquity(account, {}); // No BTCUSDT price
    expect(equity).toBeCloseTo(8000); // Only usdt
  });
});

// ─── updateTrailingStop (short) ──────────────────────

describe("updateTrailingStop for short positions", () => {
  function makeShortPos(entryPrice: number): PaperPosition {
    return {
      symbol: "BTCUSDT",
      side: "short",
      quantity: 10,
      entryPrice,
      entryTime: Date.now(),
      stopLoss: entryPrice * 1.05,
      takeProfit: entryPrice * 0.85,
      marginUsdt: entryPrice * 10,
    };
  }

  it("Does not activate when activation threshold not reached", () => {
    const pos = makeShortPos(100);
    // Price only dropped 1%, activation requires 5%
    const shouldExit = updateTrailingStop(pos, 99, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
    expect(pos.trailingStop?.active).toBe(false);
  });

  it("Activates trailing stop after reaching activation threshold", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 94, { activationPercent: 5, callbackPercent: 2 });
    // Dropped to 94, decline 6% >= 5%
    expect(pos.trailingStop?.active).toBe(true);
    expect(pos.trailingStop?.lowestPrice).toBeCloseTo(94);
  });

  it("Price continues dropping: updates lowest price, does not trigger", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 94, { activationPercent: 5, callbackPercent: 2 });
    const shouldExit = updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
    expect(pos.trailingStop?.lowestPrice).toBeCloseTo(90);
  });

  it("Price rebounds from lowest point beyond callback range: triggers close", () => {
    const pos = makeShortPos(100);
    // Dropped to 90 (activated)
    updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 90 * 1.02 = 91.8
    // Price rebounds to 92, exceeds 91.8
    const shouldExit = updateTrailingStop(pos, 92, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(true);
  });

  it("Price rebound does not exceed callback range: does not trigger", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 90 * 1.02 = 91.8, rebounds to 91 (not exceeded)
    const shouldExit = updateTrailingStop(pos, 91, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
  });

  it("Long trailing stop logic is not affected", () => {
    const pos: PaperPosition = {
      symbol: "BTCUSDT",
      side: "long",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    // Rises to 110 (activated), then drops to 107.8 (triggered)
    updateTrailingStop(pos, 110, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 110 * 0.98 = 107.8
    const shouldExit = updateTrailingStop(pos, 107, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(true);
  });
});

// ─── getAccountSummary (short) ────────────────────────

describe("getAccountSummary with short positions", () => {
  it("unrealizedPnl is positive with short unrealized profit", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const summary = getAccountSummary(account, { BTCUSDT: 80 });
    const pos = summary.positions[0]!;
    expect(pos.side).toBe("short");
    expect(pos.unrealizedPnl).toBeCloseTo(400); // (100-80)*20
    expect(pos.unrealizedPnlPercent).toBeCloseTo(0.2);
    expect(summary.totalEquity).toBeCloseTo(10400);
  });

  it("unrealizedPnl is negative with short unrealized loss", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const summary = getAccountSummary(account, { BTCUSDT: 120 });
    const pos = summary.positions[0]!;
    expect(pos.unrealizedPnl).toBeCloseTo(-400); // (100-120)*20
    expect(summary.totalEquity).toBeCloseTo(9600);
  });

  it("Cover trades counted in win rate calculation (cover = closed position)", () => {
    const account = makeAccount(10_000);
    // Short open with profit
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    paperCoverShort(account, "BTCUSDT", 80, "cover", BASE_OPTS);
    // Short open with loss
    paperOpenShort(account, "BTCUSDT", 100, "open2", BASE_OPTS);
    paperCoverShort(account, "BTCUSDT", 120, "cover2", BASE_OPTS);
    const summary = getAccountSummary(account, {});
    // 1 win 1 loss, win rate 50%
    expect(summary.winRate).toBeCloseTo(0.5);
  });

  it("Mixed long/short positions displayed correctly", () => {
    const account = makeAccount(10_000);
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);
    const summary = getAccountSummary(account, { ETHUSDT: 110, BTCUSDT: 90 });
    const eth = summary.positions.find((p) => p.symbol === "ETHUSDT")!;
    const btc = summary.positions.find((p) => p.symbol === "BTCUSDT")!;
    expect(eth.side).toBe("long");
    expect(eth.unrealizedPnl).toBeGreaterThan(0); // ETH rose
    expect(btc.side).toBe("short");
    expect(btc.unrealizedPnl).toBeGreaterThan(0); // BTC dropped, short profits
  });
});

// ─── Backward compatibility (old positions without side field) ────────────────

describe("backward compatibility", () => {
  it("PaperPosition without side field treated as long", () => {
    const account = makeAccount(10_000);
    // Manually create old-format position without side field
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    // Equity should be calculated as long: 10 * 120 = 1200
    const equity = calcTotalEquity(account, { BTCUSDT: 120 });
    expect(equity).toBeCloseTo(10_000 - 0 + 10 * 120); // usdt unchanged, position contributes 1200
  });

  it("getAccountSummary shows old position side as long", () => {
    const account = makeAccount(10_000);
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    const summary = getAccountSummary(account, { BTCUSDT: 100 });
    expect(summary.positions[0]!.side).toBe("long");
  });
});

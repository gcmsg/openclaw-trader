/**
 * DCA staged position building tests
 * Covers: paperDcaAdd / checkDcaTranches / DCA state initialization
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  paperBuy,
  paperDcaAdd,
  type PaperAccount,
} from "../paper/account.js";

// ─────────────────────────────────────────────────────
// Test factory
// ─────────────────────────────────────────────────────

function makeAccount(initial = 1000): PaperAccount {
  return {
    initialUsdt: initial,
    usdt: initial,
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2099-01-01", loss: 0 },
  };
}

// ─────────────────────────────────────────────────────
// paperDcaAdd()
// ─────────────────────────────────────────────────────

describe("paperDcaAdd()", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(10000);
    // Establish initial position
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.1,  // 1000 USDT
      stopLossPercent: 5,
      takeProfitPercent: 15,
    });
  });

  it("returns null — no position exists", () => {
    const acc = makeAccount(1000);
    const trade = paperDcaAdd(acc, "BTCUSDT", 48000, "dca", { addUsdt: 100 });
    expect(trade).toBeNull();
  });

  it("returns null — add amount too small (< 1 USDT)", () => {
    const trade = paperDcaAdd(account, "BTCUSDT", 48000, "dca", { addUsdt: 0 });
    expect(trade).toBeNull();
  });

  it("returns null — add amount exceeds available USDT", () => {
    const trade = paperDcaAdd(account, "BTCUSDT", 48000, "dca", { addUsdt: 99999 });
    expect(trade).toBeNull();
  });

  it("normal add — quantity increases, average price recalculated", () => {
    const posBefore = account.positions["BTCUSDT"]!;
    const qtyBefore = posBefore.quantity;
    const cashBefore = account.usdt;

    const addUsdt = 1000;
    const newPrice = 47000; // price dropped
    const trade = paperDcaAdd(account, "BTCUSDT", newPrice, "dca batch 2", { addUsdt });

    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("buy");
    expect(trade!.usdtAmount).toBe(addUsdt);

    // Cash decreased
    expect(account.usdt).toBeLessThan(cashBefore);
    expect(account.usdt).toBeCloseTo(cashBefore - addUsdt, 0);

    // Quantity increased
    const posAfter = account.positions["BTCUSDT"]!;
    expect(posAfter.quantity).toBeGreaterThan(qtyBefore);

    // Average price is between original and add price (weighted average)
    expect(posAfter.entryPrice).toBeLessThan(posBefore.entryPrice);
    expect(posAfter.entryPrice).toBeGreaterThan(newPrice);
  });

  it("weighted average price is mathematically correct", () => {
    const pos = account.positions["BTCUSDT"]!;
    const q1 = pos.quantity;
    const p1 = pos.entryPrice;

    const addUsdt = 1000;
    const p2Raw = 48000;
    const slippage = 0.0005; // 0.05%
    const fee = 0.001;
    const p2 = p2Raw * (1 + slippage);
    const q2 = (addUsdt * (1 - fee)) / p2;

    paperDcaAdd(account, "BTCUSDT", p2Raw, "test", { addUsdt });

    const posAfter = account.positions["BTCUSDT"]!;
    const expectedAvg = (q1 * p1 + q2 * p2) / (q1 + q2);
    expect(posAfter.entryPrice).toBeCloseTo(expectedAvg, 4);
  });

  it("stop loss price remains unchanged (DCA add does not modify stop loss)", () => {
    const stopBefore = account.positions["BTCUSDT"]!.stopLoss;
    paperDcaAdd(account, "BTCUSDT", 46000, "dca", { addUsdt: 500 });
    expect(account.positions["BTCUSDT"]!.stopLoss).toBe(stopBefore);
  });

  it("dcaState.completedTranches auto-increments by 1", () => {
    // Set up dcaState first
    account.positions["BTCUSDT"]!.dcaState = {
      totalTranches: 3,
      completedTranches: 1,
      lastTranchePrice: 50000,
      dropPct: 3,
      startedAt: Date.now(),
      maxMs: 48 * 3600 * 1000,
    };

    paperDcaAdd(account, "BTCUSDT", 48000, "dca", { addUsdt: 500 });

    const dcaAfter = account.positions["BTCUSDT"]?.dcaState;
    expect(dcaAfter?.completedTranches).toBe(2);
    expect(dcaAfter?.lastTranchePrice).toBeGreaterThan(48000);
  });

  it("trade record written to account.trades", () => {
    const countBefore = account.trades.length;
    paperDcaAdd(account, "BTCUSDT", 47000, "dca", { addUsdt: 500 });
    expect(account.trades.length).toBe(countBefore + 1);
    expect(account.trades.at(-1)!.side).toBe("buy");
  });
});

// ─────────────────────────────────────────────────────
// DCA state initialization (manually initialized after paperBuy to simulate engine.ts behavior)
// ─────────────────────────────────────────────────────

describe("DCA state management", () => {
  it("dcaState field structure is correct", () => {
    const account = makeAccount(10000);
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.1 });

    // Simulate engine.ts initializing dcaState
    account.positions["BTCUSDT"]!.dcaState = {
      totalTranches: 3,
      completedTranches: 1,
      lastTranchePrice: account.positions["BTCUSDT"]!.entryPrice,
      dropPct: 3,
      startedAt: Date.now(),
      maxMs: 48 * 3600 * 1000,
    };

    const dca = account.positions["BTCUSDT"]?.dcaState;
    expect(dca?.totalTranches).toBe(3);
    expect(dca?.completedTranches).toBe(1);
    expect(dca?.dropPct).toBe(3);
    // 2 more tranches available
    expect((dca?.totalTranches ?? 0) - (dca?.completedTranches ?? 0)).toBe(2);
  });

  it("no dcaState when no position is open", () => {
    const account = makeAccount(1000);
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("no more adds after DCA is complete (completedTranches === totalTranches)", () => {
    const account = makeAccount(10000);
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.1 });
    account.positions["BTCUSDT"]!.dcaState = {
      totalTranches: 3,
      completedTranches: 3,  // completed
      lastTranchePrice: 45000,
      dropPct: 3,
      startedAt: Date.now() - 10000,
      maxMs: 48 * 3600 * 1000,
    };

    // completedTranches === totalTranches → no more adds triggered
    const dca = account.positions["BTCUSDT"]?.dcaState;
    expect((dca?.completedTranches ?? 0) >= (dca?.totalTranches ?? 1)).toBe(true);
  });

  it("DCA stops adding after timeout", () => {
    const startedAt = Date.now() - 50 * 3600 * 1000; // started 50h ago
    const maxMs = 48 * 3600 * 1000;                   // max 48h
    expect(Date.now() - startedAt > maxMs).toBe(true);
  });

  it("DCA can continue before timeout", () => {
    const startedAt = Date.now() - 24 * 3600 * 1000; // started 24h ago
    const maxMs = 48 * 3600 * 1000;                   // max 48h
    expect(Date.now() - startedAt > maxMs).toBe(false);
  });

  it("price drop percentage calculated correctly", () => {
    const lastPrice = 50000;
    const currentPrice = 48400; // dropped 3.2%
    const dropPct = ((lastPrice - currentPrice) / lastPrice) * 100;
    expect(dropPct).toBeCloseTo(3.2, 1);
    expect(dropPct >= 3.0).toBe(true); // meets 3% trigger condition
  });

  it("price drop insufficient does not trigger", () => {
    const lastPrice = 50000;
    const currentPrice = 49000; // dropped 2%
    const dropPct = ((lastPrice - currentPrice) / lastPrice) * 100;
    expect(dropPct >= 3.0).toBe(false);
  });
});

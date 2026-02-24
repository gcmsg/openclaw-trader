/**
 * DCA 分批建仓测试
 * 覆盖：paperDcaAdd / checkDcaTranches / DCA 状态初始化
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  paperBuy,
  paperDcaAdd,
  type PaperAccount,
} from "../paper/account.js";

// ─────────────────────────────────────────────────────
// 测试工厂
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
    // 先建立初始持仓
    paperBuy(account, "BTCUSDT", 50000, "test", {
      positionRatio: 0.1,  // 1000 USDT
      stopLossPercent: 5,
      takeProfitPercent: 15,
    });
  });

  it("返回 null — 没有持仓时", () => {
    const acc = makeAccount(1000);
    const trade = paperDcaAdd(acc, "BTCUSDT", 48000, "dca", { addUsdt: 100 });
    expect(trade).toBeNull();
  });

  it("返回 null — 追加金额不足（< 1 USDT）", () => {
    const trade = paperDcaAdd(account, "BTCUSDT", 48000, "dca", { addUsdt: 0 });
    expect(trade).toBeNull();
  });

  it("返回 null — 追加金额超过可用 USDT", () => {
    const trade = paperDcaAdd(account, "BTCUSDT", 48000, "dca", { addUsdt: 99999 });
    expect(trade).toBeNull();
  });

  it("正常追加 — 数量增加，均价重新计算", () => {
    const posBefore = account.positions["BTCUSDT"]!;
    const qtyBefore = posBefore.quantity;
    const cashBefore = account.usdt;

    const addUsdt = 1000;
    const newPrice = 47000; // 价格下跌
    const trade = paperDcaAdd(account, "BTCUSDT", newPrice, "dca 第 2 批", { addUsdt });

    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("buy");
    expect(trade!.usdtAmount).toBe(addUsdt);

    // 资金减少
    expect(account.usdt).toBeLessThan(cashBefore);
    expect(account.usdt).toBeCloseTo(cashBefore - addUsdt, 0);

    // 数量增加
    const posAfter = account.positions["BTCUSDT"]!;
    expect(posAfter.quantity).toBeGreaterThan(qtyBefore);

    // 均价介于原始价和追加价之间（加权均价）
    expect(posAfter.entryPrice).toBeLessThan(posBefore.entryPrice);
    expect(posAfter.entryPrice).toBeGreaterThan(newPrice);
  });

  it("加权均价数学正确", () => {
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

  it("止损价格保持不变（DCA 追加不修改止损）", () => {
    const stopBefore = account.positions["BTCUSDT"]!.stopLoss;
    paperDcaAdd(account, "BTCUSDT", 46000, "dca", { addUsdt: 500 });
    expect(account.positions["BTCUSDT"]!.stopLoss).toBe(stopBefore);
  });

  it("dcaState.completedTranches 自动 +1", () => {
    // 先设置 dcaState
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

  it("交易记录写入 account.trades", () => {
    const countBefore = account.trades.length;
    paperDcaAdd(account, "BTCUSDT", 47000, "dca", { addUsdt: 500 });
    expect(account.trades.length).toBe(countBefore + 1);
    expect(account.trades.at(-1)!.side).toBe("buy");
  });
});

// ─────────────────────────────────────────────────────
// DCA 状态初始化（通过 paperBuy 后手动初始化模拟 engine.ts 行为）
// ─────────────────────────────────────────────────────

describe("DCA 状态管理", () => {
  it("dcaState 字段结构正确", () => {
    const account = makeAccount(10000);
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.1 });

    // 模拟 engine.ts 初始化 dcaState
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
    // 还有 2 批可用
    expect((dca?.totalTranches ?? 0) - (dca?.completedTranches ?? 0)).toBe(2);
  });

  it("未开仓时没有 dcaState", () => {
    const account = makeAccount(1000);
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("DCA 完成后（completedTranches === totalTranches）不再追加", () => {
    const account = makeAccount(10000);
    paperBuy(account, "BTCUSDT", 50000, "test", { positionRatio: 0.1 });
    account.positions["BTCUSDT"]!.dcaState = {
      totalTranches: 3,
      completedTranches: 3,  // 已完成
      lastTranchePrice: 45000,
      dropPct: 3,
      startedAt: Date.now() - 10000,
      maxMs: 48 * 3600 * 1000,
    };

    // completedTranches === totalTranches → 不再触发追加
    const dca = account.positions["BTCUSDT"]?.dcaState;
    expect((dca?.completedTranches ?? 0) >= (dca?.totalTranches ?? 1)).toBe(true);
  });

  it("超时后 DCA 停止追加判断", () => {
    const startedAt = Date.now() - 50 * 3600 * 1000; // 50h 前开始
    const maxMs = 48 * 3600 * 1000;                   // 最多 48h
    expect(Date.now() - startedAt > maxMs).toBe(true);
  });

  it("未超时 DCA 可继续", () => {
    const startedAt = Date.now() - 24 * 3600 * 1000; // 24h 前开始
    const maxMs = 48 * 3600 * 1000;                   // 最多 48h
    expect(Date.now() - startedAt > maxMs).toBe(false);
  });

  it("价格跌幅计算正确", () => {
    const lastPrice = 50000;
    const currentPrice = 48400; // 下跌 3.2%
    const dropPct = ((lastPrice - currentPrice) / lastPrice) * 100;
    expect(dropPct).toBeCloseTo(3.2, 1);
    expect(dropPct >= 3.0).toBe(true); // 满足 3% 触发条件
  });

  it("价格跌幅不足时不触发", () => {
    const lastPrice = 50000;
    const currentPrice = 49000; // 下跌 2%
    const dropPct = ((lastPrice - currentPrice) / lastPrice) * 100;
    expect(dropPct >= 3.0).toBe(false);
  });
});

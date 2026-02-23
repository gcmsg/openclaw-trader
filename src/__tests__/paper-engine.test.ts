import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkStopLoss, checkMaxDrawdown } from "../paper/engine.js";
import * as accountModule from "../paper/account.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Mock：不读写文件，直接控制内存中的账户状态
// ─────────────────────────────────────────────────────

function makeAccount(positions: Record<string, PaperPosition> = {}): PaperAccount {
  return {
    initialUsdt: 1000,
    usdt: 800,
    positions,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePosition(symbol: string, entryPrice: number, quantity = 0.1): PaperPosition {
  return { symbol, quantity, entryPrice, entryTime: Date.now() };
}

function makeRiskConfig(stopLoss = 5, maxLoss = 20): StrategyConfig["risk"] {
  return {
    stop_loss_percent: stopLoss,
    take_profit_percent: 10,
    max_total_loss_percent: maxLoss,
    position_ratio: 0.2,
  };
}

function makeConfig(stopLoss = 5, maxLoss = 20): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test", enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: makeRiskConfig(stopLoss, maxLoss),
    notify: { on_signal: true, on_trade: true, on_stop_loss: true, on_error: true, min_interval_minutes: 30 },
    paper: { initial_usdt: 1000, report_interval_hours: 24 },
    news: { enabled: true, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    mode: "paper",
  };
}

// ─────────────────────────────────────────────────────
// checkStopLoss
// ─────────────────────────────────────────────────────

describe("checkStopLoss()", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.004), // 200 USDT 成本
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("价格跌超止损线时触发止损", () => {
    // 买入 50000，止损 5%，触发线 = 47500
    const prices = { BTCUSDT: 47000 };
    const triggered = checkStopLoss(prices, makeConfig(5));
    expect(triggered).toHaveLength(1);
    expect(triggered[0].symbol).toBe("BTCUSDT");
  });

  it("价格恰好在止损线上方时不触发", () => {
    // 47501 > 47500，不触发
    const prices = { BTCUSDT: 47600 };
    const triggered = checkStopLoss(prices, makeConfig(5));
    expect(triggered).toHaveLength(0);
  });

  it("无持仓时不触发止损", () => {
    account.positions = {};
    const triggered = checkStopLoss({ BTCUSDT: 40000 }, makeConfig(5));
    expect(triggered).toHaveLength(0);
  });

  it("止损触发后持仓被清空", () => {
    checkStopLoss({ BTCUSDT: 45000 }, makeConfig(5));
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("止损触发后 trades 中有卖出记录", () => {
    checkStopLoss({ BTCUSDT: 45000 }, makeConfig(5));
    const sells = account.trades.filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].reason).toContain("止损触发");
  });

  it("止损线为 10% 时，跌 5% 不触发", () => {
    const prices = { BTCUSDT: 47500 }; // -5%
    const triggered = checkStopLoss(prices, makeConfig(10));
    expect(triggered).toHaveLength(0);
  });

  it("币种没有提供价格时跳过", () => {
    const triggered = checkStopLoss({}, makeConfig(5)); // 没有价格
    expect(triggered).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// checkMaxDrawdown
// ─────────────────────────────────────────────────────

describe("checkMaxDrawdown()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("总亏损超过上限时返回 true", () => {
    // 初始 1000，现在只剩 750（亏损 25%），上限 20%
    const account = makeAccount();
    account.usdt = 750;
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(true);
  });

  it("总亏损未超上限时返回 false", () => {
    // 初始 1000，现在 870（亏损 13%），上限 20%
    const account = makeAccount();
    account.usdt = 870;
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(false);
  });

  it("持仓浮盈时总资产高于初始值，返回 false", () => {
    const account = makeAccount({
      ETHUSDT: makePosition("ETHUSDT", 2000, 0.1), // 成本 200 USDT
    });
    account.usdt = 800;
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    // ETH 从 2000 涨到 3000，持仓市值 300 USDT，总资产 1100
    expect(checkMaxDrawdown({ ETHUSDT: 3000 }, makeConfig(5, 20))).toBe(false);
  });

  it("恰好触达上限时返回 true（边界：-20%）", () => {
    const account = makeAccount();
    account.usdt = 800; // 亏损 200/1000 = 20%
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(true);
  });
});

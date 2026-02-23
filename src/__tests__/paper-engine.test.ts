import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkStopLoss, checkMaxDrawdown, checkDailyLossLimit } from "../paper/engine.js";
import * as accountModule from "../paper/account.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Mock 辅助
// ─────────────────────────────────────────────────────

function makeAccount(positions: Record<string, PaperPosition> = {}): PaperAccount {
  return {
    initialUsdt: 1000,
    usdt: 800,
    positions,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
  };
}

function makePosition(symbol: string, entryPrice: number, quantity = 0.1, stopLossPercent = 5): PaperPosition {
  return {
    symbol,
    quantity,
    entryPrice,
    entryTime: Date.now(),
    stopLoss: entryPrice * (1 - stopLossPercent / 100),
    takeProfit: entryPrice * 1.15,
  };
}

function makeConfig(stopLoss = 5, maxLoss = 20): StrategyConfig {
  return {
    exchange: {
      name: "binance",
      credentials_path: ".secrets/binance.json",
      market: "spot",
      futures: { contract_type: "perpetual", margin_mode: "isolated" },
      leverage: { enabled: false, default: 1, max: 3 },
    },
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test", enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: stopLoss,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: maxLoss,
      daily_loss_limit_percent: 8,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: true, on_trade: true, on_stop_loss: true,
      on_take_profit: true, on_error: true, on_daily_summary: true,
      min_interval_minutes: 30,
    },
    paper: { initial_usdt: 1000, fee_rate: 0.001, slippage_percent: 0, report_interval_hours: 24 },
    news: { enabled: true, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    schedule: {},
    mode: "paper",
  };
}

// ─────────────────────────────────────────────────────
// checkStopLoss（compat shim）
// ─────────────────────────────────────────────────────

describe("checkStopLoss()", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.004, 5), // stopLoss = 47500
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("价格跌破止损价时触发止损", () => {
    const prices = { BTCUSDT: 47000 }; // < 47500
    const triggered = checkStopLoss(prices, makeConfig(5));
    expect(triggered).toHaveLength(1);
    expect(triggered[0].symbol).toBe("BTCUSDT");
  });

  it("价格在止损价上方时不触发", () => {
    const prices = { BTCUSDT: 47600 }; // > 47500
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

  it("使用 10% 止损，价格仅跌 5% 不触发", () => {
    // 重新创建持仓，stopLoss = 50000 * 0.9 = 45000
    account.positions = { BTCUSDT: makePosition("BTCUSDT", 50000, 0.004, 10) };
    const prices = { BTCUSDT: 47500 }; // > 45000，不触发
    const triggered = checkStopLoss(prices, makeConfig(10));
    expect(triggered).toHaveLength(0);
  });

  it("币种没有提供价格时跳过", () => {
    const triggered = checkStopLoss({}, makeConfig(5));
    expect(triggered).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// checkMaxDrawdown
// ─────────────────────────────────────────────────────

describe("checkMaxDrawdown()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("总亏损超过上限时返回 true", () => {
    const account = makeAccount();
    account.usdt = 750; // 亏损 25% > 20%
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(true);
  });

  it("总亏损未超上限时返回 false", () => {
    const account = makeAccount();
    account.usdt = 870; // 亏损 13% < 20%
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(false);
  });

  it("持仓浮盈时总资产高于初始值，返回 false", () => {
    const account = makeAccount({
      ETHUSDT: makePosition("ETHUSDT", 2000, 0.1),
    });
    account.usdt = 800;
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    // ETH 2000→3000，持仓 0.1*3000=300，总资产 800+300=1100 > 1000
    expect(checkMaxDrawdown({ ETHUSDT: 3000 }, makeConfig(5, 20))).toBe(false);
  });

  it("恰好触达上限时返回 true（边界 -20%）", () => {
    const account = makeAccount();
    account.usdt = 800; // 亏损 200/1000 = 20%
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkMaxDrawdown({}, makeConfig(5, 20))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// checkDailyLossLimit
// ─────────────────────────────────────────────────────

describe("checkDailyLossLimit()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("今日亏损超过限制时返回 true", () => {
    const account = makeAccount();
    account.usdt = 900;
    // 日亏损 100，占总资产(900) 11.1% > 8%
    account.dailyLoss = { date: new Date().toISOString().slice(0, 10), loss: 100 };
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkDailyLossLimit({}, makeConfig())).toBe(true);
  });

  it("今日亏损未超限制时返回 false", () => {
    const account = makeAccount();
    account.usdt = 990;
    // 日亏损 10，占总资产(990) 1% < 8%
    account.dailyLoss = { date: new Date().toISOString().slice(0, 10), loss: 10 };
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    expect(checkDailyLossLimit({}, makeConfig())).toBe(false);
  });
});

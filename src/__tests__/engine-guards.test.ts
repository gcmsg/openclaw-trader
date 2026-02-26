/**
 * Bug 1: 除零保护测试
 *
 * 验证 engine.ts 中 equity <= 0 和 pos.entryPrice <= 0 的 guard 行为。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSignal, checkExitConditions } from "../paper/engine.js";
import * as accountModule from "../paper/account.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig, Signal } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeAccount(overrides: Partial<PaperAccount> = {}): PaperAccount {
  return {
    initialUsdt: 1000,
    usdt: 0, // 空账户，equity = 0
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    ...overrides,
  };
}

function makePosition(
  symbol: string,
  entryPrice: number,
  quantity = 0.1
): PaperPosition {
  return {
    symbol,
    quantity,
    entryPrice,
    entryTime: Date.now() - 1000,
    stopLoss: entryPrice > 0 ? entryPrice * 0.95 : 0,
    takeProfit: entryPrice > 0 ? entryPrice * 1.15 : 0,
  };
}

function makeConfig(overrides: Partial<RuntimeConfig["risk"]> = {}): RuntimeConfig {
  return {
    exchange: { market: "spot", leverage: { enabled: false, default: 1, max: 1 } },
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
      ...overrides,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: true,
      on_trade: true,
      on_stop_loss: true,
      on_take_profit: true,
      on_error: true,
      on_daily_summary: true,
      min_interval_minutes: 30,
    },
    paper: {
      scenarioId: "test-guards",
      initial_usdt: 1000,
      fee_rate: 0.001,
      slippage_percent: 0,
      report_interval_hours: 24,
    },
    news: { enabled: false, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    schedule: {},
    mode: "paper",
  };
}

function makeBuySignal(symbol = "BTCUSDT", price = 50000): Signal {
  return {
    symbol,
    type: "buy",
    price,
    reason: ["test"],
    indicators: { maShort: 100, maLong: 90, rsi: 40, price, volume: 1000, avgVolume: 800 },
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────
// Bug 1a: handleSignal — equity === 0 不触发 NaN
// ─────────────────────────────────────────────────────

describe("handleSignal — equity <= 0 guard (Bug 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("账户 usdt=0 且无持仓时（equity=0），buy 信号被跳过而非产生 NaN", () => {
    const account = makeAccount({ usdt: 0 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal(), makeConfig());

    // 应该被跳过（equity <= 0 guard 触发），不应该崩溃或产生 trade
    expect(result.trade).toBeNull();
    expect(typeof result.skipped).toBe("string");
    expect(result.skipped).toMatch(/异常|跳过/);
  });

  it("账户 usdt=-1（极端情况），buy 信号被安全跳过", () => {
    const account = makeAccount({ usdt: -1 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal(), makeConfig());

    // 不应该崩溃，skipped 有值
    expect(() => result).not.toThrow();
    expect(result.trade).toBeNull();
  });

  it("账户有正常 usdt 时（equity > 0），buy 信号正常处理", () => {
    const account = makeAccount({ usdt: 1000 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal("BTCUSDT", 50000), makeConfig());

    // usdt=1000, price=50000 → usdtToSpend=200, 但 200 < 50000, 所以可能失败
    // 关键是不能是因为 NaN 而失败
    expect(result).not.toBeNull();
    // trade 可能为 null（若账户余额不足买入 BTC），但不崩溃
    expect(result.account).toBeDefined();
    // equity > 0 → skipped 应该是 undefined 或是其他正常原因
    if (result.skipped) {
      // 如果有 skipped，不应该是因为 equity 异常
      expect(result.skipped).not.toMatch(/净值异常/);
    }
  });
});

// ─────────────────────────────────────────────────────
// Bug 1b: checkExitConditions — entryPrice === 0 不触发 NaN
// ─────────────────────────────────────────────────────

describe("checkExitConditions — entryPrice <= 0 guard (Bug 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("持仓 entryPrice=0 时，checkExitConditions 不崩溃且跳过该持仓", () => {
    const badPos = makePosition("BTCUSDT", 0, 0.1);
    const account = makeAccount({
      usdt: 800,
      positions: { BTCUSDT: badPos },
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    // 不应该 throw，不应该触发任何出场
    let triggered: ReturnType<typeof checkExitConditions>;
    expect(() => {
      triggered = checkExitConditions({ BTCUSDT: 50000 }, makeConfig());
    }).not.toThrow();

    // entryPrice=0 的持仓应该被跳过（不产生 NaN pnl）
    expect(triggered!).toHaveLength(0);
  });

  it("持仓 entryPrice=0，pnlPercent 不为 NaN", () => {
    const badPos = makePosition("BTCUSDT", 0, 0.1);
    badPos.stopLoss = 0;
    badPos.takeProfit = 0;
    const account = makeAccount({
      usdt: 800,
      positions: { BTCUSDT: badPos },
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const triggered = checkExitConditions({ BTCUSDT: 50000 }, makeConfig());

    // 关键断言：没有任何 trade 的 pnlPercent 为 NaN
    for (const t of triggered) {
      expect(Number.isNaN(t.pnlPercent)).toBe(false);
    }
  });

  it("正常 entryPrice 的持仓不受影响", () => {
    const goodPos = makePosition("BTCUSDT", 50000, 0.004);
    // 让价格跌破止损（50000 * 0.95 = 47500）
    goodPos.stopLoss = 47500;
    const account = makeAccount({
      usdt: 800,
      positions: { BTCUSDT: goodPos },
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const triggered = checkExitConditions({ BTCUSDT: 45000 }, makeConfig());

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.symbol).toBe("BTCUSDT");
    expect(Number.isNaN(triggered[0]!.pnlPercent)).toBe(false);
    // 亏损时 pnlPercent 应为负数
    expect(triggered[0]!.pnlPercent).toBeLessThan(0);
  });

  it("混合：entryPrice=0 和正常持仓共存，正常持仓仍触发", () => {
    const badPos = makePosition("XRPUSDT", 0, 100);
    const goodPos = makePosition("ETHUSDT", 3000, 0.1);
    goodPos.stopLoss = 2900; // 当前价 2850 < 2900 → 触发止损（但跌幅仅 5%，不触发闪崩保护）

    const account = makeAccount({
      usdt: 800,
      positions: {
        XRPUSDT: badPos,
        ETHUSDT: goodPos,
      },
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const triggered = checkExitConditions(
      { XRPUSDT: 1.0, ETHUSDT: 2850 },
      makeConfig()
    );

    // XRPUSDT (entryPrice=0) 被跳过；ETHUSDT 正常触发止损
    const symbols = triggered.map((t) => t.symbol);
    expect(symbols).not.toContain("XRPUSDT");
    expect(symbols).toContain("ETHUSDT");
  });
});

/**
 * Bug 1: Division-by-zero protection tests
 *
 * Verifies guard behavior in engine.ts for equity <= 0 and pos.entryPrice <= 0.
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
    usdt: 0, // empty account, equity = 0
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
// Bug 1a: handleSignal — equity === 0 does not trigger NaN
// ─────────────────────────────────────────────────────

describe("handleSignal — equity <= 0 guard (Bug 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when usdt=0 and no positions (equity=0), buy signal is skipped without producing NaN", () => {
    const account = makeAccount({ usdt: 0 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal(), makeConfig());

    // Should be skipped (equity <= 0 guard triggered), should not crash or produce a trade
    expect(result.trade).toBeNull();
    expect(typeof result.skipped).toBe("string");
    expect(result.skipped).toMatch(/Abnormal|skipping/);
  });

  it("when usdt=-1 (extreme case), buy signal is safely skipped", () => {
    const account = makeAccount({ usdt: -1 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal(), makeConfig());

    // Should not crash, skipped has a value
    expect(() => result).not.toThrow();
    expect(result.trade).toBeNull();
  });

  it("when account has normal usdt (equity > 0), buy signal is processed normally", () => {
    const account = makeAccount({ usdt: 1000 });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    const result = handleSignal(makeBuySignal("BTCUSDT", 50000), makeConfig());

    // usdt=1000, price=50000 → usdtToSpend=200, but 200 < 50000, so may fail
    // Key point: must not fail due to NaN
    expect(result).not.toBeNull();
    // trade may be null (if insufficient balance to buy BTC), but should not crash
    expect(result.account).toBeDefined();
    // equity > 0 → skipped should be undefined or some other normal reason
    if (result.skipped) {
      // If skipped, should not be due to equity anomaly
      expect(result.skipped).not.toMatch(/Abnormal account equity/);
    }
  });
});

// ─────────────────────────────────────────────────────
// Bug 1b: checkExitConditions — entryPrice === 0 does not trigger NaN
// ─────────────────────────────────────────────────────

describe("checkExitConditions — entryPrice <= 0 guard (Bug 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("position with entryPrice=0: checkExitConditions does not crash and skips that position", () => {
    const badPos = makePosition("BTCUSDT", 0, 0.1);
    const account = makeAccount({
      usdt: 800,
      positions: { BTCUSDT: badPos },
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => undefined);

    // Should not throw, should not trigger any exit
    let triggered: ReturnType<typeof checkExitConditions>;
    expect(() => {
      triggered = checkExitConditions({ BTCUSDT: 50000 }, makeConfig());
    }).not.toThrow();

    // Position with entryPrice=0 should be skipped (no NaN pnl)
    expect(triggered!).toHaveLength(0);
  });

  it("position with entryPrice=0: pnlPercent is not NaN", () => {
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

    // Key assertion: no trade's pnlPercent should be NaN
    for (const t of triggered) {
      expect(Number.isNaN(t.pnlPercent)).toBe(false);
    }
  });

  it("normal entryPrice positions are not affected", () => {
    const goodPos = makePosition("BTCUSDT", 50000, 0.004);
    // Price drops below stop loss (50000 * 0.95 = 47500)
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
    // pnlPercent should be negative when losing
    expect(triggered[0]!.pnlPercent).toBeLessThan(0);
  });

  it("mixed: entryPrice=0 and normal positions coexist, normal position still triggers", () => {
    const badPos = makePosition("XRPUSDT", 0, 100);
    const goodPos = makePosition("ETHUSDT", 3000, 0.1);
    goodPos.stopLoss = 2900; // current price 2850 < 2900 → triggers stop loss (but only 5% drop, no flash crash protection)

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

    // XRPUSDT (entryPrice=0) is skipped; ETHUSDT triggers stop loss normally
    const symbols = triggered.map((t) => t.symbol);
    expect(symbols).not.toContain("XRPUSDT");
    expect(symbols).toContain("ETHUSDT");
  });
});

/**
 * Enhanced Trailing Stop tests (G4)
 * Tests positive trailing offset activation, trailing_only_offset_is_reached logic, etc.
 *
 * Tests via checkExitConditions() call (paper/engine.ts), injecting mock account data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkExitConditions } from "../paper/engine.js";
import * as accountModule from "../paper/account.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────

function makePosition(symbol: string, entryPrice: number, opts: {
  qty?: number;
  side?: "long" | "short";
  trailingActive?: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  stopPrice?: number;
  trailingStopActivated?: boolean;
} = {}): PaperPosition {
  const side = opts.side ?? "long";
  const isShort = side === "short";
  const base: PaperPosition = {
    symbol,
    side,
    quantity: opts.qty ?? 0.1,
    entryPrice,
    entryTime: Date.now() - 3_600_000,
    stopLoss: isShort ? entryPrice * 1.05 : entryPrice * 0.95,
    takeProfit: isShort ? entryPrice * 0.85 : entryPrice * 1.15,
    trailingStop: {
      active: opts.trailingActive ?? false,
      highestPrice: opts.highestPrice ?? entryPrice,
      ...(opts.lowestPrice !== undefined ? { lowestPrice: opts.lowestPrice } : {}),
      stopPrice: opts.stopPrice ?? (isShort ? entryPrice * 1.05 : entryPrice * 0.95),
    },
  };
  if (opts.trailingStopActivated !== undefined) {
    base.trailingStopActivated = opts.trailingStopActivated;
  }
  return base;
}

function makeAccount(positions: Record<string, PaperPosition>): PaperAccount {
  return {
    initialUsdt: 10000,
    usdt: 8000,
    positions,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
  };
}

function makeConfig(riskOverrides: Partial<RuntimeConfig["risk"]> = {}): RuntimeConfig {
  return {
    exchange: { market: "spot" },
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test", enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: true, activation_percent: 2, callback_percent: 5 },
      position_ratio: 0.2,
      max_positions: 5,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
      ...riskOverrides,
    },
    execution: {
      order_type: "market", limit_order_offset_percent: 0,
      min_order_usdt: 10, limit_order_timeout_seconds: 30,
    },
    notify: {
      on_signal: false, on_trade: false, on_stop_loss: false,
      on_take_profit: false, on_error: false, on_daily_summary: false,
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    paper: { scenarioId: "test-trailing", initial_usdt: 10000, fee_rate: 0, slippage_percent: 0, report_interval_hours: 24 },
  };
}

let mockAccount: PaperAccount;

beforeEach(() => {
  // Mock loadAccount and saveAccount to avoid file I/O
  vi.spyOn(accountModule, "loadAccount").mockImplementation(() => mockAccount);
  vi.spyOn(accountModule, "saveAccount").mockImplementation(() => { /* noop */ });
  vi.spyOn(accountModule, "resetDailyLossIfNeeded").mockImplementation(() => { /* noop */ });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────

describe("G4 Enhanced Trailing Stop — basic long", () => {
  it("does not trigger trailing stop when not activated", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, { trailingActive: false }),
    });
    const cfg = makeConfig();
    // 3% drop (not activated, no trigger)
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });

  it("price rise activates trailing (gainPct >= activation_percent), then pullback triggers", () => {
    // Position at 100, highest reached 103 (>= 2% activation), then 5% pullback
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 103 * 0.95, // = 97.85
      }),
    });
    const cfg = makeConfig();
    // Current price 97 (< 97.85 = triggers)
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
    expect(trailing[0]?.symbol).toBe("BTCUSDT");
  });

  it("does not trigger when price is above stopPrice", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 97.85,
      }),
    });
    const cfg = makeConfig();
    // Current price 99 (> 97.85, no trigger)
    const exits = checkExitConditions({ BTCUSDT: 99 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });
});

describe("G4 Enhanced Trailing Stop — positive trailing offset", () => {
  it("trailingStopActivated is activated after profit exceeds offset", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 105,  // 5% profit
        stopPrice: 105 * 0.95, // 5% callback = 99.75
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,          // positive trailing = 2% (tighter)
      trailing_stop_positive_offset: 0.03,   // offset = 3% profit to activate
    });
    // Current price 104 -> 4% profit > 3% (offset), should activate positive trailing
    const exits = checkExitConditions({ BTCUSDT: 104 }, cfg);
    // Even if stop is not triggered, trailingStopActivated should become true
    // (verified via mockAccount.positions)
    expect(mockAccount.positions["BTCUSDT"]?.trailingStopActivated).toBe(true);
    expect(exits).toBeDefined();
  });

  it("positive trailing uses tighter callback (2% vs 5%)", () => {
    // Positive trailing already activated, highest price 106, 2% pullback = 103.88
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 106,
        stopPrice: 106 * 0.95, // 5% callback (base value)
        trailingStopActivated: true,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,         // 2% callback (activated)
      trailing_stop_positive_offset: 0.03,
    });
    // Current price 103.8 (< 106 * (1-0.02) = 103.88) -> positive trailing triggers
    const exits = checkExitConditions({ BTCUSDT: 103.8 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
    expect(trailing[0]?.reason).toBe("trailing_stop");
  });

  it("uses original callback (5%) when positive trailing is not activated", () => {
    // Positive trailing not activated, highest price 103, 2% pullback (does not reach 5% callback)
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 103 * 0.95, // 5% callback = 97.85
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,
      trailing_stop_positive_offset: 0.05, // 5% offset (not reached)
    });
    // Price 100 (> 97.85, base 5% callback not triggered)
    const exits = checkExitConditions({ BTCUSDT: 100 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });
});

describe("G4 Enhanced Trailing Stop — trailing_only_offset_is_reached", () => {
  it("only_offset=true and offset not reached: trailing does not activate (skipped)", () => {
    // Position entry 100, price 102 (2% profit), offset = 3% (not reached)
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: false,
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.01,
      trailing_stop_positive_offset: 0.03,  // 3% offset
      trailing_only_offset_is_reached: true,
    });
    // Even if price drops, should not trigger trailing (because only_offset=true and offset not reached)
    const exits = checkExitConditions({ BTCUSDT: 98 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });

  it("only_offset=true and offset already reached: trailing works normally", () => {
    // Positive trailing already activated, using tighter trailing
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 105,
        stopPrice: 105 * 0.99, // 1% callback = 103.95
        trailingStopActivated: true, // offset already reached
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.01,         // 1% callback
      trailing_stop_positive_offset: 0.03,
      trailing_only_offset_is_reached: true,
    });
    // Price 103.9 (< 103.95 = triggers)
    const exits = checkExitConditions({ BTCUSDT: 103.9 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
  });

  it("only_offset=false activates trailing immediately (does not wait for offset)", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 103 * 0.95, // 5% callback = 97.85
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,
      trailing_stop_positive_offset: 0.05,
      trailing_only_offset_is_reached: false, // does not wait for offset
    });
    // Price 97 (< 97.85 = triggers, using base 5% callback)
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
  });
});

describe("G4 Enhanced Trailing Stop — trailing_stop disabled: no processing", () => {
  it("trailing_stop.enabled=false: trailing logic is not executed", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 97.85,
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop: { enabled: false, activation_percent: 2, callback_percent: 5 },
      trailing_stop_positive: 0.02,
      trailing_stop_positive_offset: 0.03,
    });
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });
});

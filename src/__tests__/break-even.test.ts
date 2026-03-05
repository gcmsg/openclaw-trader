/**
 * P8.1 Break-Even Stop + Custom Stoploss Tests
 *
 * Covers:
 * - calcBreakEvenStop pure function (long/short/boundary/no-retreat)
 * - resolveNewStopLoss composite function (priority/hard floor/customStoploss)
 * - paper/engine checkExitConditions integration
 * - live/executor checkExitConditions integration (mock)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calcBreakEvenStop, resolveNewStopLoss } from "../strategy/break-even.js";
import type { RiskConfig } from "../types.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Helpers for pure function tests
// ─────────────────────────────────────────────────────

function makeRiskCfg(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    stop_loss_percent: 5,
    take_profit_percent: 10,
    trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
    position_ratio: 0.2,
    max_positions: 4,
    max_position_per_symbol: 0.3,
    max_total_loss_percent: 20,
    daily_loss_limit_percent: 8,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// calcBreakEvenStop tests — long
// ─────────────────────────────────────────────────────

describe("calcBreakEvenStop — long", () => {
  it("profitRatio < breakEvenProfit -> does not trigger, returns null", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.02, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("profitRatio === breakEvenProfit -> just triggers", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.03, 0.03, 0.001);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(1000 * 1.001); // 1001
  });

  it("profitRatio > breakEvenProfit -> triggers", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(1001);
  });

  it("calculation correct: newStop = entryPrice * (1 + breakEvenStop)", () => {
    const result = calcBreakEvenStop("long", 50000, 47500, 0.04, 0.03, 0.002);
    // 50000 * 1.002 = 50100
    expect(result).toBeCloseTo(50100);
  });

  it("new stop <= current stop -> does not update (no retreat), returns null", () => {
    // Stop already moved to 1001, recalculation should not retreat
    const result = calcBreakEvenStop("long", 1000, 1001, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("new stop == current stop -> does not update (equality does not trigger)", () => {
    // currentStopLoss == newStop -> no update
    const result = calcBreakEvenStop("long", 1000, 1001, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("new stop > current stop -> updates normally", () => {
    // currentStopLoss at 950, break-even target at 1001 -> update
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(1001);
    expect(result!).toBeGreaterThan(950);
  });

  it("breakEvenStop = 0 -> stop moves to entry price", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0);
    expect(result).toBeCloseTo(1000);
  });
});

// ─────────────────────────────────────────────────────
// calcBreakEvenStop tests — short
// ─────────────────────────────────────────────────────

describe("calcBreakEvenStop — short", () => {
  it("profitRatio < breakEvenProfit -> does not trigger, returns null", () => {
    const result = calcBreakEvenStop("short", 1000, 1050, 0.02, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("profitRatio === breakEvenProfit -> just triggers", () => {
    const result = calcBreakEvenStop("short", 1000, 1050, 0.03, 0.03, 0.001);
    expect(result).not.toBeNull();
    // Short: newStop = entryPrice * (1 - breakEvenStop) = 999
    expect(result).toBeCloseTo(999);
  });

  it("calculation correct: newStop = entryPrice * (1 - breakEvenStop)", () => {
    const result = calcBreakEvenStop("short", 50000, 52500, 0.05, 0.03, 0.002);
    // 50000 * (1 - 0.002) = 49900
    expect(result).toBeCloseTo(49900);
  });

  it("short: new stop >= current stop -> does not update (no retreat)", () => {
    // Current stop 999 (already optimized below entry), break-even gives 999 again, no update
    const result = calcBreakEvenStop("short", 1000, 999, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("short: new stop < current stop -> updates normally", () => {
    // currentStopLoss = 1050, break-even target at 999 -> update
    const result = calcBreakEvenStop("short", 1000, 1050, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(999);
    expect(result!).toBeLessThan(1050);
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss tests — basic break-even logic
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — basic break-even logic", () => {
  it("returns null when break_even_profit is not configured", () => {
    const riskCfg = makeRiskCfg(); // no break_even_profit
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("returns null when break_even_profit is configured but not reached", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03 });
    // profitRatio = 0.02 < 0.03
    const result = resolveNewStopLoss("long", 1000, 950, 1020, 0.02, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("returns new stop loss price when break_even_profit is reached", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 1030, 0.03, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(1001);
  });

  it("break_even_stop defaults to 0.001 (when not configured)", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03 }); // no break_even_stop
    const result = resolveNewStopLoss("long", 1000, 950, 1030, 0.05, 3600_000, "BTCUSDT", riskCfg);
    // default breakEvenStop = 0.001 -> 1000 * 1.001 = 1001
    expect(result).toBeCloseTo(1001);
  });

  it("short direction: returns correct new stop loss when break_even_profit is reached", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    // Short: profitRatio = 0.05 >= 0.03 -> newStop = 1000 * (1 - 0.001) = 999
    const result = resolveNewStopLoss("short", 1000, 1050, 950, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(999);
  });

  it("new stop does not retreat: already at break-even position, no further update", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    // currentStopLoss already at 1001 (break-even target position)
    const result = resolveNewStopLoss("long", 1000, 1001, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("break_even does not trigger when in loss (negative profitRatio)", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 980, -0.02, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss tests — hard floor protection
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — hard floor protection", () => {
  it("long: customStoploss returns value below hard floor, clamped up but still <= current stop -> null", () => {
    // stop_loss_percent = 5% -> hardFloor = 1000 * 0.95 = 950
    // currentStopLoss = 960 (already above hardFloor)
    // customStoploss returns 900 -> clamped to 950 -> 950 < 960 -> null
    const riskCfg = makeRiskCfg({ stop_loss_percent: 5 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 900, // below hardFloor
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 960, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeNull();
  });

  it("long: customStoploss returns valid value above hard floor, returns normally", () => {
    // stop_loss_percent = 5% -> hardFloor = 950
    // currentStopLoss = 950, customStoploss -> 970
    const riskCfg = makeRiskCfg({ stop_loss_percent: 5 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 970,
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(970);
  });

  it("short: customStoploss returns value above hard ceiling, clamped but still >= current stop -> null", () => {
    // stop_loss_percent = 5% -> hardCeiling = 1000 * 1.05 = 1050
    // currentStopLoss = 1040
    // customStoploss returns 1100 -> clamped to 1050 -> 1050 > 1040 -> worse for short -> null
    const riskCfg = makeRiskCfg({ stop_loss_percent: 5 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 1100,
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("short", 1000, 1040, 950, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeNull();
  });

  it("short: customStoploss returns valid value below current stop, returns normally", () => {
    // currentStopLoss = 1050, customStoploss -> 1010 (lower = better for short)
    const riskCfg = makeRiskCfg({ stop_loss_percent: 5 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 1010,
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("short", 1000, 1050, 950, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(1010);
  });

  it("long full scenario: profit triggers break-even, stop moves from 9500 to 10100", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.01, stop_loss_percent: 5 });
    const result = resolveNewStopLoss("long", 10000, 9500, 10500, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(10100); // 10000 * 1.01 = 10100
  });

  it("short full scenario: profit triggers break-even, stop moves from 10500 to 9990", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001, stop_loss_percent: 5 });
    const result = resolveNewStopLoss("short", 10000, 10500, 9500, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(9990); // 10000 * (1 - 0.001) = 9990
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss tests — customStoploss priority
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — customStoploss priority", () => {
  it("customStoploss return value takes priority over break_even logic", () => {
    // break_even would give 1001, but customStoploss gives 1010
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 1010,
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(1010); // not 1001
  });

  it("customStoploss returns null -> falls back to break_even logic", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => null, // fallback
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(1001); // break-even
  });

  it("strategy exists but ctx = undefined -> does not call customStoploss, falls back to break_even", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const mockCustomStoploss = vi.fn().mockReturnValue(1010);
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: mockCustomStoploss,
    };
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, undefined);
    expect(mockCustomStoploss).not.toHaveBeenCalled();
    expect(result).toBeCloseTo(1001); // break-even fallback
  });

  it("no strategy -> only uses break_even logic", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, undefined, undefined);
    expect(result).toBeCloseTo(1001);
  });

  it("customStoploss is called with correct position parameters", () => {
    const riskCfg = makeRiskCfg();
    const mockCustomStoploss = vi.fn().mockReturnValue(970);
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: mockCustomStoploss,
    };
    const ctx = { cfg: {} } as unknown as StrategyContext;
    resolveNewStopLoss("long", 1000, 950, 1040, 0.04, 7200_000, "ETHUSDT", riskCfg, strategy, ctx);

    expect(mockCustomStoploss).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "ETHUSDT",
        side: "long",
        entryPrice: 1000,
        currentPrice: 1040,
        currentStopLoss: 950,
        profitRatio: 0.04,
        holdMs: 7200_000,
      }),
      ctx
    );
  });

  it("strategy exists but customStoploss field is missing -> uses break_even", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      // no customStoploss field
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(1001); // break-even
  });
});

// ─────────────────────────────────────────────────────
// Paper Engine integration tests
// ─────────────────────────────────────────────────────

import * as accountModule from "../paper/account.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig } from "../types.js";
import { checkExitConditions } from "../paper/engine.js";

function makeEnginePosition(
  symbol: string,
  entryPrice: number,
  opts: { side?: "long" | "short"; stopLoss?: number; takeProfit?: number } = {}
): PaperPosition {
  const side = opts.side ?? "long";
  const isShort = side === "short";
  return {
    symbol,
    side,
    quantity: 0.1,
    entryPrice,
    entryTime: Date.now() - 3_600_000,
    stopLoss: opts.stopLoss ?? (isShort ? entryPrice * 1.05 : entryPrice * 0.95),
    takeProfit: opts.takeProfit ?? (isShort ? entryPrice * 0.85 : entryPrice * 1.15),
    trailingStop: {
      active: false,
      highestPrice: entryPrice,
      stopPrice: isShort ? entryPrice * 1.05 : entryPrice * 0.95,
    },
  };
}

function makeEngineAccount(positions: Record<string, PaperPosition>): PaperAccount {
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

function makeEngineConfig(riskOverrides: Partial<RuntimeConfig["risk"]> = {}): RuntimeConfig {
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
      trailing_stop: { enabled: false, activation_percent: 2, callback_percent: 5 },
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
    paper: {
      scenarioId: "test-break-even",
      initial_usdt: 10000,
      fee_rate: 0,
      slippage_percent: 0,
      report_interval_hours: 24,
    },
  };
}

let mockEngineAccount: PaperAccount;

describe("Engine integration — checkExitConditions break-even", () => {
  beforeEach(() => {
    vi.spyOn(accountModule, "loadAccount").mockImplementation(() => mockEngineAccount);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => { /* noop */ });
    vi.spyOn(accountModule, "resetDailyLossIfNeeded").mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("break_even triggered -> updates pos.stopLoss", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // Current price 1050 -> profitRatio = 0.05 >= 0.03 -> triggers
    checkExitConditions({ BTCUSDT: 1050 }, cfg);

    // pos.stopLoss should be updated to 1001
    expect(pos.stopLoss).toBeCloseTo(1001);
  });

  it("break_even not triggered -> pos.stopLoss unchanged", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // Current price 1020 -> profitRatio = 0.02 < 0.03 -> does not trigger
    checkExitConditions({ BTCUSDT: 1020 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(950); // unchanged
  });

  it("break_even update results in correct stopLoss value", () => {
    // Verify break_even calculation correctness
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.002 });

    // Current price 1050 -> profitRatio = 0.05 -> triggers
    // newStop = 1000 * (1 + 0.002) = 1002
    checkExitConditions({ BTCUSDT: 1050 }, cfg);
    expect(pos.stopLoss).toBeCloseTo(1002);
  });

  it("short break_even triggered -> updates pos.stopLoss (lowers stop loss)", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { side: "short", stopLoss: 1050 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // Short current price 950 -> profitRatio = 0.05 >= 0.03 -> triggers
    // newStop = 1000 * (1 - 0.001) = 999
    checkExitConditions({ BTCUSDT: 950 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(999);
    expect(pos.stopLoss).toBeLessThan(1050);
  });

  it("break_even_profit not configured -> stopLoss unchanged", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig(); // no break_even_profit

    checkExitConditions({ BTCUSDT: 1050 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(950); // unchanged
  });
});

// ─────────────────────────────────────────────────────
// Executor integration tests (all modules mocked)
// ─────────────────────────────────────────────────────

const {
  mockPlaceStopLossOrder,
  mockCancelOrder,
  mockGetOrder,
  mockSendTelegramMessage,
  mockLoadAccount,
  mockSaveAccount,
  mockResetDailyLossIfNeeded,
  mockCalcTotalEquity,
} = vi.hoisted(() => ({
  mockPlaceStopLossOrder: vi.fn(),
  mockCancelOrder: vi.fn(),
  mockGetOrder: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockLoadAccount: vi.fn(),
  mockSaveAccount: vi.fn(),
  mockResetDailyLossIfNeeded: vi.fn(),
  mockCalcTotalEquity: vi.fn().mockReturnValue(10000),
}));

vi.mock("../exchange/binance-client.js", () => ({
  BinanceClient: vi.fn().mockImplementation(() => ({
    placeStopLossOrder: mockPlaceStopLossOrder,
    cancelOrder: mockCancelOrder,
    getOrder: mockGetOrder,
    marketSell: vi.fn(),
    marketBuyByQty: vi.fn(),
    getUsdtBalance: vi.fn(),
    marketBuy: vi.fn(),
    placeTakeProfitOrder: vi.fn(),
    ping: vi.fn().mockResolvedValue(true),
    getFuturesPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getSymbolInfo: vi.fn().mockResolvedValue({ stepSize: 0.00001 }),
  })),
}));

vi.mock("../paper/account.js", () => ({
  loadAccount: mockLoadAccount,
  saveAccount: mockSaveAccount,
  resetDailyLossIfNeeded: mockResetDailyLossIfNeeded,
  calcTotalEquity: mockCalcTotalEquity,
  registerOrder: vi.fn(),
  confirmOrder: vi.fn(),
  getTimedOutOrders: vi.fn().mockReturnValue([]),
  cancelOrder: vi.fn(),
  cleanupOrders: vi.fn(),
  getAccountSummary: vi.fn().mockReturnValue({}),
  paperBuy: vi.fn(),
  paperSell: vi.fn(),
  paperOpenShort: vi.fn(),
  paperCoverShort: vi.fn(),
  paperDcaAdd: vi.fn(),
  updateTrailingStop: vi.fn().mockReturnValue(false),
}));

vi.mock("../notify/openclaw.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  notifySignal: vi.fn(),
  notifyTrade: vi.fn(),
  notifyPaperTrade: vi.fn(),
  notifyStopLoss: vi.fn(),
  notifyError: vi.fn(),
  notifyStatus: vi.fn(),
  sendNewsReport: vi.fn(),
}));

vi.mock("../paper/engine.js", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

vi.mock("../strategy/signal-history.js", () => ({
  logSignal: vi.fn().mockReturnValue("mock-signal-id"),
  closeSignal: vi.fn(),
}));

vi.mock("../persistence/db.js", () => ({
  TradeDB: vi.fn().mockImplementation(() => ({
    insertTrade: vi.fn().mockReturnValue(1),
    closeTrade: vi.fn(),
  })),
}));

vi.mock("../strategy/indicators.js", () => ({
  calcAtrPositionSize: vi.fn().mockReturnValue(500),
}));

vi.mock("../strategy/roi-table.js", () => ({
  checkMinimalRoi: vi.fn().mockReturnValue(false),
}));

import { LiveExecutor } from "../live/executor.js";

function makeExecutorConfig(riskOverrides: Partial<RuntimeConfig["risk"]> = {}): RuntimeConfig {
  return {
    exchange: { market: "spot", testnet: true, credentials_path: ".secrets/test.json" },
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
      stop_loss_percent: 5,
      take_profit_percent: 10,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
      ...riskOverrides,
    },
    execution: {
      order_type: "market", limit_order_offset_percent: 0.1,
      min_order_usdt: 10, limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: false, on_trade: false, on_stop_loss: false,
      on_take_profit: false, on_error: false, on_daily_summary: false,
      min_interval_minutes: 30,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "testnet",
    paper: {
      scenarioId: "test-executor",
      initial_usdt: 10000,
      fee_rate: 0.001,
      slippage_percent: 0.05,
      report_interval_hours: 24,
    },
  };
}

function makeExecutorPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.01,
    entryPrice: 60000,
    entryTime: Date.now() - 3_600_000,
    stopLoss: 57000, // 5% below
    takeProfit: 66000, // 10% above
    trailingStop: { active: false, highestPrice: 60000, stopPrice: 57000 },
    ...overrides,
  };
}

function makeExecAccount(positions: Record<string, PaperPosition>): PaperAccount {
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

describe("Executor integration — checkExitConditions break-even", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCalcTotalEquity.mockReturnValue(10000);
    // Re-setup BinanceClient constructor mock (prevent other test files' clearAllMocks from breaking it)
    const mod = await import("../exchange/binance-client.js");
    vi.mocked(mod.BinanceClient).mockImplementation(() => ({
      placeStopLossOrder: mockPlaceStopLossOrder,
      cancelOrder: mockCancelOrder,
      getOrder: mockGetOrder,
      marketSell: vi.fn(),
      marketBuyByQty: vi.fn(),
      getUsdtBalance: vi.fn(),
      marketBuy: vi.fn(),
      placeTakeProfitOrder: vi.fn(),
      ping: vi.fn().mockResolvedValue(true),
      getFuturesPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getSymbolInfo: vi.fn().mockResolvedValue({ stepSize: 0.00001 }),
    }) as any);
  });

  it("break_even not triggered -> stopLoss unchanged, saveAccount not called (for break-even)", async () => {
    const pos = makeExecutorPosition();
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = (61200 - 60000) / 60000 = 0.02 < 0.03 -> does not trigger
    await executor.checkExitConditions({ BTCUSDT: 61200 });

    expect(pos.stopLoss).toBeCloseTo(57000);
    // saveAccount may be called (but not for break-even), we only check stopLoss
  });

  it("break_even triggered -> updates stopLoss and calls saveAccount", async () => {
    const pos = makeExecutorPosition();
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = (61800 - 60000) / 60000 = 0.03 -> triggers
    // newStop = 60000 * 1.001 = 60060
    await executor.checkExitConditions({ BTCUSDT: 61800 });

    expect(pos.stopLoss).toBeCloseTo(60060);
    expect(mockSaveAccount).toHaveBeenCalled();
  });

  it("break_even triggered with exchangeSlOrderId -> cancels old order and places new stop loss order", async () => {
    const pos = makeExecutorPosition({ exchangeSlOrderId: 12345, exchangeSlPrice: 57000 });
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));
    mockCancelOrder.mockResolvedValue(undefined);
    mockPlaceStopLossOrder.mockResolvedValue({ orderId: 99999 });

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = 0.03 -> break_even triggers
    await executor.checkExitConditions({ BTCUSDT: 61800 });

    // Old stop loss order should be cancelled
    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 12345);
    // New stop loss order should be placed
    expect(mockPlaceStopLossOrder).toHaveBeenCalled();
    // exchangeSlOrderId should be updated
    expect(pos.exchangeSlOrderId).toBe(99999);
    // stopLoss updated
    expect(pos.stopLoss).toBeCloseTo(60060);
  });
});

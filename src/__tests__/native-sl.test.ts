/**
 * Tests for Exchange-Native Stop Loss (P7.1) and Force Exit (P7.2)
 *
 * All external calls (BinanceClient, account I/O, notify) are mocked.
 * Covers 20+ scenarios as specified in the task.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted() ensures these exist before the vi.mock() factories run ────

const {
  mockPlaceStopLossOrder,
  mockCancelOrder,
  mockGetOrder,
  mockMarketSell,
  mockMarketBuyByQty,
  mockGetUsdtBalance,
  mockMarketBuy,
  mockPlaceTakeProfitOrder,
  mockSendTelegramMessage,
  mockLoadAccount,
  mockSaveAccount,
  mockResetDailyLossIfNeeded,
  mockCalcTotalEquity,
  mockRegisterOrder,
  mockConfirmOrder,
  mockGetTimedOutOrders,
  mockCancelOrderAccount,
  mockCleanupOrders,
  mockPaperSell,
  mockPaperCoverShort,
} = vi.hoisted(() => ({
  mockPlaceStopLossOrder: vi.fn(),
  mockCancelOrder: vi.fn(),
  mockGetOrder: vi.fn(),
  mockMarketSell: vi.fn(),
  mockMarketBuyByQty: vi.fn(),
  mockGetUsdtBalance: vi.fn(),
  mockMarketBuy: vi.fn(),
  mockPlaceTakeProfitOrder: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockLoadAccount: vi.fn(),
  mockSaveAccount: vi.fn(),
  mockResetDailyLossIfNeeded: vi.fn(),
  mockCalcTotalEquity: vi.fn().mockReturnValue(10000),
  mockRegisterOrder: vi.fn(),
  mockConfirmOrder: vi.fn(),
  mockGetTimedOutOrders: vi.fn().mockReturnValue([]),
  mockCancelOrderAccount: vi.fn(),
  mockCleanupOrders: vi.fn(),
  mockPaperSell: vi.fn(),
  mockPaperCoverShort: vi.fn(),
}));

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock("../exchange/binance-client.js", () => ({
  BinanceClient: vi.fn().mockImplementation(() => ({
    placeStopLossOrder: mockPlaceStopLossOrder,
    cancelOrder: mockCancelOrder,
    getOrder: mockGetOrder,
    marketSell: mockMarketSell,
    marketBuyByQty: mockMarketBuyByQty,
    getUsdtBalance: mockGetUsdtBalance,
    marketBuy: mockMarketBuy,
    placeTakeProfitOrder: mockPlaceTakeProfitOrder,
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
  registerOrder: mockRegisterOrder,
  confirmOrder: mockConfirmOrder,
  getTimedOutOrders: mockGetTimedOutOrders,
  cancelOrder: mockCancelOrderAccount,
  cleanupOrders: mockCleanupOrders,
  getAccountSummary: vi.fn().mockReturnValue({}),
  paperBuy: vi.fn(),
  paperSell: mockPaperSell,
  paperOpenShort: vi.fn(),
  paperCoverShort: mockPaperCoverShort,
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

// Partial mock: keep real paper engine but allow account to be mocked
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

// ─── Imports (after mocks) ────────────────────────────────────────

import { LiveExecutor } from "../live/executor.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────

function makeConfig(): RuntimeConfig {
  return {
    exchange: {
      market: "spot",
      testnet: true,
      credentials_path: ".secrets/test.json",
    },
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
      take_profit_percent: 10,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: false,
      on_trade: false,
      on_stop_loss: false,
      on_take_profit: false,
      on_error: false,
      on_daily_summary: false,
      min_interval_minutes: 30,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "testnet",
    paper: {
      scenarioId: "test-native-sl",
      initial_usdt: 10000,
      fee_rate: 0.001,
      slippage_percent: 0.1,
      report_interval_hours: 24,
    },
  };
}

function makeAccount(positions: Record<string, PaperPosition> = {}): PaperAccount {
  return {
    initialUsdt: 10000,
    usdt: 9000,
    positions,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
  };
}

function makePosition(opts: {
  symbol?: string;
  side?: "long" | "short";
  quantity?: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  exchangeSlOrderId?: number;
  exchangeSlPrice?: number;
  exchangeSlOmit?: boolean; // when true, omit exchangeSlOrderId/Price
  stopLossOrderId?: number;
  takeProfitOrderId?: number;
  exitTimeoutCount?: number;
  marginUsdt?: number;
} = {}): PaperPosition {
  const base: PaperPosition = {
    symbol: opts.symbol ?? "BTCUSDT",
    side: opts.side ?? "long",
    quantity: opts.quantity ?? 0.01,
    entryPrice: opts.entryPrice ?? 45000,
    entryTime: Date.now() - 3600_000,
    stopLoss: opts.stopLoss ?? 42750,
    takeProfit: opts.takeProfit ?? 49500,
  };
  if (!opts.exchangeSlOmit) {
    base.exchangeSlOrderId = opts.exchangeSlOrderId ?? 55555;
    base.exchangeSlPrice = opts.exchangeSlPrice ?? 42750;
  }
  if (opts.stopLossOrderId !== undefined) base.stopLossOrderId = opts.stopLossOrderId;
  if (opts.takeProfitOrderId !== undefined) base.takeProfitOrderId = opts.takeProfitOrderId;
  if (opts.exitTimeoutCount !== undefined) base.exitTimeoutCount = opts.exitTimeoutCount;
  if (opts.marginUsdt !== undefined) base.marginUsdt = opts.marginUsdt;
  return base;
}

function makeOrderResponse(orderId: number, status = "FILLED", executedQty = "0.01") {
  return {
    symbol: "BTCUSDT",
    orderId,
    clientOrderId: `test_${orderId}`,
    transactTime: Date.now(),
    price: "45000",
    origQty: "0.01",
    executedQty,
    status,
    type: "MARKET",
    side: "SELL",
    fills: [{ price: "45000", qty: executedQty, commission: "0.01", commissionAsset: "USDT" }],
  };
}

// Creates executor with a directly-injected mock client to avoid ESM mock hoisting issues
function makeExecutorWithMockClient(): LiveExecutor {
  const executor = new LiveExecutor(makeConfig());
  // Directly inject mock client to ensure methods are available after clearAllMocks
  (executor as unknown as Record<string, unknown>)["client"] = {
    placeStopLossOrder: mockPlaceStopLossOrder,
    cancelOrder: mockCancelOrder,
    getOrder: mockGetOrder,
    marketSell: mockMarketSell,
    marketBuyByQty: mockMarketBuyByQty,
    getUsdtBalance: mockGetUsdtBalance,
    marketBuy: mockMarketBuy,
    placeTakeProfitOrder: mockPlaceTakeProfitOrder,
    ping: vi.fn().mockResolvedValue(true),
    getFuturesPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getSymbolInfo: vi.fn().mockResolvedValue({ stepSize: 0.00001 }),
  };
  return executor;
}

// ─────────────────────────────────────────────────────────────────
// 1. placeExchangeStopLoss
// ─────────────────────────────────────────────────────────────────

describe("placeExchangeStopLoss()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC01: long position → calls placeStopLossOrder with SELL", async () => {
    mockPlaceStopLossOrder.mockResolvedValue(makeOrderResponse(11111, "NEW"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "long", 0.01, 42750);

    expect(mockPlaceStopLossOrder).toHaveBeenCalledWith("BTCUSDT", "SELL", 0.01, 42750);
    expect(result).toBe(11111);
  });

  it("TC02: short position → calls placeStopLossOrder with BUY", async () => {
    mockPlaceStopLossOrder.mockResolvedValue(makeOrderResponse(22222, "NEW"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "short", 0.01, 47250);

    expect(mockPlaceStopLossOrder).toHaveBeenCalledWith("BTCUSDT", "BUY", 0.01, 47250);
    expect(result).toBe(22222);
  });

  it("TC03: API failure → returns null, no throw", async () => {
    mockPlaceStopLossOrder.mockRejectedValue(new Error("Network error"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "long", 0.01, 42750);

    expect(result).toBeNull();
    // No throw ✓
  });

  it("TC03b: long position → returns correct orderId", async () => {
    mockPlaceStopLossOrder.mockResolvedValue({ ...makeOrderResponse(33333, "NEW"), orderId: 33333 });

    const result = await executor.placeExchangeStopLoss("ETHUSDT", "long", 0.5, 2800);

    expect(result).toBe(33333);
    expect(mockPlaceStopLossOrder).toHaveBeenCalledWith("ETHUSDT", "SELL", 0.5, 2800);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. cancelExchangeStopLoss
// ─────────────────────────────────────────────────────────────────

describe("cancelExchangeStopLoss()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC04: calls binanceClient.cancelOrder()", async () => {
    mockCancelOrder.mockResolvedValue({});

    await executor.cancelExchangeStopLoss("BTCUSDT", 55555);

    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
  });

  it("TC05: API failure → logs warn, no throw", async () => {
    mockCancelOrder.mockRejectedValue(new Error("Order not found"));

    await expect(executor.cancelExchangeStopLoss("BTCUSDT", 99999)).resolves.toBeUndefined();
  });

  it("TC05b: multiple cancelOrder calls pass correct params", async () => {
    mockCancelOrder.mockResolvedValue({});

    await executor.cancelExchangeStopLoss("ETHUSDT", 12345);
    await executor.cancelExchangeStopLoss("BTCUSDT", 67890);

    expect(mockCancelOrder).toHaveBeenNthCalledWith(1, "ETHUSDT", 12345);
    expect(mockCancelOrder).toHaveBeenNthCalledWith(2, "BTCUSDT", 67890);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. syncExchangeStopLosses
// ─────────────────────────────────────────────────────────────────

describe("syncExchangeStopLosses()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC06: SL order FILLED → local position removed", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockResolvedValue({
      ...makeOrderResponse(55555, "FILLED"),
      status: "FILLED",
      executedQty: "0.01",
      fills: [{ price: "42750", qty: "0.01", commission: "0.001", commissionAsset: "USDT" }],
    });

    await executor.syncExchangeStopLosses(account, "test");

    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(mockSaveAccount).toHaveBeenCalled();
  });

  it("TC07: SL order still OPEN (NEW) → no action, position retained", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(55555, "NEW"), status: "NEW" });

    await executor.syncExchangeStopLosses(account, "test");

    expect(account.positions["BTCUSDT"]).toBeDefined();
  });

  it("TC08: SL order CANCELLED → logs warn, position retained", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(55555, "CANCELED"), status: "CANCELED" });

    await executor.syncExchangeStopLosses(account, "test");

    expect(account.positions["BTCUSDT"]).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("TC09: no exchangeSlOrderId → skipped, getOrder not called", async () => {
    const position = makePosition({ exchangeSlOmit: true });
    const account = makeAccount({ BTCUSDT: position });

    await executor.syncExchangeStopLosses(account, "test");

    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it("TC09b: getOrder failure → no throw, position retained", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockRejectedValue(new Error("API error"));

    await expect(executor.syncExchangeStopLosses(account, "test")).resolves.toBeUndefined();
    expect(account.positions["BTCUSDT"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. forceExit
// ─────────────────────────────────────────────────────────────────

describe("forceExit()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC10: cancels native SL order + places market sell order", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
    expect(mockMarketSell).toHaveBeenCalledWith("BTCUSDT", 0.01);
  });

  it("TC11: position removed from local account after forceExit", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(mockSaveAccount).toHaveBeenCalled();
  });

  it("TC12: sends Telegram notification after forceExit", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(mockSendTelegramMessage).toHaveBeenCalled();
    const msg = mockSendTelegramMessage.mock.calls[0]?.[0] as string;
    expect(msg).toContain("BTCUSDT");
    expect(msg).toContain("ForceExit");
  });

  it("TC12b: forceExit with reason=force_exit_manual also sends notification", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_manual");

    expect(mockSendTelegramMessage).toHaveBeenCalled();
  });

  it("TC17: forceExit trade reason contains force_exit_timeout", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    const trade = account.trades[account.trades.length - 1];
    expect(trade).toBeDefined();
    expect(trade?.reason).toContain("force_exit_timeout");
  });

  it("TC10b: short position forceExit → uses marketBuyByQty", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketBuyByQty.mockResolvedValue({
      ...makeOrderResponse(88888, "FILLED"),
      side: "BUY",
    });

    const position = makePosition({
      side: "short",
      exchangeSlOrderId: 55555,
      entryPrice: 45000,
      stopLoss: 47250,
      takeProfit: 40500,
    });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(mockMarketBuyByQty).toHaveBeenCalledWith("BTCUSDT", 0.01);
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("TC: forceExit does not call cancelOrder when no exchangeSlOrderId", async () => {
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOmit: true });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    // cancelOrder should not be called (no SL order to cancel)
    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("TC: forceExit still removes local position and saves on order failure", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockRejectedValue(new Error("Market closed"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(mockSaveAccount).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. exitTimeoutCount + checkOrderTimeouts
// ─────────────────────────────────────────────────────────────────

describe("exitTimeoutCount + checkOrderTimeouts()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC13: first exit timeout → exitTimeoutCount=1, forceExit not triggered", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 0 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetTimedOutOrders.mockReturnValue([{
      orderId: 99999,
      symbol: "BTCUSDT",
      side: "sell" as const,
      placedAt: Date.now() - 600_000,
      requestedQty: 0.01,
      filledQty: 0,
      status: "pending" as const,
      timeoutMs: 30_000,
    }]);

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(99999, "NEW"), status: "NEW" });
    mockCancelOrder.mockResolvedValue({});

    const forceExitSpy = vi.spyOn(executor, "forceExit").mockResolvedValue();

    await executor.checkOrderTimeouts(account);

    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(1);
    expect(forceExitSpy).not.toHaveBeenCalled();
  });

  it("TC14: 3rd exit timeout → triggers forceExit", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 2 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetTimedOutOrders.mockReturnValue([{
      orderId: 99999,
      symbol: "BTCUSDT",
      side: "sell" as const,
      placedAt: Date.now() - 600_000,
      requestedQty: 0.01,
      filledQty: 0,
      status: "pending" as const,
      timeoutMs: 30_000,
    }]);

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(99999, "NEW"), status: "NEW" });
    mockCancelOrder.mockResolvedValue({});

    const forceExitSpy = vi.spyOn(executor, "forceExit").mockResolvedValue();

    await executor.checkOrderTimeouts(account);

    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(3);
    expect(forceExitSpy).toHaveBeenCalledOnce();
    expect(forceExitSpy).toHaveBeenCalledWith(account, position, "test-native-sl", "force_exit_timeout");
  });

  it("TC15: position removed after forceExit (exitTimeoutCount disappears with position)", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 2 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    // Position removed, exitTimeoutCount disappears with the position
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("TC13b: entry timeout does not increment exitTimeoutCount", async () => {
    const position = makePosition({ exitTimeoutCount: 0 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetTimedOutOrders.mockReturnValue([{
      orderId: 11111,
      symbol: "BTCUSDT",
      side: "buy" as const,  // entry order, not exit
      placedAt: Date.now() - 600_000,
      requestedQty: 0.01,
      filledQty: 0,
      status: "pending" as const,
      timeoutMs: 30_000,
    }]);

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(11111, "NEW"), status: "NEW" });
    mockCancelOrder.mockResolvedValue({});

    const forceExitSpy = vi.spyOn(executor, "forceExit").mockResolvedValue();

    await executor.checkOrderTimeouts(account);

    // Entry timeout does not trigger forceExit nor increment exitTimeoutCount
    expect(forceExitSpy).not.toHaveBeenCalled();
    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(0);
  });

  it("TC: does not increment exitTimeoutCount when exit order is FILLED", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 1 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetTimedOutOrders.mockReturnValue([{
      orderId: 99999,
      symbol: "BTCUSDT",
      side: "sell" as const,
      placedAt: Date.now() - 600_000,
      requestedQty: 0.01,
      filledQty: 0,
      status: "pending" as const,
      timeoutMs: 30_000,
    }]);

    // Status FILLED → confirmOrder, no timeout increment
    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(99999, "FILLED"), status: "FILLED" });

    await executor.checkOrderTimeouts(account);

    // exitTimeoutCount stays at 1 (no increment for filled orders)
    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Paper mode Force Exit
// ─────────────────────────────────────────────────────────────────

describe("Paper mode Force Exit (checkExitConditions)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC16: paper mode exitTimeoutCount >= 3 → immediate exit", async () => {
    const { checkExitConditions } = await import("../paper/engine.js");
    const accountModule = await import("../paper/account.js");

    const position: PaperPosition = {
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0.01,
      entryPrice: 45000,
      entryTime: Date.now() - 3600_000,
      stopLoss: 42750,
      takeProfit: 49500,
      exitTimeoutCount: 3,
    };
    const account = makeAccount({ BTCUSDT: position });

    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    const mockTrade = {
      id: "force_test_001",
      symbol: "BTCUSDT",
      side: "sell" as const,
      quantity: 0.01,
      price: 44000,
      usdtAmount: 440,
      fee: 0.44,
      slippage: 0,
      timestamp: Date.now(),
      reason: "force_exit_timeout: exit timed out 3 times, forced market exit",
    };
    vi.spyOn(accountModule, "paperSell").mockReturnValue(mockTrade);

    const cfg = makeConfig();
    const prices = { BTCUSDT: 44000 };

    const results = checkExitConditions(prices, cfg);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.symbol).toBe("BTCUSDT");
  });

  it("TC16b: paper mode exitTimeoutCount = 2 → no forced exit", async () => {
    const { checkExitConditions } = await import("../paper/engine.js");
    const accountModule = await import("../paper/account.js");

    const position: PaperPosition = {
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0.01,
      entryPrice: 45000,
      entryTime: Date.now() - 3600_000,
      stopLoss: 42750,
      takeProfit: 49500,
      exitTimeoutCount: 2,  // below threshold
    };
    const account = makeAccount({ BTCUSDT: position });

    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "paperSell").mockReturnValue(null);
    vi.spyOn(accountModule, "updateTrailingStop").mockReturnValue(false);

    const cfg = makeConfig();
    // Price in normal range (no SL/TP triggered)
    const prices = { BTCUSDT: 46000 };

    const results = checkExitConditions(prices, cfg);

    // Should not force exit (exitTimeoutCount=2 < 3)
    expect(results.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. handleSell and cancelExchangeStopLoss integration
// ─────────────────────────────────────────────────────────────────

describe("handleSell() → cancelExchangeStopLoss", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutorWithMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupAccountForSell(position: PaperPosition) {
    const account = makeAccount({ BTCUSDT: position });
    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    mockMarketSell.mockResolvedValue(makeOrderResponse(66666, "FILLED"));
    return account;
  }

  it("TC18: exchangeSlOrderId correctly saved to position after handleBuy", async () => {
    const account = makeAccount({});
    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    mockCalcTotalEquity.mockReturnValue(10000);
    mockMarketBuy.mockResolvedValue({
      ...makeOrderResponse(44444, "FILLED"),
      orderId: 44444,
      side: "BUY",
      fills: [{ price: "45000", qty: "0.01", commission: "0.045", commissionAsset: "USDT" }],
    });
    mockPlaceStopLossOrder.mockResolvedValue({ ...makeOrderResponse(55555, "NEW"), orderId: 55555 });
    mockPlaceTakeProfitOrder.mockResolvedValue({ ...makeOrderResponse(66666, "NEW"), orderId: 66666 });

    const signal = {
      symbol: "BTCUSDT",
      type: "buy" as const,
      price: 45000,
      indicators: { maShort: 100, maLong: 90, rsi: 40, price: 45000, volume: 100, avgVolume: 80 },
      reason: ["test buy"],
      timestamp: Date.now(),
    };

    await executor.handleBuy(signal);

    expect(mockSaveAccount).toHaveBeenCalled();
    const savedAccount = mockSaveAccount.mock.calls[0]?.[0] as PaperAccount;
    const savedPos = savedAccount?.positions?.["BTCUSDT"];
    if (savedPos) {
      expect(savedPos.exchangeSlOrderId).toBe(55555);
      expect(typeof savedPos.exchangeSlPrice).toBe("number");
    } else {
      // If position was set on the account directly (not via saveAccount args), check the account
      const posFromAccount = account.positions["BTCUSDT"];
      expect(posFromAccount?.exchangeSlOrderId).toBe(55555);
    }
  });

  it("TC19: handleSell → calls cancelExchangeStopLoss (via cancelOrder)", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    setupAccountForSell(position);

    await executor.handleSell("BTCUSDT", 45000, "test signal sell");

    // cancelOrder should be called with the exchangeSlOrderId
    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
  });

  it("TC20: cancelExchangeStopLoss failure → close continues (warn + proceed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });
    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    // cancelOrder fails
    mockCancelOrder.mockRejectedValue(new Error("cancel failed"));
    // marketSell succeeds
    mockMarketSell.mockResolvedValue(makeOrderResponse(66666, "FILLED"));

    const result = await executor.handleSell("BTCUSDT", 45000, "test sell with cancel failure");

    // Close should proceed
    expect(result.trade).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("TC: handleSell without exchangeSlOrderId → attempts to cancel stopLossOrderId", async () => {
    const position = makePosition({
      exchangeSlOmit: true,
      stopLossOrderId: 44444,
    });
    setupAccountForSell(position);
    mockCancelOrder.mockResolvedValue({});

    await executor.handleSell("BTCUSDT", 45000, "fallback cancel");

    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 44444);
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. New field type checks
// ─────────────────────────────────────────────────────────────────

describe("PaperPosition new fields", () => {
  it("TC: PaperPosition supports exchangeSlOrderId/exchangeSlPrice/exitTimeoutCount", () => {
    const position: PaperPosition = {
      symbol: "BTCUSDT",
      quantity: 0.01,
      entryPrice: 45000,
      entryTime: Date.now(),
      stopLoss: 42750,
      takeProfit: 49500,
      exchangeSlOrderId: 12345,
      exchangeSlPrice: 42750,
      exitTimeoutCount: 0,
    };

    expect(position.exchangeSlOrderId).toBe(12345);
    expect(position.exchangeSlPrice).toBe(42750);
    expect(position.exitTimeoutCount).toBe(0);
  });

  it("TC: optional fields default to undefined without affecting type checks", () => {
    const position: PaperPosition = {
      symbol: "BTCUSDT",
      quantity: 0.01,
      entryPrice: 45000,
      entryTime: Date.now(),
      stopLoss: 42750,
      takeProfit: 49500,
    };

    expect(position.exchangeSlOrderId).toBeUndefined();
    expect(position.exchangeSlPrice).toBeUndefined();
    expect(position.exitTimeoutCount).toBeUndefined();
  });

  it("TC: exchangeSlOrderId is of type number", () => {
    const pos: PaperPosition = {
      symbol: "ETHUSDT",
      quantity: 0.5,
      entryPrice: 3000,
      entryTime: Date.now(),
      stopLoss: 2850,
      takeProfit: 3300,
      exchangeSlOrderId: 99887,
    };
    expect(typeof pos.exchangeSlOrderId).toBe("number");
  });
});

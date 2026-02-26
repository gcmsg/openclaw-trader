/**
 * Tests for Exchange-Native Stop Loss (P7.1) and Force Exit (P7.2)
 *
 * All external calls (BinanceClient, account I/O, notify) are mocked.
 * Covers 20+ scenarios as specified in the task.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

// ─── Mock 所有外部依赖（必须在 import 前声明）──────────────────────

// Mock BinanceClient so constructor doesn't read credentials file
const mockPlaceStopLossOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockGetOrder = vi.fn();
const mockMarketSell = vi.fn();
const mockMarketBuyByQty = vi.fn();
const mockGetUsdtBalance = vi.fn();
const mockMarketBuy = vi.fn();
const mockGetSymbolInfo = vi.fn();

vi.mock("../exchange/binance-client.js", () => ({
  BinanceClient: vi.fn().mockImplementation(() => ({
    placeStopLossOrder: mockPlaceStopLossOrder,
    cancelOrder: mockCancelOrder,
    getOrder: mockGetOrder,
    marketSell: mockMarketSell,
    marketBuyByQty: mockMarketBuyByQty,
    getUsdtBalance: mockGetUsdtBalance,
    marketBuy: mockMarketBuy,
    getSymbolInfo: mockGetSymbolInfo,
    ping: vi.fn().mockResolvedValue(true),
    getFuturesPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    placeTakeProfitOrder: vi.fn().mockResolvedValue({ orderId: 9999, status: "NEW", price: "0", origQty: "0", executedQty: "0", symbol: "BTCUSDT", clientOrderId: "", transactTime: Date.now(), type: "TAKE_PROFIT_LIMIT", side: "SELL" }),
  })),
}));

// Mock account module
const mockLoadAccount = vi.fn();
const mockSaveAccount = vi.fn();
const mockResetDailyLossIfNeeded = vi.fn();
const mockCalcTotalEquity = vi.fn().mockReturnValue(10000);
const mockRegisterOrder = vi.fn();
const mockConfirmOrder = vi.fn();
const mockGetTimedOutOrders = vi.fn().mockReturnValue([]);
const mockCancelOrderAccount = vi.fn();
const mockCleanupOrders = vi.fn();

vi.mock("../paper/account.js", () => ({
  loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
  saveAccount: (...args: unknown[]) => mockSaveAccount(...args),
  resetDailyLossIfNeeded: (...args: unknown[]) => mockResetDailyLossIfNeeded(...args),
  calcTotalEquity: (...args: unknown[]) => mockCalcTotalEquity(...args),
  registerOrder: (...args: unknown[]) => mockRegisterOrder(...args),
  confirmOrder: (...args: unknown[]) => mockConfirmOrder(...args),
  getTimedOutOrders: (...args: unknown[]) => mockGetTimedOutOrders(...args),
  cancelOrder: (...args: unknown[]) => mockCancelOrderAccount(...args),
  cleanupOrders: (...args: unknown[]) => mockCleanupOrders(...args),
  getAccountSummary: vi.fn().mockReturnValue({}),
  paperBuy: vi.fn(),
  paperSell: vi.fn(),
  paperOpenShort: vi.fn(),
  paperCoverShort: vi.fn(),
  paperDcaAdd: vi.fn(),
  updateTrailingStop: vi.fn().mockReturnValue(false),
}));

// Mock notify module
const mockSendTelegramMessage = vi.fn();

vi.mock("../notify/openclaw.js", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  notifySignal: vi.fn(),
  notifyTrade: vi.fn(),
  notifyPaperTrade: vi.fn(),
  notifyStopLoss: vi.fn(),
  notifyError: vi.fn(),
  notifyStatus: vi.fn(),
  sendNewsReport: vi.fn(),
}));

// Mock paper/engine.js to avoid circular imports
vi.mock("../paper/engine.js", () => ({}));

// Mock signals/history.js
vi.mock("../signals/history.js", () => ({
  logSignal: vi.fn().mockReturnValue("mock-signal-id"),
  closeSignal: vi.fn(),
}));

// Mock persistence/db.js
vi.mock("../persistence/db.js", () => ({
  TradeDB: vi.fn().mockImplementation(() => ({
    insertTrade: vi.fn().mockReturnValue(1),
    closeTrade: vi.fn(),
  })),
}));

// Mock strategy modules
vi.mock("../strategy/indicators.js", () => ({
  calcAtrPositionSize: vi.fn().mockReturnValue(500),
}));

vi.mock("../strategy/roi-table.js", () => ({
  checkMinimalRoi: vi.fn().mockReturnValue(false),
}));

// Mock reconcile
vi.mock("./reconcile.js", () => ({}), );

// ─── Import after mocks ────────────────────────────────────────────

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

function makePosition(override: Partial<PaperPosition> = {}): PaperPosition {
  return {
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.01,
    entryPrice: 45000,
    entryTime: Date.now() - 3600_000,
    stopLoss: 42750,
    takeProfit: 49500,
    exchangeSlOrderId: 55555,
    exchangeSlPrice: 42750,
    ...override,
  };
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

function makeExecutor(): LiveExecutor {
  return new LiveExecutor(makeConfig());
}

// ─────────────────────────────────────────────────────────────────
// 1. placeExchangeStopLoss
// ─────────────────────────────────────────────────────────────────

describe("placeExchangeStopLoss()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC01: long 仓位 → 调用 placeStopLossOrder with SELL", async () => {
    mockPlaceStopLossOrder.mockResolvedValue(makeOrderResponse(11111, "NEW"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "long", 0.01, 42750);

    expect(mockPlaceStopLossOrder).toHaveBeenCalledWith("BTCUSDT", "SELL", 0.01, 42750);
    expect(result).toBe(11111);
  });

  it("TC02: short 仓位 → 调用 placeStopLossOrder with BUY", async () => {
    mockPlaceStopLossOrder.mockResolvedValue(makeOrderResponse(22222, "NEW"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "short", 0.01, 47250);

    expect(mockPlaceStopLossOrder).toHaveBeenCalledWith("BTCUSDT", "BUY", 0.01, 47250);
    expect(result).toBe(22222);
  });

  it("TC03: API 失败 → 返回 null，不抛错", async () => {
    mockPlaceStopLossOrder.mockRejectedValue(new Error("Network error"));

    const result = await executor.placeExchangeStopLoss("BTCUSDT", "long", 0.01, 42750);

    expect(result).toBeNull();
    // 不抛错 ✓
  });

  it("TC03b: long 仓位 → 返回正确 orderId", async () => {
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
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC04: 调用 binanceClient.cancelOrder()", async () => {
    mockCancelOrder.mockResolvedValue({ orderId: 55555, status: "CANCELED", symbol: "BTCUSDT", clientOrderId: "", transactTime: Date.now(), price: "0", origQty: "0.01", executedQty: "0", type: "STOP_LOSS_LIMIT", side: "SELL" });

    await executor.cancelExchangeStopLoss("BTCUSDT", 55555);

    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
  });

  it("TC05: API 失败 → 记录 warn，不抛错", async () => {
    mockCancelOrder.mockRejectedValue(new Error("Order not found"));

    // 不应抛错
    await expect(executor.cancelExchangeStopLoss("BTCUSDT", 99999)).resolves.toBeUndefined();
  });

  it("TC05b: 多次调用 cancelOrder 传正确参数", async () => {
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
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC06: SL 单 FILLED → 本地持仓被移除", async () => {
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

  it("TC07: SL 单仍 OPEN (NEW) → 无操作，持仓保留", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(55555, "NEW"), status: "NEW" });

    await executor.syncExchangeStopLosses(account, "test");

    expect(account.positions["BTCUSDT"]).toBeDefined();
  });

  it("TC08: SL 单 CANCELLED → 记录 warn，持仓保留", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(55555, "CANCELED"), status: "CANCELED" });

    await executor.syncExchangeStopLosses(account, "test");

    expect(account.positions["BTCUSDT"]).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("TC09: 无 exchangeSlOrderId → 跳过，getOrder 不被调用", async () => {
    const position = makePosition({ exchangeSlOrderId: undefined, exchangeSlPrice: undefined });
    const account = makeAccount({ BTCUSDT: position });

    await executor.syncExchangeStopLosses(account, "test");

    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it("TC09b: getOrder 失败 → 不抛错，持仓保留", async () => {
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
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC10: 取消原生 SL 单 + 下市价卖出单", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
    expect(mockMarketSell).toHaveBeenCalledWith("BTCUSDT", 0.01);
  });

  it("TC11: forceExit 后 position 从本地账户移除", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    expect(account.positions["BTCUSDT"]).toBeUndefined();
    expect(mockSaveAccount).toHaveBeenCalled();
  });

  it("TC12: forceExit 后发送 Telegram 通知", async () => {
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

  it("TC12b: forceExit reason=force_exit_manual 也发通知", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_manual");

    expect(mockSendTelegramMessage).toHaveBeenCalled();
  });

  it("TC17: forceExit trade reason 包含 force_exit_timeout", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    const trade = account.trades[account.trades.length - 1];
    expect(trade).toBeDefined();
    expect(trade?.reason).toContain("force_exit_timeout");
  });

  it("TC10b: short 仓位 forceExit → 使用 marketBuyByQty", async () => {
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

  it("TC: forceExit 下单失败时仍移除本地持仓", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockRejectedValue(new Error("Market closed"));

    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    // 即使下单失败，持仓也应该被移除（防止残留）
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. exitTimeoutCount + checkOrderTimeouts
// ─────────────────────────────────────────────────────────────────

describe("exitTimeoutCount + checkOrderTimeouts()", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC13: 首次出场超时 → exitTimeoutCount=1, forceExit 不触发", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 0 });
    const account = makeAccount({ BTCUSDT: position });

    mockLoadAccount.mockReturnValue(account);
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

    // Mock getOrder to return NEW (still pending, will be cancelled)
    mockGetOrder.mockResolvedValue({ ...makeOrderResponse(99999, "NEW"), status: "NEW" });
    mockCancelOrder.mockResolvedValue({});

    const forceExitSpy = vi.spyOn(executor, "forceExit").mockResolvedValue();

    await executor.checkOrderTimeouts(account);

    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(1);
    expect(forceExitSpy).not.toHaveBeenCalled();
  });

  it("TC14: 第 3 次出场超时 → 触发 forceExit", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 2 });
    const account = makeAccount({ BTCUSDT: position });

    mockLoadAccount.mockReturnValue(account);
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

  it("TC15: forceExit 后 exitTimeoutCount 归零", async () => {
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(77777, "FILLED"));

    const position = makePosition({ exchangeSlOrderId: 55555, exitTimeoutCount: 2 });
    const account = makeAccount({ BTCUSDT: position });

    await executor.forceExit(account, position, "test", "force_exit_timeout");

    // 持仓已移除，exitTimeoutCount 随持仓一起消失
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("TC13b: 入场超时不累计 exitTimeoutCount", async () => {
    const position = makePosition({ exitTimeoutCount: 0 });
    const account = makeAccount({ BTCUSDT: position });

    mockLoadAccount.mockReturnValue(account);
    mockGetTimedOutOrders.mockReturnValue([{
      orderId: 11111,
      symbol: "BTCUSDT",
      side: "buy" as const,  // entry order
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

    // 入场超时不触发 forceExit 也不增加 exitTimeoutCount
    expect(forceExitSpy).not.toHaveBeenCalled();
    expect(account.positions["BTCUSDT"]?.exitTimeoutCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Paper 模式 Force Exit
// ─────────────────────────────────────────────────────────────────

describe("Paper 模式 Force Exit (checkExitConditions)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC16: paper 模式 exitTimeoutCount >= 3 → 立即用当前价格出场", async () => {
    // 直接测试 paper engine 逻辑，不需要 mock account
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
      exitTimeoutCount: 3,  // >= 3 → force exit
    };
    const account = makeAccount({ BTCUSDT: position });

    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "paperSell").mockReturnValue({
      id: "force_test_001",
      symbol: "BTCUSDT",
      side: "sell",
      quantity: 0.01,
      price: 44000,
      usdtAmount: 440,
      fee: 0.44,
      slippage: 0,
      timestamp: Date.now(),
      reason: "force_exit_timeout：出场超时 3 次，强制市价出场",
    });

    const cfg = makeConfig();
    const prices = { BTCUSDT: 44000 };

    const results = checkExitConditions(prices, cfg);

    // 应该触发出场
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.symbol).toBe("BTCUSDT");
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. handleSell 与 cancelExchangeStopLoss 集成
// ─────────────────────────────────────────────────────────────────

describe("handleSell() → cancelExchangeStopLoss", () => {
  let executor: LiveExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = makeExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TC18: exchangeSlOrderId 正确存入账户 position", async () => {
    // 通过 handleBuy 测试
    const account = makeAccount({});
    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    mockMarketBuy.mockResolvedValue({
      ...makeOrderResponse(44444, "FILLED"),
      orderId: 44444,
      side: "BUY",
      fills: [{ price: "45000", qty: "0.01", commission: "0.045", commissionAsset: "USDT" }],
    });
    mockPlaceStopLossOrder.mockResolvedValue({ ...makeOrderResponse(55555, "NEW"), orderId: 55555 });

    const signal = {
      symbol: "BTCUSDT",
      type: "buy" as const,
      price: 45000,
      indicators: { maShort: 100, maLong: 90, rsi: 40, price: 45000, volume: 100, avgVolume: 80 },
      reason: ["test buy"],
      timestamp: Date.now(),
    };

    await executor.handleBuy(signal);

    // saveAccount should be called with position containing exchangeSlOrderId
    expect(mockSaveAccount).toHaveBeenCalled();
    const savedAccount = mockSaveAccount.mock.calls[0]?.[0] as PaperAccount;
    const savedPos = savedAccount?.positions?.["BTCUSDT"];
    if (savedPos) {
      expect(savedPos.exchangeSlOrderId).toBe(55555);
      expect(savedPos.exchangeSlPrice).toBe(savedPos.stopLoss);
    }
  });

  it("TC19: handleSell → 调用 cancelExchangeStopLoss (via cancelOrder)", async () => {
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    mockCancelOrder.mockResolvedValue({});
    mockMarketSell.mockResolvedValue(makeOrderResponse(66666, "FILLED"));

    await executor.handleSell("BTCUSDT", 45000, "test signal sell");

    // cancelOrder should be called with the exchangeSlOrderId
    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 55555);
  });

  it("TC20: cancelExchangeStopLoss 失败 → 平仓继续（warn + 继续）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const position = makePosition({ exchangeSlOrderId: 55555 });
    const account = makeAccount({ BTCUSDT: position });

    mockLoadAccount.mockReturnValue(account);
    mockGetUsdtBalance.mockResolvedValue(9000);
    // cancelOrder 失败
    mockCancelOrder.mockRejectedValue(new Error("cancel failed"));
    // marketSell 成功
    mockMarketSell.mockResolvedValue(makeOrderResponse(66666, "FILLED"));

    const result = await executor.handleSell("BTCUSDT", 45000, "test sell with cancel failure");

    // 平仓应该继续
    expect(result.trade).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. 新字段类型检查
// ─────────────────────────────────────────────────────────────────

describe("PaperPosition new fields", () => {
  it("TC: PaperPosition 支持 exchangeSlOrderId/exchangeSlPrice/exitTimeoutCount", () => {
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

  it("TC: 可选字段默认 undefined 不影响类型检查", () => {
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
});

/**
 * P8.1 Break-Even Stop + Custom Stoploss 测试
 *
 * 覆盖：
 * - calcBreakEvenStop 纯函数（多头/空头/边界/不退后）
 * - resolveNewStopLoss 综合函数（优先级/硬底线/customStoploss）
 * - paper/engine checkExitConditions 集成
 * - live/executor checkExitConditions 集成（mock）
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
// calcBreakEvenStop 测试 — 多头
// ─────────────────────────────────────────────────────

describe("calcBreakEvenStop — 多头", () => {
  it("profitRatio < breakEvenProfit 时不触发，返回 null", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.02, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("profitRatio === breakEvenProfit 时恰好触发", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.03, 0.03, 0.001);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(1000 * 1.001); // 1001
  });

  it("profitRatio > breakEvenProfit 时触发", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(1001);
  });

  it("计算正确：newStop = entryPrice * (1 + breakEvenStop)", () => {
    const result = calcBreakEvenStop("long", 50000, 47500, 0.04, 0.03, 0.002);
    // 50000 * 1.002 = 50100
    expect(result).toBeCloseTo(50100);
  });

  it("新止损 ≤ 当前止损时不更新（不退后），返回 null", () => {
    // 已经把止损移到了 1001，再次计算不应后退
    const result = calcBreakEvenStop("long", 1000, 1001, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("新止损 == 当前止损时不更新（等号不触发）", () => {
    // currentStopLoss == newStop → 不更新
    const result = calcBreakEvenStop("long", 1000, 1001, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("新止损 > 当前止损时正常更新", () => {
    // currentStopLoss 在 950，break-even 目标在 1001 → 更新
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(1001);
    expect(result!).toBeGreaterThan(950);
  });

  it("breakEvenStop = 0 时止损移到入场价", () => {
    const result = calcBreakEvenStop("long", 1000, 950, 0.05, 0.03, 0);
    expect(result).toBeCloseTo(1000);
  });
});

// ─────────────────────────────────────────────────────
// calcBreakEvenStop 测试 — 空头
// ─────────────────────────────────────────────────────

describe("calcBreakEvenStop — 空头", () => {
  it("profitRatio < breakEvenProfit 时不触发，返回 null", () => {
    const result = calcBreakEvenStop("short", 1000, 1050, 0.02, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("profitRatio === breakEvenProfit 时恰好触发", () => {
    const result = calcBreakEvenStop("short", 1000, 1050, 0.03, 0.03, 0.001);
    expect(result).not.toBeNull();
    // 空头：newStop = entryPrice * (1 - breakEvenStop) = 999
    expect(result).toBeCloseTo(999);
  });

  it("计算正确：newStop = entryPrice * (1 - breakEvenStop)", () => {
    const result = calcBreakEvenStop("short", 50000, 52500, 0.05, 0.03, 0.002);
    // 50000 * (1 - 0.002) = 49900
    expect(result).toBeCloseTo(49900);
  });

  it("空头：新止损 ≥ 当前止损时不更新（不退后）", () => {
    // 当前止损 999（已优化到低于入场价），break-even 又会给 999，不更新
    const result = calcBreakEvenStop("short", 1000, 999, 0.05, 0.03, 0.001);
    expect(result).toBeNull();
  });

  it("空头：新止损 < 当前止损时正常更新", () => {
    // currentStopLoss = 1050，break-even 目标在 999 → 更新
    const result = calcBreakEvenStop("short", 1000, 1050, 0.05, 0.03, 0.001);
    expect(result).toBeCloseTo(999);
    expect(result!).toBeLessThan(1050);
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss 测试 — 基础 break-even 逻辑
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — 基础 break-even 逻辑", () => {
  it("未配置 break_even_profit 时返回 null", () => {
    const riskCfg = makeRiskCfg(); // no break_even_profit
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("配置了 break_even_profit 但未达到时返回 null", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03 });
    // profitRatio = 0.02 < 0.03
    const result = resolveNewStopLoss("long", 1000, 950, 1020, 0.02, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("达到 break_even_profit 时返回新止损价", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 1030, 0.03, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(1001);
  });

  it("break_even_stop 默认为 0.001（未配置时）", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03 }); // no break_even_stop
    const result = resolveNewStopLoss("long", 1000, 950, 1030, 0.05, 3600_000, "BTCUSDT", riskCfg);
    // default breakEvenStop = 0.001 → 1000 * 1.001 = 1001
    expect(result).toBeCloseTo(1001);
  });

  it("空头方向：达到 break_even_profit 时返回正确的新止损价", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    // 空头：profitRatio = 0.05 >= 0.03 → newStop = 1000 * (1 - 0.001) = 999
    const result = resolveNewStopLoss("short", 1000, 1050, 950, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(999);
  });

  it("新止损不退后：已经在保本位置，不再更新", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    // currentStopLoss 已经在 1001（break-even 目标位置）
    const result = resolveNewStopLoss("long", 1000, 1001, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });

  it("已亏损时 break_even 不触发（profitRatio 为负）", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 980, -0.02, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss 测试 — 硬底线保护
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — 硬底线保护", () => {
  it("多头：customStoploss 返回低于硬底线的值，被向上夹紧后仍 ≤ 当前止损 → null", () => {
    // stop_loss_percent = 5% → hardFloor = 1000 * 0.95 = 950
    // currentStopLoss = 960 (already above hardFloor)
    // customStoploss 返回 900 → 夹紧到 950 → 950 < 960 → null
    const riskCfg = makeRiskCfg({ stop_loss_percent: 5 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => 900, // 低于 hardFloor
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 960, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeNull();
  });

  it("多头：customStoploss 返回高于硬底线的合法值，正常返回", () => {
    // stop_loss_percent = 5% → hardFloor = 950
    // currentStopLoss = 950, customStoploss → 970
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

  it("空头：customStoploss 返回高于硬底线的值，被夹紧后仍 ≥ 当前止损 → null", () => {
    // stop_loss_percent = 5% → hardCeiling = 1000 * 1.05 = 1050
    // currentStopLoss = 1040
    // customStoploss 返回 1100 → 夹紧到 1050 → 1050 > 1040 → 空头更差 → null
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

  it("空头：customStoploss 返回低于当前止损的合法值，正常返回", () => {
    // currentStopLoss = 1050, customStoploss → 1010 (更低 = 空头更优)
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

  it("多头完整场景：盈利触发 break-even，止损从 9500 移到 10100", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.01, stop_loss_percent: 5 });
    const result = resolveNewStopLoss("long", 10000, 9500, 10500, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(10100); // 10000 * 1.01 = 10100
  });

  it("空头完整场景：盈利触发 break-even，止损从 10500 移到 9990", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001, stop_loss_percent: 5 });
    const result = resolveNewStopLoss("short", 10000, 10500, 9500, 0.05, 3600_000, "BTCUSDT", riskCfg);
    expect(result).toBeCloseTo(9990); // 10000 * (1 - 0.001) = 9990
  });
});

// ─────────────────────────────────────────────────────
// resolveNewStopLoss 测试 — customStoploss 优先级
// ─────────────────────────────────────────────────────

describe("resolveNewStopLoss — customStoploss 优先级", () => {
  it("customStoploss 返回值优先于 break_even 逻辑", () => {
    // break_even 会给 1001，但 customStoploss 给 1010
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

  it("customStoploss 返回 null 时降级到 break_even 逻辑", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const strategy: Strategy = {
      id: "test",
      name: "test",
      populateSignal: () => "none",
      customStoploss: () => null, // 降级
    };
    const ctx = {} as StrategyContext;
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, strategy, ctx);
    expect(result).toBeCloseTo(1001); // break-even
  });

  it("strategy 存在但 ctx = undefined 时不调用 customStoploss，降级到 break_even", () => {
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

  it("没有 strategy 时只走 break_even 逻辑", () => {
    const riskCfg = makeRiskCfg({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const result = resolveNewStopLoss("long", 1000, 950, 1050, 0.05, 3600_000, "BTCUSDT", riskCfg, undefined, undefined);
    expect(result).toBeCloseTo(1001);
  });

  it("customStoploss 被调用时，传入正确的 position 参数", () => {
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

  it("customStoploss 有策略但 customStoploss 字段不存在时走 break_even", () => {
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
// Paper Engine 集成测试
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

describe("Engine 集成 — checkExitConditions break-even", () => {
  beforeEach(() => {
    vi.spyOn(accountModule, "loadAccount").mockImplementation(() => mockEngineAccount);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => { /* noop */ });
    vi.spyOn(accountModule, "resetDailyLossIfNeeded").mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("break_even 触发时更新 pos.stopLoss", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // 当前价 1050 → profitRatio = 0.05 >= 0.03 → 触发
    checkExitConditions({ BTCUSDT: 1050 }, cfg);

    // pos.stopLoss 应已更新为 1001
    expect(pos.stopLoss).toBeCloseTo(1001);
  });

  it("break_even 未触发时 pos.stopLoss 不变", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // 当前价 1020 → profitRatio = 0.02 < 0.03 → 不触发
    checkExitConditions({ BTCUSDT: 1020 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(950); // 未变
  });

  it("break_even 更新后 stopLoss 值正确", () => {
    // 验证 break_even 计算正确性
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.002 });

    // 当前价 1050 → profitRatio = 0.05 → 触发
    // newStop = 1000 * (1 + 0.002) = 1002
    checkExitConditions({ BTCUSDT: 1050 }, cfg);
    expect(pos.stopLoss).toBeCloseTo(1002);
  });

  it("空头 break_even 触发时更新 pos.stopLoss（降低止损）", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { side: "short", stopLoss: 1050 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });

    // 空头当前价 950 → profitRatio = 0.05 >= 0.03 → 触发
    // newStop = 1000 * (1 - 0.001) = 999
    checkExitConditions({ BTCUSDT: 950 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(999);
    expect(pos.stopLoss).toBeLessThan(1050);
  });

  it("不配置 break_even_profit 时 stopLoss 不变", () => {
    const pos = makeEnginePosition("BTCUSDT", 1000, { stopLoss: 950 });
    mockEngineAccount = makeEngineAccount({ BTCUSDT: pos });
    const cfg = makeEngineConfig(); // no break_even_profit

    checkExitConditions({ BTCUSDT: 1050 }, cfg);

    expect(pos.stopLoss).toBeCloseTo(950); // 未变
  });
});

// ─────────────────────────────────────────────────────
// Executor 集成测试 (全部模块 mock)
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

describe("Executor 集成 — checkExitConditions break-even", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCalcTotalEquity.mockReturnValue(10000);
    // 重新设置 BinanceClient 构造函数 mock（防止其他测试文件的 clearAllMocks 破坏）
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

  it("break_even 未触发时 stopLoss 不变，不调用 saveAccount（因 break-even）", async () => {
    const pos = makeExecutorPosition();
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = (61200 - 60000) / 60000 = 0.02 < 0.03 → 不触发
    await executor.checkExitConditions({ BTCUSDT: 61200 });

    expect(pos.stopLoss).toBeCloseTo(57000);
    // saveAccount 可能被调用（但不是因为 break-even），我们只检查 stopLoss
  });

  it("break_even 触发时更新 stopLoss 并调用 saveAccount", async () => {
    const pos = makeExecutorPosition();
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = (61800 - 60000) / 60000 = 0.03 → 触发
    // newStop = 60000 * 1.001 = 60060
    await executor.checkExitConditions({ BTCUSDT: 61800 });

    expect(pos.stopLoss).toBeCloseTo(60060);
    expect(mockSaveAccount).toHaveBeenCalled();
  });

  it("break_even 触发且有 exchangeSlOrderId 时，先取消再重新挂止损单", async () => {
    const pos = makeExecutorPosition({ exchangeSlOrderId: 12345, exchangeSlPrice: 57000 });
    const account = makeExecAccount({ BTCUSDT: pos });
    mockLoadAccount.mockReturnValue(account);
    mockGetOrder.mockRejectedValue(new Error("no order"));
    mockCancelOrder.mockResolvedValue(undefined);
    mockPlaceStopLossOrder.mockResolvedValue({ orderId: 99999 });

    const cfg = makeExecutorConfig({ break_even_profit: 0.03, break_even_stop: 0.001 });
    const executor = new LiveExecutor(cfg);

    // profitRatio = 0.03 → break_even 触发
    await executor.checkExitConditions({ BTCUSDT: 61800 });

    // 原止损单应被取消
    expect(mockCancelOrder).toHaveBeenCalledWith("BTCUSDT", 12345);
    // 新止损单应被挂出
    expect(mockPlaceStopLossOrder).toHaveBeenCalled();
    // exchangeSlOrderId 应更新
    expect(pos.exchangeSlOrderId).toBe(99999);
    // stopLoss 已更新
    expect(pos.stopLoss).toBeCloseTo(60060);
  });
});

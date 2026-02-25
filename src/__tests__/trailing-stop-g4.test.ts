/**
 * Enhanced Trailing Stop 测试 (G4)
 * 测试 positive trailing offset 激活、trailing_only_offset_is_reached 等逻辑
 *
 * 测试通过 checkExitConditions() 调用 (paper/engine.ts)，注入模拟账户数据。
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
      lowestPrice: opts.lowestPrice,
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

const MOCK_SCENARIO = "test-trailing";

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

describe("G4 Enhanced Trailing Stop — 基础多头", () => {
  it("未激活时不触发 trailing stop", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, { trailingActive: false }),
    });
    const cfg = makeConfig();
    // 下跌 3%（未激活，不触发）
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });

  it("价格上涨激活 trailing（gainPct >= activation_percent），然后回撤触发", () => {
    // 持仓在 100，最高价达到 103（>= 2% 激活），然后回撤 5%
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 103 * 0.95, // = 97.85
      }),
    });
    const cfg = makeConfig();
    // 当前价 97（< 97.85 = 触发）
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
    expect(trailing[0]?.symbol).toBe("BTCUSDT");
  });

  it("价格高于 stopPrice 时不触发", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 103,
        stopPrice: 97.85,
      }),
    });
    const cfg = makeConfig();
    // 当前价 99（> 97.85，不触发）
    const exits = checkExitConditions({ BTCUSDT: 99 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });
});

describe("G4 Enhanced Trailing Stop — positive trailing offset", () => {
  it("盈利超过 offset 后 trailingStopActivated 被激活", () => {
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 105,  // 盈利 5%
        stopPrice: 105 * 0.95, // 5% callback = 99.75
        trailingStopActivated: false,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,          // positive trailing = 2%（更紧）
      trailing_stop_positive_offset: 0.03,   // offset = 3%盈利后激活
    });
    // 当前价 104 → 盈利 4% > 3%（offset），应激活 positive trailing
    const exits = checkExitConditions({ BTCUSDT: 104 }, cfg);
    // 即使不触发止损，trailingStopActivated 应该变为 true
    // （通过检查 mockAccount.positions）
    expect(mockAccount.positions.BTCUSDT?.trailingStopActivated).toBe(true);
    void exits; // suppress unused warning
  });

  it("positive trailing 使用更紧的 callback (2% vs 5%)", () => {
    // 已激活 positive trailing，最高价 106，回撤 2% = 103.88
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 106,
        stopPrice: 106 * 0.95, // 5% callback（基础值）
        trailingStopActivated: true,
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.02,         // 2% callback（已激活）
      trailing_stop_positive_offset: 0.03,
    });
    // 当前价 103.9（< 106 * (1-0.02) = 103.88）→ positive trailing 触发
    const exits = checkExitConditions({ BTCUSDT: 103.8 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
    expect(trailing[0]?.reason).toBe("trailing_stop");
  });

  it("positive trailing 未激活时使用原始 callback (5%)", () => {
    // 未激活 positive trailing，最高价 103，回撤 2%（未达到 5% callback）
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
      trailing_stop_positive_offset: 0.05, // 5% offset（未到达）
    });
    // 价格 100（> 97.85，基础 5% callback 未触发）
    const exits = checkExitConditions({ BTCUSDT: 100 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });
});

describe("G4 Enhanced Trailing Stop — trailing_only_offset_is_reached", () => {
  it("only_offset=true 且 offset 未达到时，trailing 不激活（跳过）", () => {
    // 持仓入场 100，价格 102（盈利 2%），offset = 3%（未到达）
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
    // 即使价格下跌，也不应触发 trailing（因为 only_offset=true 且 offset 未达到）
    const exits = checkExitConditions({ BTCUSDT: 98 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(0);
  });

  it("only_offset=true 且 offset 已达到后，trailing 正常工作", () => {
    // 已激活 positive trailing，使用更紧 trailing
    mockAccount = makeAccount({
      BTCUSDT: makePosition("BTCUSDT", 100, {
        trailingActive: true,
        highestPrice: 105,
        stopPrice: 105 * 0.99, // 1% callback = 103.95
        trailingStopActivated: true, // offset 已达到
      }),
    });
    const cfg = makeConfig({
      trailing_stop_positive: 0.01,         // 1% callback
      trailing_stop_positive_offset: 0.03,
      trailing_only_offset_is_reached: true,
    });
    // 价格 103.9（< 103.95 = 触发）
    const exits = checkExitConditions({ BTCUSDT: 103.9 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
  });

  it("only_offset=false 时立即激活 trailing（不等待 offset）", () => {
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
      trailing_only_offset_is_reached: false, // 不等待 offset
    });
    // 价格 97（< 97.85 = 触发，使用基础 callback 5%）
    const exits = checkExitConditions({ BTCUSDT: 97 }, cfg);
    const trailing = exits.filter((e) => e.reason === "trailing_stop");
    expect(trailing).toHaveLength(1);
  });
});

describe("G4 Enhanced Trailing Stop — trailing_stop 禁用时不处理", () => {
  it("trailing_stop.enabled=false 时不执行 trailing 逻辑", () => {
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

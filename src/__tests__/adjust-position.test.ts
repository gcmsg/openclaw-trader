/**
 * P9 - adjustPosition 策略化 DCA 测试
 *
 * 覆盖：
 *   - Strategy 接口 adjustPosition 方法类型
 *   - checkDcaTranches（paper engine）策略优先逻辑
 *   - rsi-reversal.adjustPosition 条件判断
 *   - LiveExecutor.checkDcaTranches（mock）
 *   - dcaCount / profitRatio / holdMs 正确传递
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as accountModule from "../paper/account.js";
import { checkDcaTranches } from "../paper/engine.js";
import { rsiReversalStrategy } from "../strategies/rsi-reversal.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig, Indicators } from "../types.js";

// ─────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────

function makeIndicators(rsi = 50): Indicators {
  return {
    maShort: 100,
    maLong: 90,
    rsi,
    price: 48000,
    volume: 1000,
    avgVolume: 900,
  };
}

function makeCtx(rsi = 50): StrategyContext {
  return {
    klines: [],
    cfg: {
      symbols: ["BTCUSDT"],
      timeframe: "1h",
      strategy: {
        name: "test",
        enabled: true,
        ma: { short: 20, long: 60 },
        rsi: { period: 14, oversold: 30, overbought: 70 },
        macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      },
      signals: { buy: [], sell: [] },
    } as unknown as StrategyContext["cfg"],
    indicators: makeIndicators(rsi),
  };
}

function makePosition(
  symbol: string,
  entryPrice: number,
  quantity = 0.02,
  completedTranches = 1,
  totalTranches = 3
): PaperPosition {
  return {
    symbol,
    side: "long",
    quantity,
    entryPrice,
    entryTime: Date.now() - 3_600_000, // 1h ago
    stopLoss: entryPrice * 0.95,
    takeProfit: entryPrice * 1.15,
    dcaState: {
      totalTranches,
      completedTranches,
      lastTranchePrice: entryPrice,
      dropPct: 3,
      startedAt: Date.now() - 1_800_000, // 30min ago
      maxMs: 48 * 3_600_000,
    },
  };
}

function makeAccount(usdt = 5000, positions: Record<string, PaperPosition> = {}): PaperAccount {
  return {
    initialUsdt: 10000,
    usdt,
    positions,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
  };
}

function makeCfg(dcaEnabled = true): RuntimeConfig {
  return {
    exchange: { market: "spot", leverage: { enabled: false, default: 1, max: 1 } },
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.1,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
      dca: dcaEnabled
        ? { enabled: true, tranches: 3, drop_pct: 3, max_hours: 48 }
        : { enabled: false, tranches: 1, drop_pct: 3, max_hours: 48 },
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
      scenarioId: "test-adj",
      initial_usdt: 10000,
      fee_rate: 0.001,
      slippage_percent: 0,
      report_interval_hours: 24,
    },
    news: { enabled: false, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    schedule: {},
    mode: "paper",
  };
}

// ─────────────────────────────────────────────────────
// 1. 策略无 adjustPosition → 走默认 DCA 逻辑
// ─────────────────────────────────────────────────────

describe("default DCA logic (no adjustPosition)", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("未传 strategy → 默认 DCA: 价格跌幅满足时触发加仓", () => {
    const prices = { BTCUSDT: 48400 }; // 跌 3.2% > 3%
    const result = checkDcaTranches(prices, makeCfg());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("未传 strategy → 默认 DCA: 价格跌幅不足时不触发", () => {
    const prices = { BTCUSDT: 49000 }; // 跌 2% < 3%
    const result = checkDcaTranches(prices, makeCfg());
    expect(result).toHaveLength(0);
  });

  it("strategy 无 adjustPosition → 默认 DCA: 跌幅满足时触发加仓", () => {
    const strategyNoAdjust: Strategy = {
      id: "no-adjust",
      name: "No Adjust",
      populateSignal: () => "none",
    };
    const prices = { BTCUSDT: 48400 };
    const result = checkDcaTranches(prices, makeCfg(), strategyNoAdjust, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("DCA disabled → 任何情况都不触发", () => {
    const prices = { BTCUSDT: 40000 }; // 大跌
    const result = checkDcaTranches(prices, makeCfg(false));
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 2. 策略返回 > 0 → 触发加仓
// ─────────────────────────────────────────────────────

describe("adjustPosition returns > 0 (add position)", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns > 0 且余额充足 → 触发加仓", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 500, // 加 $500
    };
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("returns > 0 → 加仓后 account.usdt 减少", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 300,
    };
    const prices = { BTCUSDT: 48000 };
    checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    // usdt 应该减少（加仓消耗余额）
    expect(account.usdt).toBeLessThan(5000);
  });

  it("returns > 0 但余额不足 → 不加仓", () => {
    account.usdt = 10; // 余额极低
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 500, // 需要 $500 但只有 $10
    };
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 3. 策略返回 < 0 → 触发减仓
// ─────────────────────────────────────────────────────

describe("adjustPosition returns < 0 (reduce position)", () => {
  let account: PaperAccount;

  beforeEach(() => {
    // qty=0.02, price=50000, cost=$1000
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns < 0 → 触发部分减仓，返回 trade", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -200, // 减仓 $200
    };
    // currentPrice=50000, qty=0.02, cost=$1000, reduce $200 → qty=0.004
    const prices = { BTCUSDT: 50000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("returns < 0 → 减仓后持仓 quantity 减少", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -200,
    };
    const prices = { BTCUSDT: 50000 };
    checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    // qty 减少（0.02 - 200/50000 = 0.02 - 0.004 = 0.016）
    expect(account.positions["BTCUSDT"]!.quantity).toBeCloseTo(0.016, 4);
  });

  it("returns < 0 超过持仓价值 → 不执行（qty 超过 pos.quantity）", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -999999, // 超大减仓额
    };
    const prices = { BTCUSDT: 50000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 4. 策略返回 0 → 不操作，走默认逻辑
// ─────────────────────────────────────────────────────

describe("adjustPosition returns 0 → fall through to default DCA", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns 0 且 dropPct 满足 → 默认 DCA 触发加仓", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 0,
    };
    const prices = { BTCUSDT: 48400 }; // 跌 3.2% > 3%
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
  });

  it("returns 0 且 dropPct 不满足 → 不触发", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 0,
    };
    const prices = { BTCUSDT: 49000 }; // 跌 2% < 3%
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 5. 策略返回 null → 不操作，走默认逻辑
// ─────────────────────────────────────────────────────

describe("adjustPosition returns null → fall through to default DCA", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns null 且 dropPct 满足 → 默认 DCA 触发加仓", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => null,
    };
    const prices = { BTCUSDT: 48400 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
  });

  it("returns null 且 dropPct 不满足 → 不触发", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => null,
    };
    const prices = { BTCUSDT: 49000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 6. ctx 未传入时 adjustPosition 不被调用（回退默认逻辑）
// ─────────────────────────────────────────────────────

describe("ctx not provided → skip adjustPosition", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("strategy 有 adjustPosition 但 ctx 未传 → 走默认 DCA", () => {
    const adjustSpy = vi.fn().mockReturnValue(500);
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: adjustSpy,
    };
    const prices = { BTCUSDT: 48400 }; // 跌 3.2% > 3%
    // 不传 ctx，adjustPosition 不被调用
    const result = checkDcaTranches(prices, makeCfg(), strategy); // ctx=undefined
    expect(adjustSpy).not.toHaveBeenCalled();
    // 默认 DCA 应该触发
    expect(result).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────
// 7. dcaCount / profitRatio / holdMs / costBasis 正确传递
// ─────────────────────────────────────────────────────

describe("position data correctly passed to adjustPosition", () => {
  let account: PaperAccount;
  let capturedPos: Parameters<NonNullable<Strategy["adjustPosition"]>>[0] | undefined;

  afterEach(() => vi.restoreAllMocks());

  it("dcaCount = completedTranches - 1 正确传递", () => {
    // completedTranches = 2 → dcaCount = 1
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 2, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: (pos) => { capturedPos = pos; return null; },
    };
    checkDcaTranches({ BTCUSDT: 48000 }, makeCfg(), strategy, makeCtx());
    expect(capturedPos?.dcaCount).toBe(1); // 2-1 = 1
  });

  it("profitRatio 多头 long 正确计算", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: (pos) => { capturedPos = pos; return null; },
    };
    checkDcaTranches({ BTCUSDT: 48000 }, makeCfg(), strategy, makeCtx());
    // profitRatio = (48000 - 50000) / 50000 = -0.04
    expect(capturedPos?.profitRatio).toBeCloseTo(-0.04, 4);
  });

  it("holdMs 传递的是持仓时长（正值）", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: (pos) => { capturedPos = pos; return null; },
    };
    checkDcaTranches({ BTCUSDT: 48000 }, makeCfg(), strategy, makeCtx());
    expect(capturedPos?.holdMs).toBeGreaterThan(0);
  });

  it("costBasis = quantity × entryPrice 正确传递", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: (pos) => { capturedPos = pos; return null; },
    };
    checkDcaTranches({ BTCUSDT: 48000 }, makeCfg(), strategy, makeCtx());
    // costBasis = 0.02 × 50000 = 1000
    expect(capturedPos?.costBasis).toBeCloseTo(1000, 2);
  });

  it("StrategyContext 被正确传递给 adjustPosition", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    let capturedCtx: StrategyContext | undefined;
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: (_pos, ctx) => { capturedCtx = ctx; return null; },
    };
    const ctx = makeCtx(15);
    checkDcaTranches({ BTCUSDT: 48000 }, makeCfg(), strategy, ctx);
    expect(capturedCtx).toBe(ctx);
    expect(capturedCtx?.indicators.rsi).toBe(15);
  });
});

// ─────────────────────────────────────────────────────
// 8. rsi-reversal.adjustPosition 条件测试
// ─────────────────────────────────────────────────────

describe("rsi-reversal adjustPosition conditions", () => {
  const basePos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    entryPrice: 50000,
    currentPrice: 48000,
    quantity: 0.02,
    costBasis: 1000,
    profitRatio: -0.04, // 亏损 4%（> 3% 阈值）
    holdMs: 3_600_000,
    dcaCount: 0,
  };

  it("RSI < 20, 亏损 > 3%, dcaCount < 2 → 返回 costBasis × 0.5", () => {
    const ctx = makeCtx(15); // RSI = 15 < 20
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeCloseTo(500, 2); // 1000 × 0.5
  });

  it("RSI = 20 (边界) → 不触发（≥20）→ null", () => {
    const ctx = makeCtx(20); // RSI = 20, 不满足 < 20
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeNull();
  });

  it("RSI > 20 → 不触发 → null", () => {
    const ctx = makeCtx(25);
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeNull();
  });

  it("profitRatio = -0.03 (边界) → 不触发（≥ -0.03）→ null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, profitRatio: -0.03 }; // 恰好 3%，不满足 < -0.03
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("profitRatio = -0.02 (亏损不足) → 不触发 → null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, profitRatio: -0.02 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("dcaCount = 2 (边界) → 不触发 → null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, dcaCount: 2 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("dcaCount = 1 → 仍触发（< 2）", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, dcaCount: 1 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeCloseTo(500, 2);
  });

  it("加仓金额 = costBasis × 0.5（不同 costBasis）", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, costBasis: 2000 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeCloseTo(1000, 2); // 2000 × 0.5
  });
});

// ─────────────────────────────────────────────────────
// 9. paper engine 集成测试
// ─────────────────────────────────────────────────────

describe("paper engine integration", () => {
  let account: PaperAccount;

  afterEach(() => vi.restoreAllMocks());

  it("paper engine: rsi-reversal 触发加仓条件时执行 DCA 加仓", () => {
    // RSI < 20, profitRatio < -0.03, dcaCount = 0 → 应触发加仓
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    // 价格 = 48000, profitRatio = -0.04, RSI = 15
    const ctx = makeCtx(15);
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), rsiReversalStrategy, ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("paper engine: rsi-reversal RSI > 20 → 不触发（回退默认 DCA，跌幅不足）", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const ctx = makeCtx(50); // RSI = 50, 不触发 rsi-reversal
    const prices = { BTCUSDT: 49000 }; // 跌 2% < 3%，默认 DCA 也不触发
    const result = checkDcaTranches(prices, makeCfg(), rsiReversalStrategy, ctx);
    expect(result).toHaveLength(0);
  });

  it("paper engine: 策略加仓使用 adjustPosition 返回的金额（非默认 position_ratio）", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const fixedAmount = 123.45;
    const strategy: Strategy = {
      id: "fixed",
      name: "Fixed Amount",
      populateSignal: () => "none",
      adjustPosition: () => fixedAmount,
    };
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
    // 加仓金额 = 123.45 USDT
    const posAfter = account.positions["BTCUSDT"]!;
    expect(posAfter.quantity).toBeGreaterThan(0.02);
  });
});

// ─────────────────────────────────────────────────────
// 10. live executor 集成（mock）
// ─────────────────────────────────────────────────────

/**
 * 为 live executor 创建 mock 版本，避免 BinanceClient 读取真实凭证文件。
 * 注意：LiveExecutor 构造函数在 new BinanceClient 时会同步读取 credentials_path，
 * 因此这里通过 Object.create + 手动注入 client stub 来绕过构造函数。
 */
async function makeMockLiveExecutor(cfg: RuntimeConfig): Promise<{
  executor: import("../live/executor.js").LiveExecutor;
  mockClient: {
    marketBuy: ReturnType<typeof vi.fn>;
    marketSell: ReturnType<typeof vi.fn>;
    getUsdtBalance: ReturnType<typeof vi.fn>;
  };
}> {
  const { LiveExecutor } = await import("../live/executor.js");

  // 用 Object.create 跳过构造函数（避免 BinanceClient 读取凭证文件）
  const executor = Object.create(LiveExecutor.prototype) as InstanceType<typeof LiveExecutor>;

  const mockClient = {
    marketBuy: vi.fn(),
    marketSell: vi.fn(),
    getUsdtBalance: vi.fn().mockResolvedValue(5000),
  };

  // 注入私有属性（绕过 TypeScript 访问检查）
  Object.assign(executor, {
    cfg,
    scenarioId: cfg.paper.scenarioId,
    isTestnet: false,
    client: mockClient,
    _exitRejectionLog: new Map(),
  });

  return { executor, mockClient };
}

describe("live executor integration (mock)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("live checkDcaTranches: strategy returns > 0 → marketBuy 被调用", async () => {
    const mockOrder = {
      orderId: 1,
      symbol: "BTCUSDT",
      status: "FILLED",
      executedQty: "0.0025",
      price: "0",
      fills: [{ price: "48000", qty: "0.0025", commission: "0" }],
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      transactTime: Date.now(),
      origQty: "0.0025",
      cummulativeQuoteQty: "120",
    };

    const cfg = makeCfg();
    const account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });

    const { executor, mockClient } = await makeMockLiveExecutor(cfg);
    mockClient.marketBuy.mockResolvedValue(mockOrder);

    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 120, // 加仓 $120
    };
    executor.strategy = strategy;

    const result = await executor.checkDcaTranches({ BTCUSDT: 48000 }, makeCtx());
    expect(mockClient.marketBuy).toHaveBeenCalledWith("BTCUSDT", 120);
    expect(result[0]?.side).toBe("add");
  });

  it("live checkDcaTranches: strategy returns < 0 → marketSell 被调用", async () => {
    const mockOrder = {
      orderId: 2,
      symbol: "BTCUSDT",
      status: "FILLED",
      executedQty: "0.002",
      price: "0",
      fills: [{ price: "50000", qty: "0.002", commission: "0" }],
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      transactTime: Date.now(),
      origQty: "0.002",
      cummulativeQuoteQty: "100",
    };

    const cfg = makeCfg();
    const account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });

    const { executor, mockClient } = await makeMockLiveExecutor(cfg);
    mockClient.marketSell.mockResolvedValue(mockOrder);

    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -100, // 减仓 $100 → qty = 100/50000 = 0.002
    };
    executor.strategy = strategy;

    const result = await executor.checkDcaTranches({ BTCUSDT: 50000 }, makeCtx());
    expect(mockClient.marketSell).toHaveBeenCalledWith("BTCUSDT", expect.closeTo(0.002, 4));
    expect(result[0]?.side).toBe("reduce");
  });
});

/**
 * P9 - adjustPosition strategy-driven DCA tests
 *
 * Covers:
 *   - Strategy interface adjustPosition method typing
 *   - checkDcaTranches (paper engine) strategy-first logic
 *   - rsi-reversal.adjustPosition condition checks
 *   - LiveExecutor.checkDcaTranches (mock)
 *   - dcaCount / profitRatio / holdMs correctly passed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as accountModule from "../paper/account.js";
import { checkDcaTranches } from "../paper/engine.js";
import { rsiReversalStrategy } from "../strategies/rsi-reversal.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { PaperAccount, PaperPosition } from "../paper/account.js";
import type { RuntimeConfig, Indicators } from "../types.js";

// ─────────────────────────────────────────────────────
// Factory functions
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
// 1. No adjustPosition on strategy -> falls back to default DCA logic
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

  it("no strategy passed -> default DCA: triggers when price drop meets threshold", () => {
    const prices = { BTCUSDT: 48400 }; // down 3.2% > 3%
    const result = checkDcaTranches(prices, makeCfg());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("no strategy passed -> default DCA: does not trigger when price drop is insufficient", () => {
    const prices = { BTCUSDT: 49000 }; // down 2% < 3%
    const result = checkDcaTranches(prices, makeCfg());
    expect(result).toHaveLength(0);
  });

  it("strategy has no adjustPosition -> default DCA: triggers when drop meets threshold", () => {
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

  it("DCA disabled -> never triggers regardless of conditions", () => {
    const prices = { BTCUSDT: 40000 }; // big drop
    const result = checkDcaTranches(prices, makeCfg(false));
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 2. Strategy returns > 0 -> triggers position addition
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

  it("returns > 0 with sufficient balance -> triggers position addition", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 500, // add $500
    };
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("returns > 0 -> account.usdt decreases after addition", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 300,
    };
    const prices = { BTCUSDT: 48000 };
    checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    // usdt should decrease (position addition consumes balance)
    expect(account.usdt).toBeLessThan(5000);
  });

  it("returns > 0 but insufficient balance -> no addition", () => {
    account.usdt = 10; // very low balance
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 500, // needs $500 but only $10 available
    };
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 3. Strategy returns < 0 -> triggers position reduction
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

  it("returns < 0 -> triggers partial reduction, returns trade", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -200, // reduce $200
    };
    // currentPrice=50000, qty=0.02, cost=$1000, reduce $200 -> qty=0.004
    const prices = { BTCUSDT: 50000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("returns < 0 -> position quantity decreases after reduction", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -200,
    };
    const prices = { BTCUSDT: 50000 };
    checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    // qty decreases (0.02 - 200/50000 = 0.02 - 0.004 = 0.016)
    expect(account.positions["BTCUSDT"]!.quantity).toBeCloseTo(0.016, 4);
  });

  it("returns < 0 exceeding position value -> not executed (qty exceeds pos.quantity)", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => -999999, // excessively large reduction
    };
    const prices = { BTCUSDT: 50000 };
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 4. Strategy returns 0 -> no action, falls through to default logic
// ─────────────────────────────────────────────────────

describe("adjustPosition returns 0 -> fall through to default DCA", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns 0 and dropPct meets threshold -> default DCA triggers", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 0,
    };
    const prices = { BTCUSDT: 48400 }; // down 3.2% > 3%
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(1);
  });

  it("returns 0 and dropPct does not meet threshold -> no trigger", () => {
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: () => 0,
    };
    const prices = { BTCUSDT: 49000 }; // down 2% < 3%
    const result = checkDcaTranches(prices, makeCfg(), strategy, makeCtx());
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 5. Strategy returns null -> no action, falls through to default logic
// ─────────────────────────────────────────────────────

describe("adjustPosition returns null -> fall through to default DCA", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns null and dropPct meets threshold -> default DCA triggers", () => {
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

  it("returns null and dropPct does not meet threshold -> no trigger", () => {
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
// 6. ctx not provided -> adjustPosition is not called (falls back to default logic)
// ─────────────────────────────────────────────────────

describe("ctx not provided -> skip adjustPosition", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("strategy has adjustPosition but ctx not provided -> uses default DCA", () => {
    const adjustSpy = vi.fn().mockReturnValue(500);
    const strategy: Strategy = {
      id: "test",
      name: "Test",
      populateSignal: () => "none",
      adjustPosition: adjustSpy,
    };
    const prices = { BTCUSDT: 48400 }; // down 3.2% > 3%
    // ctx not passed, adjustPosition should not be called
    const result = checkDcaTranches(prices, makeCfg(), strategy); // ctx=undefined
    expect(adjustSpy).not.toHaveBeenCalled();
    // Default DCA should trigger
    expect(result).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────
// 7. dcaCount / profitRatio / holdMs / costBasis correctly passed
// ─────────────────────────────────────────────────────

describe("position data correctly passed to adjustPosition", () => {
  let account: PaperAccount;
  let capturedPos: Parameters<NonNullable<Strategy["adjustPosition"]>>[0] | undefined;

  afterEach(() => vi.restoreAllMocks());

  it("dcaCount = completedTranches - 1 correctly passed", () => {
    // completedTranches = 2 -> dcaCount = 1
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

  it("profitRatio for long position calculated correctly", () => {
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

  it("holdMs is the holding duration (positive value)", () => {
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

  it("costBasis = quantity * entryPrice correctly passed", () => {
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
    // costBasis = 0.02 * 50000 = 1000
    expect(capturedPos?.costBasis).toBeCloseTo(1000, 2);
  });

  it("StrategyContext is correctly passed to adjustPosition", () => {
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
// 8. rsi-reversal.adjustPosition condition tests
// ─────────────────────────────────────────────────────

describe("rsi-reversal adjustPosition conditions", () => {
  const basePos = {
    symbol: "BTCUSDT",
    side: "long" as const,
    entryPrice: 50000,
    currentPrice: 48000,
    quantity: 0.02,
    costBasis: 1000,
    profitRatio: -0.04, // 4% loss (> 3% threshold)
    holdMs: 3_600_000,
    dcaCount: 0,
  };

  it("RSI < 20, loss > 3%, dcaCount < 2 -> returns costBasis * 0.5", () => {
    const ctx = makeCtx(15); // RSI = 15 < 20
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeCloseTo(500, 2); // 1000 * 0.5
  });

  it("RSI = 20 (boundary) -> does not trigger (>=20) -> null", () => {
    const ctx = makeCtx(20); // RSI = 20, does not satisfy < 20
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeNull();
  });

  it("RSI > 20 -> does not trigger -> null", () => {
    const ctx = makeCtx(25);
    const result = rsiReversalStrategy.adjustPosition!(basePos, ctx);
    expect(result).toBeNull();
  });

  it("profitRatio = -0.03 (boundary) -> does not trigger (>= -0.03) -> null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, profitRatio: -0.03 }; // exactly 3%, does not satisfy < -0.03
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("profitRatio = -0.02 (insufficient loss) -> does not trigger -> null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, profitRatio: -0.02 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("dcaCount = 2 (boundary) -> does not trigger -> null", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, dcaCount: 2 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeNull();
  });

  it("dcaCount = 1 -> still triggers (< 2)", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, dcaCount: 1 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeCloseTo(500, 2);
  });

  it("add amount = costBasis * 0.5 (different costBasis)", () => {
    const ctx = makeCtx(15);
    const pos = { ...basePos, costBasis: 2000 };
    const result = rsiReversalStrategy.adjustPosition!(pos, ctx);
    expect(result).toBeCloseTo(1000, 2); // 2000 * 0.5
  });
});

// ─────────────────────────────────────────────────────
// 9. Paper engine integration tests
// ─────────────────────────────────────────────────────

describe("paper engine integration", () => {
  let account: PaperAccount;

  afterEach(() => vi.restoreAllMocks());

  it("paper engine: rsi-reversal triggers DCA addition when conditions are met", () => {
    // RSI < 20, profitRatio < -0.03, dcaCount = 0 -> should trigger addition
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    // price = 48000, profitRatio = -0.04, RSI = 15
    const ctx = makeCtx(15);
    const prices = { BTCUSDT: 48000 };
    const result = checkDcaTranches(prices, makeCfg(), rsiReversalStrategy, ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("paper engine: rsi-reversal RSI > 20 -> no trigger (falls back to default DCA, insufficient drop)", () => {
    account = makeAccount(5000, {
      BTCUSDT: makePosition("BTCUSDT", 50000, 0.02, 1, 3),
    });
    vi.spyOn(accountModule, "loadAccount").mockReturnValue(account);
    vi.spyOn(accountModule, "saveAccount").mockImplementation(() => {});

    const ctx = makeCtx(50); // RSI = 50, does not trigger rsi-reversal
    const prices = { BTCUSDT: 49000 }; // down 2% < 3%, default DCA also does not trigger
    const result = checkDcaTranches(prices, makeCfg(), rsiReversalStrategy, ctx);
    expect(result).toHaveLength(0);
  });

  it("paper engine: strategy addition uses adjustPosition return value (not default position_ratio)", () => {
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
    // Addition amount = 123.45 USDT
    const posAfter = account.positions["BTCUSDT"]!;
    expect(posAfter.quantity).toBeGreaterThan(0.02);
  });
});

// ─────────────────────────────────────────────────────
// 10. Live executor integration (mock)
// ─────────────────────────────────────────────────────

/**
 * Creates a mock version of LiveExecutor to avoid BinanceClient reading real credential files.
 * Note: The LiveExecutor constructor synchronously reads credentials_path via new BinanceClient,
 * so here we use Object.create + manual client stub injection to bypass the constructor.
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

  // Use Object.create to skip the constructor (avoids BinanceClient reading credential files)
  const executor = Object.create(LiveExecutor.prototype) as InstanceType<typeof LiveExecutor>;

  const mockClient = {
    marketBuy: vi.fn(),
    marketSell: vi.fn(),
    getUsdtBalance: vi.fn().mockResolvedValue(5000),
  };

  // Inject private properties (bypassing TypeScript access checks)
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

  it("live checkDcaTranches: strategy returns > 0 -> marketBuy is called", async () => {
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
      adjustPosition: () => 120, // add $120
    };
    executor.strategy = strategy;

    const result = await executor.checkDcaTranches({ BTCUSDT: 48000 }, makeCtx());
    expect(mockClient.marketBuy).toHaveBeenCalledWith("BTCUSDT", 120);
    expect(result[0]?.side).toBe("add");
  });

  it("live checkDcaTranches: strategy returns < 0 -> marketSell is called", async () => {
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
      adjustPosition: () => -100, // reduce $100 -> qty = 100/50000 = 0.002
    };
    executor.strategy = strategy;

    const result = await executor.checkDcaTranches({ BTCUSDT: 50000 }, makeCtx());
    expect(mockClient.marketSell).toHaveBeenCalledWith("BTCUSDT", expect.closeTo(0.002, 4));
    expect(result[0]?.side).toBe("reduce");
  });
});

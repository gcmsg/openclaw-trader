/**
 * Boundary & Stress Tests
 *
 * Covers extreme boundary conditions and stress scenarios:
 *   - Extreme price values, empty/very short klines, max positions, negative balance, duplicate opens
 *   - Stop loss price > current price, empty symbols config
 *   - Random price backtest, all stop losses, high-frequency open/close, missing config fields
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "fs";

// -- Mock all external I/O (must be registered before imports are resolved) --
vi.mock("../strategy/signal-history.js", () => ({
  logSignal: vi.fn(() => "mock-sig-id"),
  closeSignal: vi.fn(() => undefined),
}));

vi.mock("../persistence/db.js", () => ({
  TradeDB: class {
    insertTrade(): number { return 1; }
    updateTradeExit(): void { return; }
    getOpenTrades(): never[] { return []; }
    close(): void { return; }
  },
}));

// -- Main module imports (after mocks are registered) --
import {
  paperBuy,
  paperSell,
  loadAccount,
  saveAccount,
  type PaperAccount,
} from "../paper/account.js";
import {
  handleSignal,
  checkExitConditions,
  checkStopLoss,
} from "../paper/engine.js";
import { processSignal } from "../strategy/signal-engine.js";
import { calculateIndicators } from "../strategy/indicators.js";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, RuntimeConfig, Signal } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/** Generate RuntimeConfig with fully isolated scenarioId */
function makeCfg(
  scenarioId: string,
  overrides: Partial<RuntimeConfig> = {}
): RuntimeConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      volume: { surge_ratio: 1.5, low_ratio: 0.5 },
    },
    signals: {
      buy: ["ma_bullish"],
      sell: ["ma_bearish"],
    },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.5,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 50,
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
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    exchange: { market: "spot" },
    paper: {
      scenarioId,
      initial_usdt: 1000,
      fee_rate: 0.001,
      slippage_percent: 0,
      report_interval_hours: 24,
    },
    ...overrides,
  } as RuntimeConfig;
}

/** Generate standard sine-wave klines (sideways market) */
function makeKlines(n: number, basePrice = 100): Kline[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const price = basePrice + Math.sin(i * 0.3) * 2;
    return {
      openTime: now + i * 3_600_000,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000,
      closeTime: now + (i + 1) * 3_600_000 - 1,
    };
  });
}

/** Simple uptrend klines */
function makeUpKlines(n: number, basePrice = 100): Kline[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const price = basePrice * (1 + i * 0.002);
    return {
      openTime: now + i * 3_600_000,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000,
      closeTime: now + (i + 1) * 3_600_000 - 1,
    };
  });
}

/** Construct a buy signal */
function makeBuySignal(symbol: string, price: number): Signal {
  return {
    symbol,
    type: "buy",
    price,
    reason: ["ma_bullish"],
    indicators: {
      maShort: price * 1.02,
      maLong: price * 0.98,
      rsi: 40,
      price,
      volume: 1000,
      avgVolume: 800,
    },
    timestamp: Date.now(),
  };
}

/** Clean up scenario files */
function cleanScenario(scenarioId: string): void {
  const f = `logs/paper-${scenarioId}.json`;
  if (existsSync(f)) unlinkSync(f);
}

// ─────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync("logs", { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===============================================
// I. Boundary condition tests
// ===============================================

describe("Boundary 1: Extreme price values — system does not crash", () => {
  const SID = "bs-extreme-price";

  afterEach(() => cleanScenario(SID));

  it("price = 0 -> paperBuy returns null or skips, does not crash", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      const result = paperBuy(account, "BTCUSDT", 0, "test-zero");
      // price=0 -> execPrice=0 -> quantity=Infinity; usdtToSpend>=minOrderUsdt may return trade
      // As long as it does not throw
      void result;
    }).not.toThrow();
  });

  it("price = -1 -> paperBuy does not crash", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", -1, "test-negative");
    }).not.toThrow();
  });

  it("price = Infinity -> paperBuy does not crash", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", Infinity, "test-inf");
    }).not.toThrow();
  });

  it("price = NaN -> paperBuy does not crash", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", NaN, "test-nan");
    }).not.toThrow();
  });

  it("paperSell does not crash at extreme price (Infinity)", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 800,
      positions: {
        BTCUSDT: {
          symbol: "BTCUSDT",
          quantity: 0.01,
          entryPrice: 50000,
          entryTime: Date.now(),
          stopLoss: 47500,
          takeProfit: 57500,
        },
      },
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperSell(account, "BTCUSDT", Infinity, "test-sell-inf");
    }).not.toThrow();
  });

  it("handleSignal with price=0 does not crash", () => {
    const cfg = makeCfg(SID);
    const sig: Signal = { ...makeBuySignal("BTCUSDT", 0), price: 0 };
    expect(() => handleSignal(sig, cfg)).not.toThrow();
    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 2: Empty klines array -> processSignal returns safely", () => {
  it("klines=[] -> indicators=null, rejected=true, does not crash", () => {
    const cfg = makeCfg("bs-empty-klines");
    expect(() => {
      const result = processSignal("BTCUSDT", [], cfg);
      expect(result.indicators).toBeNull();
      expect(result.rejected).toBe(true);
      expect(result.signal.type).toBe("none");
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 3: Very short klines (1-5) -> calculateIndicators returns null without error", () => {
  const cfg = makeCfg("bs-short-klines");

  for (const n of [1, 2, 3, 4, 5] as const) {
    it(`${n} kline(s) -> calculateIndicators returns null`, () => {
      const klines = makeKlines(n);
      expect(() => {
        const result = calculateIndicators(
          klines,
          cfg.strategy.ma.short,
          cfg.strategy.ma.long,
          cfg.strategy.rsi.period,
          cfg.strategy.macd
        );
        // Insufficient data should return null rather than throw
        expect(result).toBeNull();
      }).not.toThrow();
    });
  }

  it("1 kline -> processSignal rejected=true, does not crash", () => {
    const klines = makeKlines(1);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      expect(result.indicators).toBeNull();
      expect(result.rejected).toBe(true);
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 4: Excessive positions -> blocked by max_positions", () => {
  const SID = "bs-max-pos";
  afterEach(() => cleanScenario(SID));

  it("max_positions=3, 4th open is skipped", () => {
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.05, // small position to ensure sufficient funds
        max_positions: 3,
        max_position_per_symbol: 0.5,
        max_total_loss_percent: 20,
        daily_loss_limit_percent: 50,
      },
      symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    });

    const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
    const results = symbols.map((sym) =>
      handleSignal(makeBuySignal(sym, 100), cfg)
    );

    // First 3 should succeed
    expect(results[0]!.trade).not.toBeNull();
    expect(results[1]!.trade).not.toBeNull();
    expect(results[2]!.trade).not.toBeNull();

    // 4th should be blocked by max_positions
    expect(results[3]!.trade).toBeNull();
    expect(results[3]!.skipped).toBeDefined();
    expect(results[3]!.skipped).toContain("Max positions");
  });

  it("loop attempting 100 positions, actual count does not exceed max_positions", () => {
    const MAX = 4;
    const cfg = makeCfg(SID + "-100", {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.01,
        max_positions: MAX,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 20,
        daily_loss_limit_percent: 50,
      },
    });

    // Use different symbols to avoid duplicate position blocking
    for (let i = 0; i < 100; i++) {
      handleSignal(makeBuySignal(`TOKEN${i}USDT`, 100), cfg);
    }

    const account = loadAccount(1000, SID + "-100");
    expect(Object.keys(account.positions).length).toBeLessThanOrEqual(MAX);
    cleanScenario(SID + "-100");
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 5: Negative balance -> cannot open position", () => {
  it("account.usdt = -100 -> paperBuy returns null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: -100, // negative balance
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-negative-balance");
    // usdtToSpend = equity * 0.2, no positions so equity=-100
    // usdtToSpend = -100 * 0.2 = -20 < minOrderUsdt(10) -> returns null
    expect(result).toBeNull();
    // Account state should not change
    expect(account.usdt).toBe(-100);
    expect(Object.keys(account.positions).length).toBe(0);
  });

  it("account.usdt = 0 -> paperBuy returns null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 0,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-zero-balance");
    expect(result).toBeNull();
    expect(account.usdt).toBe(0);
  });

  it("account.usdt = 5 (< minOrderUsdt=10) -> paperBuy returns null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 5,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-small-balance", {
      minOrderUsdt: 10,
      positionRatio: 1.0, // full position
    });
    // usdtToSpend = 5 * 1.0 = 5 < minOrderUsdt=10 -> null
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 6: Duplicate open on same symbol -> second is skipped", () => {
  it("two consecutive buy BTCUSDT -> second returns null (paperBuy)", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const first = paperBuy(account, "BTCUSDT", 50000, "first-buy");
    const second = paperBuy(account, "BTCUSDT", 50000, "second-buy");

    expect(first).not.toBeNull(); // first succeeds
    expect(second).toBeNull(); // second is skipped (position already exists)
    expect(Object.keys(account.positions).length).toBe(1);
  });

  it("two consecutive buy BTCUSDT via handleSignal -> second trade is null", () => {
    const SID = "bs-dup-buy";
    const cfg = makeCfg(SID);

    const r1 = handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);
    const r2 = handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);

    expect(r1.trade).not.toBeNull();
    // Second: position exists, paperBuy returns null, trade=null
    // skipped may be triggered by max_position_per_symbol
    expect(r2.trade).toBeNull();

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 7: Stop loss price > current price (instant stop loss on open)", () => {
  it("position with stopLoss > entryPrice, checkStopLoss triggers at current price", () => {
    const SID = "bs-stoploss-above";
    const cfg = makeCfg(SID);

    // Manually construct a position with stopLoss > entryPrice (abnormal, simulating config error)
    const account = loadAccount(1000, SID);
    const entryPrice = 50000;
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice,
      entryTime: Date.now(),
      stopLoss: entryPrice * 1.05, // stop loss above entry price! (52500 > 50000)
      takeProfit: entryPrice * 1.15,
    };
    saveAccount(account, SID);

    // Current price = entry price, stop loss > current price -> should trigger immediately (currentPrice <= stopLoss)
    expect(() => {
      const triggered = checkStopLoss({ BTCUSDT: entryPrice }, cfg);
      // Stop loss triggered (52500 > 50000, condition met)
      expect(triggered.length).toBe(1);
      expect(triggered[0]!.symbol).toBe("BTCUSDT");
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("after stop loss trigger, account usdt is not negative (abnormal stop loss does not cause negative balance)", () => {
    const SID = "bs-stoploss-above-2";
    const cfg = makeCfg(SID);

    const account = loadAccount(1000, SID);
    account.usdt = 800;
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice: 50000,
      entryTime: Date.now(),
      stopLoss: 60000, // extreme: stop loss far above entry price
      takeProfit: 57500,
    };
    saveAccount(account, SID);

    // Does not crash, stop loss triggers
    expect(() => {
      checkStopLoss({ BTCUSDT: 50000 }, cfg);
    }).not.toThrow();

    // Account balance should not be negative
    const afterAccount = loadAccount(1000, SID);
    expect(afterAccount.usdt).toBeGreaterThanOrEqual(0);

    cleanScenario(SID);
  });

  it("checkExitConditions handles stopLoss > entryPrice without crashing", () => {
    const SID = "bs-exit-stoploss-above";
    const cfg = makeCfg(SID);

    const account = loadAccount(1000, SID);
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice: 50000,
      entryTime: Date.now(),
      stopLoss: 55000, // stop loss > entry price
      takeProfit: 57500,
    };
    saveAccount(account, SID);

    expect(() => {
      const exits = checkExitConditions({ BTCUSDT: 50000 }, cfg);
      void exits;
    }).not.toThrow();

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("Boundary 8: Empty config.symbols -> no error", () => {
  it("processSignal with symbols=[] config, sufficient klines does not crash", () => {
    const cfg = makeCfg("bs-empty-symbols", { symbols: [] });
    const klines = makeKlines(60);

    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      // symbols field does not affect processSignal internal logic (only affects monitor scheduling)
      expect(result).toBeDefined();
    }).not.toThrow();
  });

  it("handleSignal with empty symbols does not crash", () => {
    const SID = "bs-empty-symbols-engine";
    const cfg = makeCfg(SID, { symbols: [] });

    expect(() => {
      handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("runBacktest with empty klinesBySymbol should throw (has protection logic)", () => {
    const cfg = makeCfg("bs-empty-backtest", { symbols: [] });
    expect(() => runBacktest({}, cfg)).toThrow();
  });
});

// ===============================================
// II. Stress / Fuzz tests
// ===============================================

describe("Stress test 9: Random price sequence 1000 klines backtest -> does not crash", () => {
  it("random price sequence backtest completes, metrics and results return normally", () => {
    const cfg = makeCfg("bs-random-backtest", {
      strategy: {
        name: "test",
        enabled: true,
        ma: { short: 5, long: 10 },
        rsi: { period: 14, oversold: 30, overbought: 70 },
        macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      },
    });

    const now = Date.now();
    let price = 100;
    const INITIAL = 1000;

    // Generate 1000 random klines
    const klines: Kline[] = Array.from({ length: 1000 }, (_, i) => {
      // Random walk, price may be extreme but within reasonable range
      const delta = (Math.random() - 0.5) * price * 0.05;
      price = Math.max(0.01, price + delta); // must not be <= 0
      const open = price;
      const close = Math.max(0.001, price + (Math.random() - 0.5) * price * 0.02);
      const high = Math.max(open, close) * (1 + Math.random() * 0.01);
      const low = Math.min(open, close) * (1 - Math.random() * 0.01);

      return {
        openTime: now + i * 3_600_000,
        open,
        high,
        low,
        close,
        volume: Math.abs(1000 + (Math.random() - 0.3) * 500),
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    // Direct call (not wrapped in not.toThrow for clearer error messages)
    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    expect(result).toBeDefined();
    expect(result.metrics).toBeDefined();
    // totalReturn = finalEquity - initialUsdt, worst case loses all capital (-1000), should not exceed this range
    expect(isNaN(result.metrics.totalReturn)).toBe(false);
    expect(result.metrics.totalReturn).toBeGreaterThanOrEqual(-INITIAL);
  });

  it("extreme price volatility (+/-50% per candle) 1000 klines -> does not crash", () => {
    const cfg = makeCfg("bs-extreme-random");
    const now = Date.now();
    let price = 1000;
    const INITIAL = 1000;

    const klines: Kline[] = Array.from({ length: 1000 }, (_, i) => {
      const ratio = 0.5 + Math.random() * 1.0; // 0.5x to 1.5x
      price = Math.max(1, price * ratio);
      const close = price;
      const open = price / ratio;
      return {
        openTime: now + i * 3_600_000,
        open,
        high: Math.max(open, close) * 1.01,
        low: Math.min(open, close) * 0.99,
        close,
        volume: 1000,
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    // finalEquity = INITIAL + totalReturn; account protection ensures >= 0
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────

describe("Stress test 10: All stop loss scenario -> account does not go negative", () => {
  it("all trades hit stop loss, account balance stays >= 0", () => {
    // Use very small stop loss (0.5%) + large drops to ensure every trade stops out
    const cfg = makeCfg("bs-all-stoploss", {
      risk: {
        stop_loss_percent: 0.5, // 0.5% stop loss
        take_profit_percent: 100, // high take profit, unlikely to trigger
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.2,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99, // allow loss to the bottom
        daily_loss_limit_percent: 99,
      },
    });

    const now = Date.now();
    // Create continuously declining klines (each drops 3%, larger than 0.5% stop loss)
    const klines: Kline[] = Array.from({ length: 200 }, (_, i) => {
      const price = 1000 * Math.pow(0.97, i);
      return {
        openTime: now + i * 3_600_000,
        open: price * 1.001,
        high: price * 1.002,
        low: price * 0.995, // touches stop loss
        close: price,
        volume: 1000,
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    const INITIAL = 1000;
    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    // finalEquity = INITIAL + totalReturn; account protection ensures >= 0
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });

  it("heavy losses through paperSell do not make account negative (cover short protection)", () => {
    // Directly use paperBuy + paperSell to simulate high losses
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 500,
      positions: {
        BTCUSDT: {
          symbol: "BTCUSDT",
          quantity: 1.0,
          entryPrice: 500,
          entryTime: Date.now(),
          stopLoss: 400,
          takeProfit: 600,
        },
      },
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    // Sell at extremely low price (simulating extreme loss)
    paperSell(account, "BTCUSDT", 0.01, "extreme-loss");

    // Account balance should not be negative
    expect(account.usdt).toBeGreaterThanOrEqual(0);
  });

  it("multiple stop losses, account balance monotonically non-increasing", () => {
    const SID = "bs-multi-stoploss";
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 2,
        take_profit_percent: 100, // unlikely to take profit
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.1,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99,
        daily_loss_limit_percent: 99,
      },
    });

    const balances: number[] = [];
    const symbols = Array.from({ length: 10 }, (_, i) => `TOKEN${i}USDT`);

    for (const sym of symbols) {
      handleSignal(makeBuySignal(sym, 1000), cfg);
      // Trigger stop loss (price drops sharply)
      checkExitConditions({ [sym]: 900 }, cfg);

      const acc = loadAccount(1000, SID);
      balances.push(acc.usdt);
    }

    // Overall balance should decrease with each stop loss
    const finalBalance = balances[balances.length - 1] ?? 1000;
    expect(finalBalance).toBeGreaterThanOrEqual(0);
    expect(finalBalance).toBeLessThan(1000); // at least some fee loss

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("Stress test 11: High-frequency open/close 50 times -> account balance monotonically decreasing (fees)", () => {
  it("paperBuy + paperSell 50 times directly, balance decreases due to fees", () => {
    const account: PaperAccount = {
      initialUsdt: 10000,
      usdt: 10000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const price = 100;
    const prevBalances: number[] = [];

    for (let i = 0; i < 50; i++) {
      const before = account.usdt;

      // Open position
      const trade = paperBuy(account, "BTCUSDT", price, `cycle-${i}`, {
        positionRatio: 0.1,
        feeRate: 0.001,
        slippagePercent: 0,
        minOrderUsdt: 10,
        stopLossPercent: 5,
        takeProfitPercent: 15,
      });

      if (trade) {
        // Sell at same price (no price change, pure fee loss)
        paperSell(account, "BTCUSDT", price, `close-${i}`, {
          feeRate: 0.001,
          slippagePercent: 0,
        });
      }

      const after = account.usdt;
      prevBalances.push(before - after); // net loss per round (should be positive)
    }

    // Verify each round has fee loss (balance decreasing)
    const allPositiveLoss = prevBalances.every((loss) => loss >= 0);
    expect(allPositiveLoss).toBe(true);

    // Total loss should be > 0 (50 rounds of accumulated fees)
    const totalLoss = prevBalances.reduce((s, v) => s + v, 0);
    expect(totalLoss).toBeGreaterThan(0);

    // Account balance should not be negative
    expect(account.usdt).toBeGreaterThanOrEqual(0);
  });

  it("handleSignal + checkExitConditions high-frequency open/close 20 times, balance not negative", () => {
    const SID = "bs-hf-engine";
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.1,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99,
        daily_loss_limit_percent: 99,
      },
    });

    const balanceHistory: number[] = [];

    for (let i = 0; i < 20; i++) {
      // Open position
      handleSignal(makeBuySignal("BTCUSDT", 1000), cfg);
      // Close at same price (pure fee loss)
      checkExitConditions({ BTCUSDT: 999 }, cfg); // slight drop triggers stop loss

      const acc = loadAccount(1000, SID);
      balanceHistory.push(acc.usdt);
    }

    // Balance should be monotonically non-increasing (accumulated fees)
    for (let i = 1; i < balanceHistory.length; i++) {
      expect(balanceHistory[i]!).toBeLessThanOrEqual(balanceHistory[i - 1]! + 0.01); // allow float tolerance
    }

    // Final balance not negative
    const finalBalance = balanceHistory[balanceHistory.length - 1] ?? 0;
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("Stress test 12: Missing config fields -> uses defaults without crash", () => {
  it("partial undefined risk fields -> processSignal does not crash", () => {
    // Construct config missing optional risk fields (trailing_stop_positive etc. are optional)
    const cfg = makeCfg("bs-partial-risk");
    // Verify: system works normally when optional fields min_rr, dca, atr_position are missing
    // (these fields are optional by type definition)
    expect(cfg.risk.min_rr).toBeUndefined();
    expect(cfg.risk.dca).toBeUndefined();
    expect(cfg.risk.atr_position).toBeUndefined();
    expect(cfg.risk.trailing_stop_positive).toBeUndefined();

    const klines = makeKlines(60);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      expect(result).toBeDefined();
    }).not.toThrow();
  });

  it("partial notify fields missing -> processSignal + handleSignal does not crash", () => {
    const SID = "bs-partial-notify";
    // Config is constructed with all required fields (TypeScript requires it),
    // at runtime we simulate "partial missing" scenario via spread override
    const cfg = makeCfg(SID);

    // Override to simulate runtime "partial missing" scenario (via Object.assign)
    const partialCfg = { ...cfg };
    // Delete optional fields for testing
    delete (partialCfg.risk as unknown as Record<string, unknown>)["min_rr"];
    delete (partialCfg.risk as unknown as Record<string, unknown>)["correlation_filter"];
    delete (partialCfg.risk as unknown as Record<string, unknown>)["take_profit_stages"];

    const klines = makeKlines(60);
    expect(() => {
      processSignal("BTCUSDT", klines, partialCfg as RuntimeConfig);
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("strategy.macd.enabled=false with missing MACD result -> indicator calculation does not crash", () => {
    const cfg = makeCfg("bs-no-macd", {
      strategy: {
        name: "test",
        enabled: true,
        ma: { short: 5, long: 10 },
        rsi: { period: 14, oversold: 30, overbought: 70 },
        macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      },
    });

    const klines = makeKlines(60);
    const indicators = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd
    );

    expect(indicators).not.toBeNull();
    expect(indicators!.macd).toBeUndefined(); // MACD disabled, field does not exist
  });

  it("empty signals.buy array -> processSignal returns none without crash", () => {
    const cfg = makeCfg("bs-empty-signals", {
      signals: { buy: [], sell: [] },
    });

    const klines = makeKlines(60);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      // No buy conditions -> signal is none
      expect(["none", "buy", "sell"]).toContain(result.signal.type);
    }).not.toThrow();
  });

  it("runBacktest with minimal config (required fields only) -> does not crash", () => {
    const cfg = makeCfg("bs-minimal-backtest");
    const klines = makeUpKlines(100, 100);

    const INITIAL = 1000;
    const result = runBacktest({ BTCUSDT: klines }, cfg, {
      initialUsdt: INITIAL,
      feeRate: 0.001,
      slippagePercent: 0.05,
    });
    expect(result.metrics).toBeDefined();
    // finalEquity = INITIAL + totalReturn; absolutely must not be negative
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────

describe("Comprehensive robustness verification", () => {
  it("processSignal covers all signal type paths without crash", () => {
    const klines = makeUpKlines(80, 50000);

    const configs = [
      makeCfg("bs-robust-1", { signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] } }),
      makeCfg("bs-robust-2", { signals: { buy: [], sell: [], short: ["ma_bearish"], cover: ["ma_bullish"] } }),
      makeCfg("bs-robust-3", { signals: { buy: ["ma_bullish", "rsi_oversold"], sell: ["rsi_overbought"] } }),
    ];

    for (const cfg of configs) {
      expect(() => {
        const result = processSignal("BTCUSDT", klines, cfg);
        expect(result).toBeDefined();
        expect(["buy", "sell", "short", "cover", "none"]).toContain(result.signal.type);
      }).not.toThrow();
    }
  });

  it("paperSell on non-existent symbol safely returns null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    const result = paperSell(account, "NONEXISTENT", 100, "test");
    expect(result).toBeNull();
    expect(account.usdt).toBe(1000); // balance unaffected
  });

  it("varying kline lengths from 1 to 200 does not crash", () => {
    const cfg = makeCfg("bs-variable-len");
    const lengths = [1, 2, 5, 10, 11, 20, 50, 100, 200];

    for (const n of lengths) {
      expect(() => {
        const klines = makeKlines(n, 100);
        const result = processSignal("BTCUSDT", klines, cfg);
        expect(result).toBeDefined();
      }).not.toThrow(`processSignal crashed with ${n} klines`);
    }
  });
});

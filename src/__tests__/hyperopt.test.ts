/**
 * P6.1 Hyperopt — Unit Tests
 *
 * Fully mocked, no network requests.
 * Covers:
 *   - ParamDef constraint validation (ma_short < ma_long)
 *   - evaluateParams score calculation
 *   - BayesianOptimizer suggest/observe/best
 *   - best() returns highest score after N observations
 *   - Walk-forward data splitting logic
 *   - param-space utility functions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Kline, StrategyConfig } from "../types.js";
import {
  DEFAULT_PARAM_SPACE,
  decodeParam,
  encodeParam,
  sampleRandom,
  perturbParams,
} from "../optimization/param-space.js";
import type { ParamDef, ParamSet } from "../optimization/param-space.js";
import { applyParams, evaluateParams } from "../optimization/objective.js";
import { BayesianOptimizer, splitKlines } from "../optimization/bayesian.js";
import { runBacktest } from "../backtest/runner.js";

// ─────────────────────────────────────────────────────
// Mock runBacktest at module level
// ─────────────────────────────────────────────────────

const mockReturnValue = {
  metrics: {
    sharpeRatio: 1.2,
    maxDrawdown: 10,
    totalReturnPercent: 15,
    totalTrades: 30,
    winRate: 0.55,
    profitFactor: 1.5,
    sortinoRatio: 1.8,
    totalReturn: 150,
    wins: 17,
    losses: 13,
    maxDrawdownUsdt: 100,
    avgWinPercent: 3,
    avgLossPercent: 2,
    winLossRatio: 1.5,
    avgHoldingHours: 12,
    stopLossCount: 5,
    takeProfitCount: 10,
    trailingStopCount: 2,
    signalExitCount: 8,
    endOfDataCount: 5,
    bestTradePct: 8,
    worstTradePct: -3,
    calmarRatio: 1.5,
    equityCurve: [],
  },
  trades: [],
  totalFundingPaid: 0,
  perSymbol: {},
  config: {
    strategy: "test",
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    startDate: "2025-01-01",
    endDate: "2025-03-01",
    days: 60,
    initialUsdt: 1000,
    fundingEnabled: false,
    spreadBps: 0,
    signalToNextOpen: false,
  },
};

vi.mock("../backtest/runner.js", () => ({
  runBacktest: vi.fn(() => mockReturnValue),
}));

// ─────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────

function makeKline(i: number): Kline {
  return {
    openTime:  i * 3_600_000,
    closeTime: i * 3_600_000 + 3_599_999,
    open:  100 + i * 0.1,
    high:  102 + i * 0.1,
    low:   98  + i * 0.1,
    close: 101 + i * 0.1,
    volume: 1000 + i,
  };
}

function makeKlines(n: number): Kline[] {
  return Array.from({ length: n }, (_, i) => makeKline(i));
}

function makeBaseCfg(): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 10, long: 50 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: 3,
      take_profit_percent: 8,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 3,
      max_position_per_symbol: 0.5,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 5,
    },
    execution: { min_order_usdt: 10, min_interval_minutes: 5 },
    notify: { telegram: { enabled: false, bot_token: "", chat_id: "" }, min_interval_minutes: 60 },
    news: { enabled: false, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 25 },
    mode: "notify_only",
  } as unknown as StrategyConfig;
}

// ─────────────────────────────────────────────────────
// 1. param-space utility functions
// ─────────────────────────────────────────────────────

describe("param-space utility functions", () => {
  it("decodeParam: int type correctly aligns to step=1", () => {
    const def: ParamDef = { name: "ma_short", type: "int", min: 5, max: 50, step: 1 };
    const val = decodeParam(def, 0.5); // 5 + 0.5 * 45 = 27.5 → 28
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(50);
  });

  it("decodeParam: int type step=5 correctly aligns", () => {
    const def: ParamDef = { name: "ma_long", type: "int", min: 20, max: 200, step: 5 };
    const val = decodeParam(def, 0.5); // 20 + 0.5 * 180 = 110 → 110 (divisible by 5)
    expect(val % 5).toBe(0);
    expect(val).toBeGreaterThanOrEqual(20);
    expect(val).toBeLessThanOrEqual(200);
  });

  it("decodeParam: float type boundary values are correct", () => {
    const def: ParamDef = { name: "rsi_overbought", type: "float", min: 60, max: 80 };
    expect(decodeParam(def, 0.0)).toBeCloseTo(60);
    expect(decodeParam(def, 1.0)).toBeCloseTo(80);
  });

  it("encodeParam: correctly encodes actual value back to [0,1]", () => {
    const def: ParamDef = { name: "stop_loss_pct", type: "float", min: 2, max: 10 };
    const encoded = encodeParam(def, 6); // (6-2)/(10-2) = 0.5
    expect(encoded).toBeCloseTo(0.5);
  });

  it("encodeParam and decodeParam are inverse operations (float)", () => {
    const def: ParamDef = { name: "position_ratio", type: "float", min: 0.1, max: 0.4 };
    const original = 0.25;
    expect(decodeParam(def, encodeParam(def, original))).toBeCloseTo(original, 5);
  });

  it("sampleRandom: generated params are within valid range", () => {
    let s = 42;
    const rng = () => { s = ((s * 1664525 + 1013904223) >>> 0); return s / 0x100000000; };
    const params = sampleRandom(DEFAULT_PARAM_SPACE, rng);
    expect(params["ma_short"]).toBeGreaterThanOrEqual(5);
    expect(params["ma_short"]).toBeLessThanOrEqual(50);
    expect(params["ma_long"]).toBeGreaterThanOrEqual(20);
    expect(params["ma_long"]).toBeLessThanOrEqual(200);
    expect(params["position_ratio"]).toBeGreaterThanOrEqual(0.1);
    expect(params["position_ratio"]).toBeLessThanOrEqual(0.4);
  });

  it("perturbParams: perturbed params remain within valid range", () => {
    const base: ParamSet = {
      ma_short: 15, ma_long: 60, rsi_period: 14,
      rsi_overbought: 70, rsi_oversold: 30,
      stop_loss_pct: 5, take_profit_pct: 15, position_ratio: 0.2,
    };
    let s = 100;
    const rng = () => { s = ((s * 1664525 + 1013904223) >>> 0); return s / 0x100000000; };
    const perturbed = perturbParams(base, DEFAULT_PARAM_SPACE, 0.1, rng);
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(perturbed[def.name]).toBeGreaterThanOrEqual(def.min);
      expect(perturbed[def.name]).toBeLessThanOrEqual(def.max);
    }
  });
});

// ─────────────────────────────────────────────────────
// 2. applyParams — parameter overrides
// ─────────────────────────────────────────────────────

describe("applyParams", () => {
  it("correctly overrides MA params in config", () => {
    const cfg = applyParams({ ma_short: 18, ma_long: 55 }, makeBaseCfg());
    expect(cfg.strategy.ma.short).toBe(18);
    expect(cfg.strategy.ma.long).toBe(55);
    expect(cfg.strategy.rsi.period).toBe(14); // not overridden, stays the same
  });

  it("correctly overrides RSI params", () => {
    const cfg = applyParams({ rsi_period: 10, rsi_overbought: 75, rsi_oversold: 25 }, makeBaseCfg());
    expect(cfg.strategy.rsi.period).toBe(10);
    expect(cfg.strategy.rsi.overbought).toBe(75);
    expect(cfg.strategy.rsi.oversold).toBe(25);
  });

  it("correctly overrides risk params", () => {
    const cfg = applyParams({ stop_loss_pct: 4, take_profit_pct: 12, position_ratio: 0.3 }, makeBaseCfg());
    expect(cfg.risk.stop_loss_percent).toBe(4);
    expect(cfg.risk.take_profit_percent).toBe(12);
    expect(cfg.risk.position_ratio).toBe(0.3);
  });

  it("does not modify original config (immutability)", () => {
    const baseCfg = makeBaseCfg();
    applyParams({ ma_short: 99 }, baseCfg);
    expect(baseCfg.strategy.ma.short).toBe(10);
  });
});

// ─────────────────────────────────────────────────────
// 3. evaluateParams — constraints + score calculation (via runBacktest mock)
// ─────────────────────────────────────────────────────

describe("evaluateParams", () => {
  const mockedRunBacktest = vi.mocked(runBacktest);

  beforeEach(() => {
    mockedRunBacktest.mockReturnValue(mockReturnValue as ReturnType<typeof runBacktest>);
  });

  it("returns score=-999 when ma_short >= ma_long (constraint violation)", async () => {
    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(200)]]);
    const { score } = await evaluateParams({ ma_short: 50, ma_long: 30 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBe(-999);
    // runBacktest should not be called
    expect(mockedRunBacktest).not.toHaveBeenCalled();
  });

  it("also returns score=-999 when ma_short == ma_long", async () => {
    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(200)]]);
    const { score } = await evaluateParams({ ma_short: 40, ma_long: 40 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBe(-999);
  });

  it("score = sharpe - 0.5 * (maxDrawdown/100) formula is correct", async () => {
    // sharpe=1.5, maxDrawdown=20 → score = 1.5 - 0.5*(20/100) = 1.4
    mockedRunBacktest.mockReturnValue({
      ...mockReturnValue,
      metrics: { ...mockReturnValue.metrics, sharpeRatio: 1.5, maxDrawdown: 20 },
    } as ReturnType<typeof runBacktest>);

    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(300)]]);
    const { score } = await evaluateParams({ ma_short: 10, ma_long: 50 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBeCloseTo(1.5 - 0.5 * (20 / 100), 5);
  });

  it("throws error when klineCache has no matching symbol", async () => {
    const emptyCache = new Map<string, Kline[]>();
    await expect(
      evaluateParams({ ma_short: 10, ma_long: 50 }, "BTCUSDT", makeBaseCfg(), emptyCache)
    ).rejects.toThrow();
  });

  it("metrics contain correct fields for valid params", async () => {
    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(300)]]);
    const { metrics } = await evaluateParams({ ma_short: 10, ma_long: 50 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(metrics).toHaveProperty("sharpeRatio");
    expect(metrics).toHaveProperty("maxDrawdown");
    expect(metrics).toHaveProperty("totalTrades");
  });
});

// ─────────────────────────────────────────────────────
// 4. BayesianOptimizer
// ─────────────────────────────────────────────────────

describe("BayesianOptimizer", () => {
  it("initial state best() returns null", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    expect(opt.best()).toBeNull();
  });

  it("suggest() returns params containing all space fields", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const params = opt.suggest();
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(params[def.name]).toBeDefined();
      expect(typeof params[def.name]).toBe("number");
    }
  });

  it("suggest() returns params within valid range (multiple samples)", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 99);
    for (let i = 0; i < 10; i++) {
      const params = opt.suggest();
      for (const def of DEFAULT_PARAM_SPACE) {
        expect(params[def.name]!).toBeGreaterThanOrEqual(def.min);
        expect(params[def.name]!).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it("observe() correctly records observation results", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const params = opt.suggest();
    opt.observe(params, 1.5);
    expect(opt.trialCount).toBe(1);
    expect(opt.best()!.score).toBe(1.5);
  });

  it("best() returns highest score after multiple observations", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const scores = [0.5, 2.3, 1.1, -0.5, 1.8];
    for (const score of scores) {
      opt.observe(opt.suggest(), score);
    }
    expect(opt.best()!.score).toBe(2.3);
  });

  it("still returns historical best score after 30 observations", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 7, 5);
    let maxSeen = -Infinity;
    for (let i = 0; i < 30; i++) {
      const score = Math.sin(i) + Math.cos(i * 0.3);
      if (score > maxSeen) maxSeen = score;
      opt.observe(opt.suggest(), score);
    }
    expect(opt.best()!.score).toBeCloseTo(maxSeen, 10);
  });

  it("after warm-up, suggest() enters EI path without throwing", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 13, 3); // warmup=3
    for (let i = 0; i < 3; i++) {
      opt.observe(opt.suggest(), i * 0.5);
    }
    // Past warmup, should take the EI path
    expect(() => opt.suggest()).not.toThrow();
    const params = opt.suggest();
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(params[def.name]!).toBeGreaterThanOrEqual(def.min);
      expect(params[def.name]!).toBeLessThanOrEqual(def.max);
    }
  });

  it("two optimizers with the same seed produce identical warm-up sequences", () => {
    const opt1 = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 12345);
    const opt2 = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 12345);
    for (let i = 0; i < 5; i++) {
      const p1 = opt1.suggest();
      const p2 = opt2.suggest();
      for (const def of DEFAULT_PARAM_SPACE) {
        expect(p1[def.name]).toBeCloseTo(p2[def.name]!, 8);
      }
      opt1.observe(p1, i * 0.3);
      opt2.observe(p2, i * 0.3);
    }
  });

  it("getHistory() returns all observation records in chronological order", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    for (let i = 0; i < 5; i++) {
      opt.observe(opt.suggest(), i * 0.4);
    }
    const history = opt.getHistory();
    expect(history).toHaveLength(5);
    expect(history[4]!.score).toBeCloseTo(4 * 0.4, 5);
  });

  it("best() returns a copy of the original params (immutable)", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const p = opt.suggest();
    opt.observe(p, 1.0);
    const best = opt.best()!;
    best.params["ma_short"] = 9999; // modify the copy
    expect(opt.best()!.params["ma_short"]).not.toBe(9999); // original is unaffected
  });
});

// ─────────────────────────────────────────────────────
// 5. Walk-Forward data splitting
// ─────────────────────────────────────────────────────

describe("splitKlines (Walk-Forward)", () => {
  it("default 70/30 split ratio is correct", () => {
    const { train, test } = splitKlines(makeKlines(100));
    expect(train).toHaveLength(70);
    expect(test).toHaveLength(30);
  });

  it("custom 80/20 split ratio is correct", () => {
    const { train, test } = splitKlines(makeKlines(200), 0.8);
    expect(train).toHaveLength(160);
    expect(test).toHaveLength(40);
  });

  it("train.length + test.length === original count", () => {
    const klines = makeKlines(150);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(150);
  });

  it("split preserves chronological order (train before test)", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines);
    expect(train[train.length - 1]!.openTime).toBeLessThan(test[0]!.openTime);
  });

  it("ratio=0: train is empty, test is full set", () => {
    const { train, test } = splitKlines(makeKlines(10), 0);
    expect(train).toHaveLength(0);
    expect(test).toHaveLength(10);
  });

  it("ratio=1: test is empty, train is full set", () => {
    const { train, test } = splitKlines(makeKlines(10), 1);
    expect(train).toHaveLength(10);
    expect(test).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 6. DEFAULT_PARAM_SPACE structure validation
// ─────────────────────────────────────────────────────

describe("DEFAULT_PARAM_SPACE structure", () => {
  it("contains all 8 parameter definitions", () => {
    const names = DEFAULT_PARAM_SPACE.map((d) => d.name);
    const required = [
      "ma_short", "ma_long", "rsi_period",
      "rsi_overbought", "rsi_oversold",
      "stop_loss_pct", "take_profit_pct", "position_ratio",
    ];
    for (const name of required) {
      expect(names).toContain(name);
    }
    expect(DEFAULT_PARAM_SPACE).toHaveLength(8);
  });

  it("all params have min < max (valid definitions)", () => {
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(def.min).toBeLessThan(def.max);
    }
  });

  it("int type params all have a step field", () => {
    const intParams = DEFAULT_PARAM_SPACE.filter((d) => d.type === "int");
    expect(intParams.length).toBeGreaterThan(0);
    for (const def of intParams) {
      expect(def.step).toBeDefined();
      expect(def.step!).toBeGreaterThan(0);
    }
  });

  it("position_ratio range is within (0, 1) (reasonable position size)", () => {
    const def = DEFAULT_PARAM_SPACE.find((d) => d.name === "position_ratio")!;
    expect(def.min).toBeGreaterThan(0);
    expect(def.max).toBeLessThan(1);
  });
});

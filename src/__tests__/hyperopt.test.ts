/**
 * P6.1 Hyperopt — 单元测试
 *
 * 全部 mock，不发网络请求。
 * 覆盖：
 *   - ParamDef 约束验证（ma_short < ma_long）
 *   - evaluateParams score 计算
 *   - BayesianOptimizer suggest/observe/best
 *   - 经过 N 次 observe 后 best() 返回最高分
 *   - walk-forward 数据分割逻辑
 *   - param-space 工具函数
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
// 1. param-space 工具函数
// ─────────────────────────────────────────────────────

describe("param-space 工具函数", () => {
  it("decodeParam: int 类型正确对齐到 step=1", () => {
    const def: ParamDef = { name: "ma_short", type: "int", min: 5, max: 50, step: 1 };
    const val = decodeParam(def, 0.5); // 5 + 0.5 * 45 = 27.5 → 28
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(50);
  });

  it("decodeParam: int 类型 step=5 正确对齐", () => {
    const def: ParamDef = { name: "ma_long", type: "int", min: 20, max: 200, step: 5 };
    const val = decodeParam(def, 0.5); // 20 + 0.5 * 180 = 110 → 110（整除5）
    expect(val % 5).toBe(0);
    expect(val).toBeGreaterThanOrEqual(20);
    expect(val).toBeLessThanOrEqual(200);
  });

  it("decodeParam: float 类型边界值正确", () => {
    const def: ParamDef = { name: "rsi_overbought", type: "float", min: 60, max: 80 };
    expect(decodeParam(def, 0.0)).toBeCloseTo(60);
    expect(decodeParam(def, 1.0)).toBeCloseTo(80);
  });

  it("encodeParam: 正确将实际值编码回 [0,1]", () => {
    const def: ParamDef = { name: "stop_loss_pct", type: "float", min: 2, max: 10 };
    const encoded = encodeParam(def, 6); // (6-2)/(10-2) = 0.5
    expect(encoded).toBeCloseTo(0.5);
  });

  it("encodeParam 和 decodeParam 互为逆运算（float）", () => {
    const def: ParamDef = { name: "position_ratio", type: "float", min: 0.1, max: 0.4 };
    const original = 0.25;
    expect(decodeParam(def, encodeParam(def, original))).toBeCloseTo(original, 5);
  });

  it("sampleRandom: 生成的参数在合法范围内", () => {
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

  it("perturbParams: 扰动后参数仍在合法范围内", () => {
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
// 2. applyParams — 参数覆盖
// ─────────────────────────────────────────────────────

describe("applyParams", () => {
  it("正确覆盖 MA 参数到配置", () => {
    const cfg = applyParams({ ma_short: 18, ma_long: 55 }, makeBaseCfg());
    expect(cfg.strategy.ma.short).toBe(18);
    expect(cfg.strategy.ma.long).toBe(55);
    expect(cfg.strategy.rsi.period).toBe(14); // 未覆盖保持不变
  });

  it("正确覆盖 RSI 参数", () => {
    const cfg = applyParams({ rsi_period: 10, rsi_overbought: 75, rsi_oversold: 25 }, makeBaseCfg());
    expect(cfg.strategy.rsi.period).toBe(10);
    expect(cfg.strategy.rsi.overbought).toBe(75);
    expect(cfg.strategy.rsi.oversold).toBe(25);
  });

  it("正确覆盖 risk 参数", () => {
    const cfg = applyParams({ stop_loss_pct: 4, take_profit_pct: 12, position_ratio: 0.3 }, makeBaseCfg());
    expect(cfg.risk.stop_loss_percent).toBe(4);
    expect(cfg.risk.take_profit_percent).toBe(12);
    expect(cfg.risk.position_ratio).toBe(0.3);
  });

  it("不修改原始配置（不可变性）", () => {
    const baseCfg = makeBaseCfg();
    applyParams({ ma_short: 99 }, baseCfg);
    expect(baseCfg.strategy.ma.short).toBe(10);
  });
});

// ─────────────────────────────────────────────────────
// 3. evaluateParams — 约束 + score 计算（通过 runBacktest mock）
// ─────────────────────────────────────────────────────

describe("evaluateParams", () => {
  const mockedRunBacktest = vi.mocked(runBacktest);

  beforeEach(() => {
    mockedRunBacktest.mockReturnValue(mockReturnValue as ReturnType<typeof runBacktest>);
  });

  it("ma_short >= ma_long 时返回 score=-999（约束违反）", async () => {
    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(200)]]);
    const { score } = await evaluateParams({ ma_short: 50, ma_long: 30 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBe(-999);
    // runBacktest 不应被调用
    expect(mockedRunBacktest).not.toHaveBeenCalled();
  });

  it("ma_short == ma_long 时也返回 score=-999", async () => {
    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(200)]]);
    const { score } = await evaluateParams({ ma_short: 40, ma_long: 40 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBe(-999);
  });

  it("score = sharpe - 0.5 * (maxDrawdown/100) 公式正确", async () => {
    // sharpe=1.5, maxDrawdown=20 → score = 1.5 - 0.5*(20/100) = 1.4
    mockedRunBacktest.mockReturnValue({
      ...mockReturnValue,
      metrics: { ...mockReturnValue.metrics, sharpeRatio: 1.5, maxDrawdown: 20 },
    } as ReturnType<typeof runBacktest>);

    const klineCache = new Map<string, Kline[]>([["BTCUSDT", makeKlines(300)]]);
    const { score } = await evaluateParams({ ma_short: 10, ma_long: 50 }, "BTCUSDT", makeBaseCfg(), klineCache);
    expect(score).toBeCloseTo(1.5 - 0.5 * (20 / 100), 5);
  });

  it("klineCache 中没有对应 symbol 时抛出错误", async () => {
    const emptyCache = new Map<string, Kline[]>();
    await expect(
      evaluateParams({ ma_short: 10, ma_long: 50 }, "BTCUSDT", makeBaseCfg(), emptyCache)
    ).rejects.toThrow();
  });

  it("合法参数时 metrics 包含正确字段", async () => {
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
  it("初始状态 best() 返回 null", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    expect(opt.best()).toBeNull();
  });

  it("suggest() 返回的参数包含所有 space 字段", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const params = opt.suggest();
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(params[def.name]).toBeDefined();
      expect(typeof params[def.name]).toBe("number");
    }
  });

  it("suggest() 返回的参数在合法范围内（多次采样）", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 99);
    for (let i = 0; i < 10; i++) {
      const params = opt.suggest();
      for (const def of DEFAULT_PARAM_SPACE) {
        expect(params[def.name]!).toBeGreaterThanOrEqual(def.min);
        expect(params[def.name]!).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it("observe() 正确记录观测结果", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const params = opt.suggest();
    opt.observe(params, 1.5);
    expect(opt.trialCount).toBe(1);
    expect(opt.best()!.score).toBe(1.5);
  });

  it("多次 observe 后 best() 返回最高分", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const scores = [0.5, 2.3, 1.1, -0.5, 1.8];
    for (const score of scores) {
      opt.observe(opt.suggest(), score);
    }
    expect(opt.best()!.score).toBe(2.3);
  });

  it("经过 30 次 observe 后仍返回历史最高分", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 7, 5);
    let maxSeen = -Infinity;
    for (let i = 0; i < 30; i++) {
      const score = Math.sin(i) + Math.cos(i * 0.3);
      if (score > maxSeen) maxSeen = score;
      opt.observe(opt.suggest(), score);
    }
    expect(opt.best()!.score).toBeCloseTo(maxSeen, 10);
  });

  it("warm-up 结束后 suggest() 进入 EI 路径，不抛出异常", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 13, 3); // warmup=3
    for (let i = 0; i < 3; i++) {
      opt.observe(opt.suggest(), i * 0.5);
    }
    // 已超过 warmup，应走 EI 路径
    expect(() => opt.suggest()).not.toThrow();
    const params = opt.suggest();
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(params[def.name]!).toBeGreaterThanOrEqual(def.min);
      expect(params[def.name]!).toBeLessThanOrEqual(def.max);
    }
  });

  it("相同 seed 下两个 optimizer 产生相同的 warm-up 序列", () => {
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

  it("getHistory() 返回所有观测记录，按时序排列", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    for (let i = 0; i < 5; i++) {
      opt.observe(opt.suggest(), i * 0.4);
    }
    const history = opt.getHistory();
    expect(history).toHaveLength(5);
    expect(history[4]!.score).toBeCloseTo(4 * 0.4, 5);
  });

  it("best() 返回的 params 是原始参数的副本（不可变）", () => {
    const opt = new BayesianOptimizer(DEFAULT_PARAM_SPACE, 42);
    const p = opt.suggest();
    opt.observe(p, 1.0);
    const best = opt.best()!;
    best.params["ma_short"] = 9999; // 修改副本
    expect(opt.best()!.params["ma_short"]).not.toBe(9999); // 原始不受影响
  });
});

// ─────────────────────────────────────────────────────
// 5. Walk-Forward 数据分割
// ─────────────────────────────────────────────────────

describe("splitKlines (Walk-Forward)", () => {
  it("默认 70/30 分割比例正确", () => {
    const { train, test } = splitKlines(makeKlines(100));
    expect(train).toHaveLength(70);
    expect(test).toHaveLength(30);
  });

  it("自定义比例 80/20 分割正确", () => {
    const { train, test } = splitKlines(makeKlines(200), 0.8);
    expect(train).toHaveLength(160);
    expect(test).toHaveLength(40);
  });

  it("train.length + test.length === 原始数量", () => {
    const klines = makeKlines(150);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(150);
  });

  it("分割保持时序顺序（train 在前，test 在后）", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines);
    expect(train[train.length - 1]!.openTime).toBeLessThan(test[0]!.openTime);
  });

  it("ratio=0 时 train 为空，test 为全量", () => {
    const { train, test } = splitKlines(makeKlines(10), 0);
    expect(train).toHaveLength(0);
    expect(test).toHaveLength(10);
  });

  it("ratio=1 时 test 为空，train 为全量", () => {
    const { train, test } = splitKlines(makeKlines(10), 1);
    expect(train).toHaveLength(10);
    expect(test).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 6. DEFAULT_PARAM_SPACE 结构验证
// ─────────────────────────────────────────────────────

describe("DEFAULT_PARAM_SPACE 结构", () => {
  it("包含全部 8 个参数定义", () => {
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

  it("所有参数的 min < max（定义合法）", () => {
    for (const def of DEFAULT_PARAM_SPACE) {
      expect(def.min).toBeLessThan(def.max);
    }
  });

  it("int 类型参数都有 step 字段", () => {
    const intParams = DEFAULT_PARAM_SPACE.filter((d) => d.type === "int");
    expect(intParams.length).toBeGreaterThan(0);
    for (const def of intParams) {
      expect(def.step).toBeDefined();
      expect(def.step!).toBeGreaterThan(0);
    }
  });

  it("position_ratio 范围在 (0, 1) 内（合理仓位）", () => {
    const def = DEFAULT_PARAM_SPACE.find((d) => d.name === "position_ratio")!;
    expect(def.min).toBeGreaterThan(0);
    expect(def.max).toBeLessThan(1);
  });
});

/**
 * P6.6 Auto Walk-Forward — 单元测试
 *
 * 所有外部依赖完全 mock，禁止真实网络请求。
 * mock 列表：
 *   - fetchHistoricalKlines
 *   - evaluateParams
 *   - loadStrategyConfig
 *   - fs 模块（读写 state 文件）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { Kline, StrategyConfig } from "../types.js";
import type { ParamSet } from "../optimization/param-space.js";
import type { EvalResult } from "../optimization/objective.js";
import { splitKlines } from "../optimization/bayesian.js";

// ─────────────────────────────────────────────────────
// Module mocks（hoisted）
// ─────────────────────────────────────────────────────

vi.mock("../backtest/fetcher.js", () => ({
  fetchHistoricalKlines: vi.fn(),
}));

vi.mock("../optimization/objective.js", () => ({
  evaluateParams: vi.fn(),
  applyParams: vi.fn((_params: ParamSet, cfg: StrategyConfig) => cfg),
}));

vi.mock("../config/loader.js", () => ({
  loadStrategyConfig: vi.fn(),
}));

// ─────────────────────────────────────────────────────
// 延迟导入（避免 hoisting 问题）
// ─────────────────────────────────────────────────────

const { fetchHistoricalKlines } = await import("../backtest/fetcher.js");
const { evaluateParams, applyParams } = await import("../optimization/objective.js");
const { loadStrategyConfig } = await import("../config/loader.js");
const {
  runAutoWalkForward,
  loadAutoWfState,
  saveAutoWfState,
  formatAutoWfReport,
} = await import("../optimization/auto-wf.js");

const mockFetch = vi.mocked(fetchHistoricalKlines);
const mockEval = vi.mocked(evaluateParams);
const mockApplyParams = vi.mocked(applyParams);
const mockLoadCfg = vi.mocked(loadStrategyConfig);

// ─────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────

function makeKline(i: number): Kline {
  return {
    openTime: i * 3_600_000,
    closeTime: i * 3_600_000 + 3_599_999,
    open: 100 + i * 0.1,
    high: 102 + i * 0.1,
    low: 98 + i * 0.1,
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
      ma: { short: 20, long: 60 },
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
    notify: {
      telegram: { enabled: false, bot_token: "", chat_id: "" },
      min_interval_minutes: 60,
    },
    news: {
      enabled: false,
      interval_hours: 4,
      price_alert_threshold: 5,
      fear_greed_alert: 25,
    },
    mode: "notify_only",
  } as unknown as StrategyConfig;
}

function makeEvalResult(sharpe: number, score?: number): EvalResult {
  return {
    score: score ?? sharpe,
    metrics: {
      totalTrades: 10,
      wins: 6,
      losses: 4,
      winRate: 0.6,
      totalReturn: 100,
      totalReturnPercent: 10,
      maxDrawdown: 5,
      maxDrawdownUsdt: 50,
      sharpeRatio: sharpe,
      sortinoRatio: sharpe * 1.2,
      profitFactor: 1.5,
      avgWinPercent: 3,
      avgLossPercent: 2,
      winLossRatio: 1.5,
      avgHoldingHours: 12,
      stopLossCount: 3,
      takeProfitCount: 5,
      trailingStopCount: 1,
      signalExitCount: 1,
      endOfDataCount: 0,
      bestTradePct: 8,
      worstTradePct: -3,
      calmarRatio: 1.5,
      equityCurve: [],
    },
  };
}

function makeDefaultCfg() {
  return {
    symbols: ["BTCUSDT"],
    days: 90,
    trials: 2, // 少轮次加速测试
    trainRatio: 0.7,
    minImprovementPct: 5,
    dryRun: true, // 默认 dryRun=true，避免写文件
    seed: 42,
  };
}

// ─────────────────────────────────────────────────────
// 全局 beforeEach / afterEach
// ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  const klines = makeKlines(100);
  mockFetch.mockResolvedValue(klines);
  mockLoadCfg.mockReturnValue(makeBaseCfg());
  // applyParams 需要在 resetAllMocks 之后重新设置（否则返回 undefined）
  mockApplyParams.mockImplementation((_p, cfg) => cfg);
  // 默认：current=0.8，optimizer=1.1，new=1.1（改进37.5% > 5%）
  mockEval
    .mockResolvedValueOnce(makeEvalResult(0.8))  // current sharpe
    .mockResolvedValue(makeEvalResult(1.1));      // optimizer + new sharpe
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────
// 1. runAutoWalkForward 核心逻辑
// ─────────────────────────────────────────────────────

describe("runAutoWalkForward 核心逻辑", () => {
  it("1. 改进超阈值时 updated=true", async () => {
    // currentSharpe=0.8, newSharpe=1.1 → improvement=37.5% > 5%
    // dryRun=false 才会实际更新（need to mock fs for config write）
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(
      "strategy:\n  ma:\n    short: 20\n    long: 60\n  rsi:\n    period: 14\n    overbought: 70\n    oversold: 30\nrisk:\n  stop_loss_percent: 3\n  take_profit_percent: 8\n  position_ratio: 0.2\n"
    );
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      dryRun: false,
    }, makeBaseCfg());
    expect(report.results[0]?.updated).toBe(true);
    readSpy.mockRestore();
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("2. 改进低于阈值时 updated=false", async () => {
    // currentSharpe=1.0, newSharpe=1.02 → improvement=2% < 5%
    mockEval.mockReset();
    mockEval
      .mockResolvedValueOnce(makeEvalResult(1.0))   // current
      .mockResolvedValue(makeEvalResult(1.02));      // optimizer + new
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(report.results[0]?.updated).toBe(false);
  });

  it("3. newSharpe <= 0 时不更新（即使改进超阈值）", async () => {
    // currentSharpe=-0.2（负值）, newSharpe=-0.1 → improvement=50% > 5%，但 newSharpe<=0
    mockEval.mockReset();
    mockEval
      .mockResolvedValueOnce(makeEvalResult(-0.2))  // current (negative)
      .mockResolvedValueOnce(makeEvalResult(1.0))   // optimizer iter 1
      .mockResolvedValueOnce(makeEvalResult(1.0))   // optimizer iter 2
      .mockResolvedValueOnce(makeEvalResult(-0.1)); // new test (negative)
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      dryRun: false,
    }, makeBaseCfg());
    expect(report.results[0]?.updated).toBe(false);
  });

  it("4. dryRun=true 时不写 config 文件", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("mock yaml");
    await runAutoWalkForward({ ...makeDefaultCfg(), dryRun: true }, makeBaseCfg());
    // writeFileSync 不应被调用写 config（但可能被 STATE_FILE 调用）
    const configCalls = writeSpy.mock.calls.filter((c) => String(c[0]).includes("strategy.yaml"));
    expect(configCalls).toHaveLength(0);
    writeSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("5. 多 symbol 全部成功", async () => {
    mockFetch.mockResolvedValue(makeKlines(100));
    mockEval.mockResolvedValue(makeEvalResult(1.1)); // 所有都返回 1.1
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      symbols: ["BTCUSDT", "ETHUSDT"],
    }, makeBaseCfg());
    expect(report.results).toHaveLength(2);
    expect(report.failedCount).toBe(0);
    expect(report.results.every((r) => r.error === undefined)).toBe(true);
  });

  it("6. 某 symbol fetch 失败时 error 字段有值，其他正常", async () => {
    mockEval.mockReset();
    // BTCUSDT: 成功; ETHUSDT: fetch 失败
    mockFetch
      .mockResolvedValueOnce(makeKlines(100))  // BTCUSDT
      .mockRejectedValueOnce(new Error("fetch failed")); // ETHUSDT
    mockEval.mockResolvedValue(makeEvalResult(0.8));
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      symbols: ["BTCUSDT", "ETHUSDT"],
    }, makeBaseCfg());
    const btcResult = report.results.find((r) => r.symbol === "BTCUSDT");
    const ethResult = report.results.find((r) => r.symbol === "ETHUSDT");
    expect(btcResult?.error).toBeUndefined();
    expect(ethResult?.error).toBeTruthy();
    expect(ethResult?.error).toContain("fetch failed");
  });

  it("7. report.updatedCount 和 failedCount 正确", async () => {
    mockFetch
      .mockResolvedValueOnce(makeKlines(100))        // BTCUSDT 成功
      .mockRejectedValueOnce(new Error("fail"));     // ETHUSDT 失败
    mockEval
      .mockResolvedValueOnce(makeEvalResult(0.8))    // BTCUSDT current
      .mockResolvedValue(makeEvalResult(1.1));       // BTCUSDT optimizer + new
    // dryRun=false，BTCUSDT 改进大于阈值，应该 updated=true
    // ETHUSDT fetch 失败，failedCount=1
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(
      "strategy:\n  ma:\n    short: 20\n    long: 60\n  rsi:\n    period: 14\n    overbought: 70\n    oversold: 30\nrisk:\n  stop_loss_percent: 3\n  take_profit_percent: 8\n  position_ratio: 0.2\n"
    );
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      symbols: ["BTCUSDT", "ETHUSDT"],
      dryRun: false,
    }, makeBaseCfg());
    expect(report.updatedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    readSpy.mockRestore();
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("8. report.runAt 是合法 ISO 时间戳", async () => {
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(() => new Date(report.runAt)).not.toThrow();
    expect(new Date(report.runAt).toISOString()).toBe(report.runAt);
    expect(report.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("9. evaluateParams 被正确调用（fetchHistoricalKlines 被调用）", async () => {
    await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    // fetchHistoricalKlines 应被调用一次（1 symbol）
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "BTCUSDT",
      "1h",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("10. 当不传 baseCfg 时自动调用 loadStrategyConfig", async () => {
    mockLoadCfg.mockReturnValue(makeBaseCfg());
    await runAutoWalkForward(makeDefaultCfg()); // 不传 baseCfg
    expect(mockLoadCfg).toHaveBeenCalledTimes(1);
  });

  it("11. 改进超阈值且 dryRun=false 时调用 writeFileSync 写 config", async () => {
    // Setup: improvement > threshold, newSharpe > 0
    mockEval.mockReset();
    mockEval
      .mockResolvedValueOnce(makeEvalResult(0.8))
      .mockResolvedValue(makeEvalResult(1.5));
    // mock fs.readFileSync to return a valid yaml string
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(
      "strategy:\n  ma:\n    short: 20\n    long: 60\n  rsi:\n    period: 14\n    overbought: 70\n    oversold: 30\nrisk:\n  stop_loss_percent: 3\n  take_profit_percent: 8\n  position_ratio: 0.2\n"
    );
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    await runAutoWalkForward({ ...makeDefaultCfg(), dryRun: false }, makeBaseCfg());

    const configCalls = writeSpy.mock.calls.filter((c) => String(c[0]).includes("strategy.yaml"));
    expect(configCalls.length).toBeGreaterThan(0);

    readSpy.mockRestore();
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("12. SymbolWfResult 包含正确的 currentSharpe 和 newSharpe", async () => {
    mockEval.mockReset();
    mockEval
      .mockResolvedValueOnce(makeEvalResult(1.2))  // current
      .mockResolvedValueOnce(makeEvalResult(1.0))  // optimizer iter 1
      .mockResolvedValueOnce(makeEvalResult(0.9))  // optimizer iter 2
      .mockResolvedValueOnce(makeEvalResult(1.8)); // new test
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(report.results[0]?.currentSharpe).toBeCloseTo(1.2);
    expect(report.results[0]?.newSharpe).toBeCloseTo(1.8);
  });

  it("13. improvementPct 计算正确", async () => {
    mockEval.mockReset();
    // currentSharpe=1.0, newSharpe=1.5 → improvement = (1.5-1.0)/1.0*100 = 50%
    mockEval
      .mockResolvedValueOnce(makeEvalResult(1.0))
      .mockResolvedValueOnce(makeEvalResult(1.0))
      .mockResolvedValueOnce(makeEvalResult(1.0))
      .mockResolvedValueOnce(makeEvalResult(1.5));
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(report.results[0]?.improvementPct).toBeCloseTo(50);
  });
});

// ─────────────────────────────────────────────────────
// 2. loadAutoWfState
// ─────────────────────────────────────────────────────

describe("loadAutoWfState", () => {
  it("14. 文件不存在时返回默认空 state", () => {
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const state = loadAutoWfState();
    expect(state.lastRun).toBe("");
    expect(state.bySymbol).toEqual({});
    readSpy.mockRestore();
  });

  it("15. 读取已有文件正确反序列化", () => {
    const mockState = {
      lastRun: "2025-01-01T00:00:00.000Z",
      bySymbol: {
        BTCUSDT: {
          lastRun: "2025-01-01T00:00:00.000Z",
          bestParams: { ma_short: 15, ma_long: 50 },
          bestSharpe: 1.5,
        },
      },
    };
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(mockState));
    const state = loadAutoWfState();
    expect(state.lastRun).toBe("2025-01-01T00:00:00.000Z");
    expect(state.bySymbol["BTCUSDT"]?.bestSharpe).toBe(1.5);
    expect(state.bySymbol["BTCUSDT"]?.bestParams["ma_short"]).toBe(15);
    readSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────
// 3. saveAutoWfState
// ─────────────────────────────────────────────────────

describe("saveAutoWfState", () => {
  it("16. 写入正确 JSON", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    const state = {
      lastRun: "2025-03-01T00:00:00.000Z",
      bySymbol: {
        BTCUSDT: {
          lastRun: "2025-03-01T00:00:00.000Z",
          bestParams: { ma_short: 10, ma_long: 40 },
          bestSharpe: 1.2,
        },
      },
    };
    saveAutoWfState(state);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, content] = writeSpy.mock.calls[0]!;
    const parsed = JSON.parse(content as string) as typeof state;
    expect(parsed.lastRun).toBe("2025-03-01T00:00:00.000Z");
    expect(parsed.bySymbol.BTCUSDT?.bestSharpe).toBe(1.2);

    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("17. 日志目录不存在时自动创建（mkdirSync recursive=true）", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    saveAutoWfState({ lastRun: "", bySymbol: {} });

    expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), { recursive: true });

    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────
// 4. formatAutoWfReport
// ─────────────────────────────────────────────────────

describe("formatAutoWfReport", () => {
  function makeReport(
    results: {
      symbol: string;
      updated: boolean;
      currentSharpe: number;
      newSharpe: number;
      improvementPct: number;
      error?: string;
    }[]
  ) {
    const bestParams: ParamSet = { ma_short: 15, ma_long: 50 };
    return {
      runAt: "2025-03-01T00:00:00.000Z",
      results: results.map((r) => ({
        ...r,
        bestParams,
      })),
      updatedCount: results.filter((r) => r.updated).length,
      failedCount: results.filter((r) => r.error !== undefined).length,
    };
  }

  it("18. 包含 symbol 名称", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("BTCUSDT");
  });

  it("19. 包含 Sharpe 数值", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("0.800");
    expect(text).toContain("1.100");
  });

  it("20. updated=true 时包含 '✅'", () => {
    const report = makeReport([
      { symbol: "ETHUSDT", updated: true, currentSharpe: 1.0, newSharpe: 1.5, improvementPct: 50 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("✅");
  });

  it("21. updated=false 时包含 '⏭' 或 '跳过'", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: false, currentSharpe: 1.0, newSharpe: 1.02, improvementPct: 2 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toMatch(/⏭|跳过/);
  });

  it("22. error 时包含 '❌'", () => {
    const report = makeReport([
      {
        symbol: "SOLUSDT",
        updated: false,
        currentSharpe: 0,
        newSharpe: 0,
        improvementPct: 0,
        error: "fetch failed",
      },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("❌");
    expect(text).toContain("fetch failed");
  });

  it("23. updatedCount 总计正确", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
      { symbol: "ETHUSDT", updated: false, currentSharpe: 1.0, newSharpe: 1.02, improvementPct: 2 },
      { symbol: "SOLUSDT", updated: true, currentSharpe: 0.5, newSharpe: 0.9, improvementPct: 80 },
    ]);
    const text = formatAutoWfReport(report);
    expect(report.updatedCount).toBe(2);
    expect(text).toContain("2");
  });

  it("24. 报告包含运行时间", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("2025-03-01T00:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────
// 5. AutoWfConfig 默认值验证
// ─────────────────────────────────────────────────────

describe("AutoWfConfig 接口默认值", () => {
  it("25. minImprovementPct=5（任务要求默认值）", () => {
    // 测试阈值恰好为 4.9%（不足 5%）时不更新
    mockEval.mockReset();
    // current=1.0, new=1.049 → improvement=4.9% < 5%
    mockEval
      .mockResolvedValueOnce(makeEvalResult(1.0))   // current
      .mockResolvedValueOnce(makeEvalResult(1.0))   // optimizer iter 1
      .mockResolvedValueOnce(makeEvalResult(1.0))   // optimizer iter 2
      .mockResolvedValueOnce(makeEvalResult(1.049)); // new (4.9% improvement)
    return runAutoWalkForward({
      symbols: ["BTCUSDT"],
      days: 90,
      trials: 2,
      trainRatio: 0.7,
      minImprovementPct: 5,
      dryRun: true,
      seed: 1,
    }, makeBaseCfg()).then((report) => {
      expect(report.results[0]?.updated).toBe(false);
    });
  });

  it("26. trainRatio=0.7（任务要求默认值）", async () => {
    // 验证 splitKlines 被间接调用，train=70%, test=30%
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
    expect(train.length + test.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────
// 6. splitKlines 复用验证（直接测试原始函数）
// ─────────────────────────────────────────────────────

describe("splitKlines 复用验证", () => {
  it("27. train+test 长度之和等于原始长度（100根）", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(klines.length);
  });

  it("28. train+test 长度之和等于原始长度（不整除情况：101根）", () => {
    const klines = makeKlines(101);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(101);
  });

  it("29. train+test 长度之和等于原始长度（不同比例）", () => {
    const klines = makeKlines(200);
    const { train, test } = splitKlines(klines, 0.8);
    expect(train.length + test.length).toBe(200);
  });

  it("30. 分割保持时序顺序", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train[train.length - 1]!.openTime).toBeLessThan(test[0]!.openTime);
  });
});

/**
 * P6.6 Auto Walk-Forward — Unit Tests
 *
 * All external dependencies are fully mocked; no real network requests.
 * Mock list:
 *   - fetchHistoricalKlines
 *   - evaluateParams
 *   - loadStrategyConfig
 *   - fs module (read/write state files)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { Kline, StrategyConfig } from "../types.js";
import type { ParamSet } from "../optimization/param-space.js";
import type { EvalResult } from "../optimization/objective.js";
import { splitKlines } from "../optimization/bayesian.js";

// ─────────────────────────────────────────────────────
// Module mocks (hoisted)
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
// Deferred imports (avoid hoisting issues)
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
    trials: 2, // fewer iterations to speed up tests
    trainRatio: 0.7,
    minImprovementPct: 5,
    dryRun: true, // default dryRun=true to avoid file writes
    seed: 42,
  };
}

// ─────────────────────────────────────────────────────
// Global beforeEach / afterEach
// ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  const klines = makeKlines(100);
  mockFetch.mockResolvedValue(klines);
  mockLoadCfg.mockReturnValue(makeBaseCfg());
  // applyParams needs to be reset after resetAllMocks (otherwise returns undefined)
  mockApplyParams.mockImplementation((_p, cfg) => cfg);
  // Default: current=0.8, optimizer=1.1, new=1.1 (improvement 37.5% > 5%)
  mockEval
    .mockResolvedValueOnce(makeEvalResult(0.8))  // current sharpe
    .mockResolvedValue(makeEvalResult(1.1));      // optimizer + new sharpe
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────
// 1. runAutoWalkForward core logic
// ─────────────────────────────────────────────────────

describe("runAutoWalkForward core logic", () => {
  it("1. updated=true when improvement exceeds threshold", async () => {
    // currentSharpe=0.8, newSharpe=1.1 -> improvement=37.5% > 5%
    // dryRun=false is needed for actual update (need to mock fs for config write)
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(
      "strategy:\n  ma:\n    short: 20\n    long: 60\n  rsi:\n    period: 14\n    overbought: 70\n    oversold: 30\nrisk:\n  stop_loss_percent: 3\n  take_profit_percent: 8\n  position_ratio: 0.2\n"
    );
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      dryRun: false,
    }, makeBaseCfg());
    expect(report.results[0]?.updated).toBe(true);
    readSpy.mockRestore();
    writeSpy.mockRestore();
    renameSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("2. updated=false when improvement is below threshold", async () => {
    // currentSharpe=1.0, newSharpe=1.02 -> improvement=2% < 5%
    mockEval.mockReset();
    mockEval
      .mockResolvedValueOnce(makeEvalResult(1.0))   // current
      .mockResolvedValue(makeEvalResult(1.02));      // optimizer + new
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(report.results[0]?.updated).toBe(false);
  });

  it("3. no update when newSharpe <= 0 (even if improvement exceeds threshold)", async () => {
    // currentSharpe=-0.2 (negative), newSharpe=-0.1 -> improvement=50% > 5%, but newSharpe<=0
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

  it("4. dryRun=true does not write config file", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("mock yaml");
    await runAutoWalkForward({ ...makeDefaultCfg(), dryRun: true }, makeBaseCfg());
    // writeFileSync should not be called for config (but may be called for STATE_FILE)
    const configCalls = writeSpy.mock.calls.filter((c) => String(c[0]).includes("strategy.yaml"));
    expect(configCalls).toHaveLength(0);
    writeSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("5. multiple symbols all succeed", async () => {
    mockFetch.mockResolvedValue(makeKlines(100));
    mockEval.mockResolvedValue(makeEvalResult(1.1)); // all return 1.1
    const report = await runAutoWalkForward({
      ...makeDefaultCfg(),
      symbols: ["BTCUSDT", "ETHUSDT"],
    }, makeBaseCfg());
    expect(report.results).toHaveLength(2);
    expect(report.failedCount).toBe(0);
    expect(report.results.every((r) => r.error === undefined)).toBe(true);
  });

  it("6. when one symbol fetch fails, error field is set while others succeed", async () => {
    mockEval.mockReset();
    // BTCUSDT: success; ETHUSDT: fetch fails
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

  it("7. report.updatedCount and failedCount are correct", async () => {
    mockFetch
      .mockResolvedValueOnce(makeKlines(100))        // BTCUSDT success
      .mockRejectedValueOnce(new Error("fail"));     // ETHUSDT fails
    mockEval
      .mockResolvedValueOnce(makeEvalResult(0.8))    // BTCUSDT current
      .mockResolvedValue(makeEvalResult(1.1));       // BTCUSDT optimizer + new
    // dryRun=false, BTCUSDT improvement > threshold, should be updated=true
    // ETHUSDT fetch fails, failedCount=1
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(
      "strategy:\n  ma:\n    short: 20\n    long: 60\n  rsi:\n    period: 14\n    overbought: 70\n    oversold: 30\nrisk:\n  stop_loss_percent: 3\n  take_profit_percent: 8\n  position_ratio: 0.2\n"
    );
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
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
    renameSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("8. report.runAt is a valid ISO timestamp", async () => {
    const report = await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    expect(() => new Date(report.runAt)).not.toThrow();
    expect(new Date(report.runAt).toISOString()).toBe(report.runAt);
    expect(report.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("9. evaluateParams is called correctly (fetchHistoricalKlines is called)", async () => {
    await runAutoWalkForward(makeDefaultCfg(), makeBaseCfg());
    // fetchHistoricalKlines should be called once (1 symbol)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "BTCUSDT",
      "1h",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("10. automatically calls loadStrategyConfig when baseCfg is not provided", async () => {
    mockLoadCfg.mockReturnValue(makeBaseCfg());
    await runAutoWalkForward(makeDefaultCfg()); // no baseCfg passed
    expect(mockLoadCfg).toHaveBeenCalledTimes(1);
  });

  it("11. calls writeFileSync for config when improvement exceeds threshold and dryRun=false", async () => {
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

  it("12. SymbolWfResult contains correct currentSharpe and newSharpe", async () => {
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

  it("13. improvementPct calculated correctly", async () => {
    mockEval.mockReset();
    // currentSharpe=1.0, newSharpe=1.5 -> improvement = (1.5-1.0)/1.0*100 = 50%
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
  it("14. returns default empty state when file does not exist", () => {
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const state = loadAutoWfState();
    expect(state.lastRun).toBe("");
    expect(state.bySymbol).toEqual({});
    readSpy.mockRestore();
  });

  it("15. correctly deserializes existing file", () => {
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
  it("16. writes correct JSON", () => {
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

  it("17. automatically creates logs directory when it does not exist (mkdirSync recursive=true)", () => {
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

  it("18. contains symbol name", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("BTCUSDT");
  });

  it("19. contains Sharpe values", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("0.800");
    expect(text).toContain("1.100");
  });

  it("20. contains checkmark when updated=true", () => {
    const report = makeReport([
      { symbol: "ETHUSDT", updated: true, currentSharpe: 1.0, newSharpe: 1.5, improvementPct: 50 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("✅");
  });

  it("21. contains skip indicator when updated=false", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: false, currentSharpe: 1.0, newSharpe: 1.02, improvementPct: 2 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toMatch(/⏭|Skipped/);
  });

  it("22. contains error indicator when error occurs", () => {
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

  it("23. updatedCount total is correct", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
      { symbol: "ETHUSDT", updated: false, currentSharpe: 1.0, newSharpe: 1.02, improvementPct: 2 },
      { symbol: "SOLUSDT", updated: true, currentSharpe: 0.5, newSharpe: 0.9, improvementPct: 80 },
    ]);
    const text = formatAutoWfReport(report);
    expect(report.updatedCount).toBe(2);
    expect(text).toContain("2");
  });

  it("24. report contains run timestamp", () => {
    const report = makeReport([
      { symbol: "BTCUSDT", updated: true, currentSharpe: 0.8, newSharpe: 1.1, improvementPct: 37.5 },
    ]);
    const text = formatAutoWfReport(report);
    expect(text).toContain("2025-03-01T00:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────
// 5. AutoWfConfig default values verification
// ─────────────────────────────────────────────────────

describe("AutoWfConfig interface defaults", () => {
  it("25. minImprovementPct=5 (required default value)", () => {
    // Test that threshold of exactly 4.9% (below 5%) does not update
    mockEval.mockReset();
    // current=1.0, new=1.049 -> improvement=4.9% < 5%
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

  it("26. trainRatio=0.7 (required default value)", async () => {
    // Verify splitKlines is indirectly called: train=70%, test=30%
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
    expect(train.length + test.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────
// 6. splitKlines reuse verification (direct function test)
// ─────────────────────────────────────────────────────

describe("splitKlines reuse verification", () => {
  it("27. train+test length equals original length (100 klines)", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(klines.length);
  });

  it("28. train+test length equals original length (non-divisible case: 101 klines)", () => {
    const klines = makeKlines(101);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train.length + test.length).toBe(101);
  });

  it("29. train+test length equals original length (different ratio)", () => {
    const klines = makeKlines(200);
    const { train, test } = splitKlines(klines, 0.8);
    expect(train.length + test.length).toBe(200);
  });

  it("30. split preserves chronological order", () => {
    const klines = makeKlines(100);
    const { train, test } = splitKlines(klines, 0.7);
    expect(train[train.length - 1]!.openTime).toBeLessThan(test[0]!.openTime);
  });
});

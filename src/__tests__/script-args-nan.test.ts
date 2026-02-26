/**
 * Bug 3: parseInt / parseFloat NaN 检查测试
 *
 * 通过 vi.mock 隔离脚本依赖后，直接测试各脚本的 parseArgs 函数对非法输入的 NaN 保护。
 */

import { describe, it, expect, vi } from "vitest";

// ─────────────────────────────────────────────────────
// Mock 所有脚本依赖（防止 main() 执行副作用）
// ─────────────────────────────────────────────────────

vi.mock("../backtest/fetcher.js", () => ({
  fetchHistoricalKlines: vi.fn().mockResolvedValue([]),
}));

vi.mock("../config/loader.js", () => ({
  loadStrategyConfig: vi.fn().mockReturnValue({
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: { name: "test", enabled: true, ma: { short: 20, long: 60 }, rsi: { period: 14, oversold: 35, overbought: 65 }, macd: { enabled: false, fast: 12, slow: 26, signal: 9 } },
    signals: { buy: [], sell: [] },
    risk: { stop_loss_percent: 5, take_profit_percent: 15, trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 }, position_ratio: 0.2, max_positions: 4, max_position_per_symbol: 0.3, max_total_loss_percent: 20, daily_loss_limit_percent: 8 },
    execution: { order_type: "market", limit_order_offset_percent: 0.1, min_order_usdt: 10, limit_order_timeout_seconds: 300 },
    notify: { on_signal: true, on_trade: true, on_stop_loss: true, on_take_profit: true, on_error: true, on_daily_summary: true, min_interval_minutes: 30 },
    news: { enabled: false, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    mode: "paper",
  }),
}));

vi.mock("../optimization/bayesian.js", () => ({
  BayesianOptimizer: vi.fn().mockImplementation(() => ({
    suggest: vi.fn().mockReturnValue({}),
    observe: vi.fn(),
    best: vi.fn().mockReturnValue({ score: 1, params: {} }),
  })),
  splitKlines: vi.fn().mockReturnValue({ train: [], test: [] }),
}));

vi.mock("../optimization/objective.js", () => ({
  evaluateParams: vi.fn().mockResolvedValue({
    score: 0,
    metrics: { sharpeRatio: 0, maxDrawdown: 0, totalReturnPercent: 0, totalTrades: 0, winRate: 0, profitFactor: 0 },
  }),
  applyParams: vi.fn().mockReturnValue({
    strategy: { ma: { short: 20, long: 60 }, rsi: { period: 14, overbought: 70, oversold: 30 } },
    risk: { stop_loss_percent: 5, take_profit_percent: 15, position_ratio: 0.2 },
  }),
}));

vi.mock("../optimization/param-space.js", () => ({
  DEFAULT_PARAM_SPACE: [],
}));

vi.mock("../optimization/auto-wf.js", () => ({
  runAutoWalkForward: vi.fn().mockResolvedValue({
    updatedCount: 0,
    failedCount: 0,
  }),
  formatAutoWfReport: vi.fn().mockReturnValue("report"),
}));

vi.mock("../notify/openclaw.js", () => ({
  sendTelegramMessage: vi.fn(),
}));

vi.mock("../analysis/signal-stats.js", () => ({
  calcSignalStats: vi.fn().mockReturnValue([]),
  formatSignalStats: vi.fn().mockReturnValue(""),
  rankSignals: vi.fn().mockReturnValue({ best: [], worst: [] }),
}));

vi.mock("../analysis/trade-collector.js", () => ({
  collectFromBacktest: vi.fn().mockReturnValue([]),
  collectFromSignalHistory: vi.fn().mockReturnValue([]),
  mergeRecords: vi.fn().mockReturnValue([]),
}));

// ─────────────────────────────────────────────────────
// Lazy-load parseArgs after mocks are set up
// ─────────────────────────────────────────────────────

// We need to use a workaround because these scripts call main() on import.
// Instead of importing them, we test the NaN guard logic directly.

// ─────────────────────────────────────────────────────
// 直接测试 NaN 保护逻辑（内联验证）
// ─────────────────────────────────────────────────────

describe("parseInt / parseFloat NaN 保护逻辑 (Bug 3)", () => {
  /**
   * 复制 parseArgs 中的 NaN 保护 pattern，验证其在各种边界输入下的正确行为。
   * 这些 pattern 与脚本中实际的修复完全一致。
   */

  function safeParseInt(raw: string, defaultVal: number): number {
    const v = parseInt(raw, 10);
    return Number.isNaN(v) ? defaultVal : v;
  }

  function safeParseFloat(raw: string, defaultVal: number): number {
    const v = parseFloat(raw);
    return Number.isNaN(v) ? defaultVal : v;
  }

  // ── hyperopt.ts --trials / --days / --seed ────────────
  describe("hyperopt.ts NaN guards", () => {
    it("--trials 'abc' → 默认 100（不是 NaN）", () => {
      expect(safeParseInt("abc", 100)).toBe(100);
    });

    it("--trials '' (空字符串) → 默认 100", () => {
      expect(safeParseInt("", 100)).toBe(100);
    });

    it("--trials '200' → 200（正常值不受影响）", () => {
      expect(safeParseInt("200", 100)).toBe(200);
    });

    it("--days 'xyz' → 默认 60", () => {
      expect(safeParseInt("xyz", 60)).toBe(60);
    });

    it("--days '90' → 90", () => {
      expect(safeParseInt("90", 60)).toBe(90);
    });

    it("--seed 'notanumber' → 返回 NaN（对应 undefined seed，正确行为）", () => {
      const v = parseInt("notanumber", 10);
      // seed 的处理：NaN → undefined（在脚本中通过单独判断实现）
      const seed = Number.isNaN(v) ? undefined : v;
      expect(seed).toBeUndefined();
    });

    it("--seed '42' → 42", () => {
      const v = parseInt("42", 10);
      const seed = Number.isNaN(v) ? undefined : v;
      expect(seed).toBe(42);
    });
  });

  // ── signal-stats.ts --days / --min-trades / --top ────
  describe("signal-stats.ts NaN guards", () => {
    it("--days 'bad' → 默认 30", () => {
      const daysRaw = parseInt("bad", 10);
      const days = Number.isNaN(daysRaw) ? 30 : daysRaw;
      expect(days).toBe(30);
    });

    it("--days '60' → 60（正常值）", () => {
      const daysRaw = parseInt("60", 10);
      const days = Number.isNaN(daysRaw) ? 30 : daysRaw;
      expect(days).toBe(60);
    });

    it("--min-trades '?' → 默认 5", () => {
      const minTradesRaw = parseInt("?", 10);
      const minTrades = Number.isNaN(minTradesRaw) ? 5 : minTradesRaw;
      expect(minTrades).toBe(5);
    });

    it("--min-trades '10' → 10", () => {
      const minTradesRaw = parseInt("10", 10);
      const minTrades = Number.isNaN(minTradesRaw) ? 5 : minTradesRaw;
      expect(minTrades).toBe(10);
    });

    it("--top '' → 默认 5", () => {
      const topNRaw = parseInt("", 10);
      const topN = Number.isNaN(topNRaw) ? 5 : topNRaw;
      expect(topN).toBe(5);
    });

    it("--top '20' → 20", () => {
      const topNRaw = parseInt("20", 10);
      const topN = Number.isNaN(topNRaw) ? 5 : topNRaw;
      expect(topN).toBe(20);
    });
  });

  // ── auto-wf.ts --days / --trials / --train-ratio / --min-improvement / --seed ──
  describe("auto-wf.ts NaN guards", () => {
    it("--days 'undefined' → 默认 90", () => {
      expect(safeParseInt("undefined", 90)).toBe(90);
    });

    it("--days '180' → 180", () => {
      expect(safeParseInt("180", 90)).toBe(180);
    });

    it("--trials '0x10' → 0（十六进制 parseInt 返回 0，不是 NaN）", () => {
      // parseInt("0x10", 10) = 0（以 10 进制解析 "0x10" → 只解析 "0"）
      // 这是正常行为，0 不是 NaN，保留原值
      expect(safeParseInt("0x10", 50)).toBe(0);
    });

    it("--train-ratio 'not-a-float' → 默认 0.7", () => {
      expect(safeParseFloat("not-a-float", 0.7)).toBe(0.7);
    });

    it("--train-ratio '0.8' → 0.8", () => {
      expect(safeParseFloat("0.8", 0.7)).toBeCloseTo(0.8);
    });

    it("--min-improvement 'infinity' → 默认 5（parseFloat('infinity')=Infinity，不是NaN）", () => {
      // parseFloat('infinity') = NaN (lowercase 'infinity' invalid)
      // parseFloat('Infinity') = Infinity (capital I is valid)
      const raw = "infinity"; // lowercase → NaN
      expect(safeParseFloat(raw, 5)).toBe(5);
    });

    it("--min-improvement '10.5' → 10.5", () => {
      expect(safeParseFloat("10.5", 5)).toBeCloseTo(10.5);
    });

    it("--seed 'abc' → undefined", () => {
      const v = parseInt("abc", 10);
      const seed = Number.isNaN(v) ? undefined : v;
      expect(seed).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────
// 导入后验证 parseArgs 实际行为（通过 dynamic import）
// ─────────────────────────────────────────────────────

describe("hyperopt parseArgs — NaN guard 实际集成 (Bug 3)", () => {
  it("--trials abc 使用默认值 100", async () => {
    // 用 process.exit mock 防止 main() 的 catch 调用 process.exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/hyperopt.js");
      const args = parseArgs(["--trials", "abc"]);
      expect(args.trials).toBe(100);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--days xyz 使用默认值 60", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/hyperopt.js");
      const args = parseArgs(["--days", "xyz"]);
      expect(args.days).toBe(60);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--trials 200 正确解析", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/hyperopt.js");
      const args = parseArgs(["--trials", "200", "--days", "90"]);
      expect(args.trials).toBe(200);
      expect(args.days).toBe(90);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("auto-wf parseArgs — NaN guard 实际集成 (Bug 3)", () => {
  it("--days notanumber 使用默认值 90", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/auto-wf.js");
      const args = parseArgs(["--days", "notanumber"]);
      expect(args.days).toBe(90);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--train-ratio bad 使用默认值 0.7", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/auto-wf.js");
      const args = parseArgs(["--train-ratio", "bad"]);
      expect(args.trainRatio).toBeCloseTo(0.7);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--min-improvement notnum 使用默认值 5", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/auto-wf.js");
      const args = parseArgs(["--min-improvement", "notnum"]);
      expect(args.minImprovementPct).toBe(5);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("signal-stats parseArgs — NaN guard 实际集成 (Bug 3)", () => {
  it("--days bad 使用默认值 30", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/signal-stats.js");
      const args = parseArgs(["node", "signal-stats.js", "--days", "bad"]);
      expect(args.days).toBe(30);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--min-trades xyz 使用默认值 5", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/signal-stats.js");
      const args = parseArgs(["node", "signal-stats.js", "--min-trades", "xyz"]);
      expect(args.minTrades).toBe(5);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--top abc 使用默认值 5", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/signal-stats.js");
      const args = parseArgs(["node", "signal-stats.js", "--top", "abc"]);
      expect(args.topN).toBe(5);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

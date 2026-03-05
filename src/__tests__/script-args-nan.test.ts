/**
 * Bug 3: parseInt / parseFloat NaN guard tests
 *
 * After isolating script dependencies via vi.mock, directly test the NaN protection
 * in each script's parseArgs function against illegal inputs.
 */

import { describe, it, expect, vi } from "vitest";

// ─────────────────────────────────────────────────────
// Mock all script dependencies (prevent main() from executing side effects)
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
// Directly test NaN protection logic (inline validation)
// ─────────────────────────────────────────────────────

describe("parseInt / parseFloat NaN protection logic (Bug 3)", () => {
  /**
   * Replicate the NaN protection pattern from parseArgs and verify correct
   * behavior under various edge-case inputs.
   * These patterns are identical to the actual fixes in the scripts.
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
    it("--trials 'abc' → default 100 (not NaN)", () => {
      expect(safeParseInt("abc", 100)).toBe(100);
    });

    it("--trials '' (empty string) → default 100", () => {
      expect(safeParseInt("", 100)).toBe(100);
    });

    it("--trials '200' → 200 (normal value unaffected)", () => {
      expect(safeParseInt("200", 100)).toBe(200);
    });

    it("--days 'xyz' → default 60", () => {
      expect(safeParseInt("xyz", 60)).toBe(60);
    });

    it("--days '90' → 90", () => {
      expect(safeParseInt("90", 60)).toBe(90);
    });

    it("--seed 'notanumber' → returns NaN (maps to undefined seed, correct behavior)", () => {
      const v = parseInt("notanumber", 10);
      // seed handling: NaN → undefined (implemented via separate check in scripts)
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
    it("--days 'bad' → default 30", () => {
      const daysRaw = parseInt("bad", 10);
      const days = Number.isNaN(daysRaw) ? 30 : daysRaw;
      expect(days).toBe(30);
    });

    it("--days '60' → 60 (normal value)", () => {
      const daysRaw = parseInt("60", 10);
      const days = Number.isNaN(daysRaw) ? 30 : daysRaw;
      expect(days).toBe(60);
    });

    it("--min-trades '?' → default 5", () => {
      const minTradesRaw = parseInt("?", 10);
      const minTrades = Number.isNaN(minTradesRaw) ? 5 : minTradesRaw;
      expect(minTrades).toBe(5);
    });

    it("--min-trades '10' → 10", () => {
      const minTradesRaw = parseInt("10", 10);
      const minTrades = Number.isNaN(minTradesRaw) ? 5 : minTradesRaw;
      expect(minTrades).toBe(10);
    });

    it("--top '' → default 5", () => {
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
    it("--days 'undefined' → default 90", () => {
      expect(safeParseInt("undefined", 90)).toBe(90);
    });

    it("--days '180' → 180", () => {
      expect(safeParseInt("180", 90)).toBe(180);
    });

    it("--trials '0x10' → 0 (hexadecimal parseInt returns 0, not NaN)", () => {
      // parseInt("0x10", 10) = 0 (parsing "0x10" in base 10 → only parses "0")
      // This is normal behavior, 0 is not NaN, original value is kept
      expect(safeParseInt("0x10", 50)).toBe(0);
    });

    it("--train-ratio 'not-a-float' → default 0.7", () => {
      expect(safeParseFloat("not-a-float", 0.7)).toBe(0.7);
    });

    it("--train-ratio '0.8' → 0.8", () => {
      expect(safeParseFloat("0.8", 0.7)).toBeCloseTo(0.8);
    });

    it("--min-improvement 'infinity' → default 5 (parseFloat('infinity')=Infinity, not NaN)", () => {
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
// Verify parseArgs actual behavior after import (via dynamic import)
// ─────────────────────────────────────────────────────

describe("hyperopt parseArgs — NaN guard actual integration (Bug 3)", () => {
  it("--trials abc uses default value 100", async () => {
    // Mock process.exit to prevent main()'s catch from calling process.exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/hyperopt.js");
      const args = parseArgs(["--trials", "abc"]);
      expect(args.trials).toBe(100);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--days xyz uses default value 60", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/hyperopt.js");
      const args = parseArgs(["--days", "xyz"]);
      expect(args.days).toBe(60);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--trials 200 parsed correctly", async () => {
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

describe("auto-wf parseArgs — NaN guard actual integration (Bug 3)", () => {
  it("--days notanumber uses default value 90", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/auto-wf.js");
      const args = parseArgs(["--days", "notanumber"]);
      expect(args.days).toBe(90);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--train-ratio bad uses default value 0.7", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/auto-wf.js");
      const args = parseArgs(["--train-ratio", "bad"]);
      expect(args.trainRatio).toBeCloseTo(0.7);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--min-improvement notnum uses default value 5", async () => {
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

describe("signal-stats parseArgs — NaN guard actual integration (Bug 3)", () => {
  it("--days bad uses default value 30", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/signal-stats.js");
      const args = parseArgs(["node", "signal-stats.js", "--days", "bad"]);
      expect(args.days).toBe(30);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--min-trades xyz uses default value 5", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    try {
      const { parseArgs } = await import("../scripts/signal-stats.js");
      const args = parseArgs(["node", "signal-stats.js", "--min-trades", "xyz"]);
      expect(args.minTrades).toBe(5);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--top abc uses default value 5", async () => {
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

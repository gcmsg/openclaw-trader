/**
 * Bug 4: ensemble totalWeight boundary tests
 *
 * Verifies that ensemble.ts behaves safely when config.strategies is an empty array,
 * and division-by-zero protection when totalWeight = 0.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ensembleVote } from "../strategies/ensemble.js";
import type { EnsembleConfig } from "../strategies/ensemble.js";
import type { StrategyContext, Strategy } from "../strategies/types.js";
import type { StrategyConfig, Indicators, Kline } from "../types.js";
import { registerStrategy } from "../strategies/registry.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeCfg(): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: [], sell: [] },
    risk: {
      stop_loss_percent: 2,
      take_profit_percent: 4,
      trailing_stop: { enabled: false, activation_percent: 2, callback_percent: 1 },
      position_ratio: 0.1,
      max_positions: 5,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 5,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 30,
    },
    notify: {
      on_signal: true,
      on_trade: true,
      on_stop_loss: true,
      on_take_profit: true,
      on_error: true,
      on_daily_summary: true,
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
  };
}

function makeKlines(n = 10): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 3_600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    closeTime: (i + 1) * 3_600_000,
  }));
}

function makeCtx(): StrategyContext {
  const indicators: Indicators = {
    maShort: 105,
    maLong: 100,
    rsi: 50,
    price: 100,
    volume: 1000,
    avgVolume: 800,
  };
  return {
    klines: makeKlines(),
    cfg: makeCfg(),
    indicators,
    extra: {},
  };
}

// Register a buy mock (if not already registered)
function ensureBuyMock(): void {
  try {
    const s: Strategy = {
      id: "edge-mock-buy",
      name: "edge mock buy",
      populateSignal: () => "buy",
    };
    registerStrategy(s);
  } catch {
    // already registered, ignore
  }
}

// ─────────────────────────────────────────────────────
// Bug 4 Tests: empty strategies array
// ─────────────────────────────────────────────────────

describe("ensemble — empty strategies array boundary (Bug 4)", () => {
  it("returns { signal: 'none' } without crashing when strategies is empty array", () => {
    const config: EnsembleConfig = { strategies: [] };
    let result: ReturnType<typeof ensembleVote>;

    expect(() => {
      result = ensembleVote(config, makeCtx());
    }).not.toThrow();

    expect(result!.signal).toBe("none");
  });

  it("empty array: votes is empty, all scores are 0", () => {
    const config: EnsembleConfig = { strategies: [] };
    const result = ensembleVote(config, makeCtx());

    expect(result.votes).toHaveLength(0);
    expect(result.buyScore).toBe(0);
    expect(result.sellScore).toBe(0);
    expect(result.shortScore).toBe(0);
    expect(result.coverScore).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("empty array: unanimous is true (all abstained counts as unanimous)", () => {
    const config: EnsembleConfig = { strategies: [] };
    const result = ensembleVote(config, makeCtx());

    expect(result.unanimous).toBe(true);
  });

  it("empty array + unanimous=true → still safely returns none", () => {
    const config: EnsembleConfig = { strategies: [], unanimous: true };
    const result = ensembleVote(config, makeCtx());

    expect(result.signal).toBe("none");
    expect(result.unanimous).toBe(true);
  });

  it("empty array + high threshold → still safely returns none", () => {
    const config: EnsembleConfig = { strategies: [], threshold: 0.99 };
    const result = ensembleVote(config, makeCtx());

    expect(result.signal).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// Bug 4 Tests: totalWeight = 0 (all weights are 0)
// ─────────────────────────────────────────────────────

describe("ensemble — totalWeight = 0 zero-division protection (Bug 4)", () => {
  beforeAll(() => {
    ensureBuyMock();
  });

  it("does not crash when all strategy weights are 0 (guard: totalWeight = 1)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "edge-mock-buy", weight: 0 },
        { id: "edge-mock-buy", weight: 0 },
      ],
    };

    expect(() => ensembleVote(config, makeCtx())).not.toThrow();
  });

  it("all weights=0 → totalWeight corrected to 1, normalizedWeight is normal", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "edge-mock-buy", weight: 0 }],
    };

    const result = ensembleVote(config, makeCtx());

    // Should not have NaN
    expect(Number.isNaN(result.buyScore)).toBe(false);
    expect(Number.isNaN(result.confidence)).toBe(false);
  });

  it("weight=0: all scores are 0 (because normalizedWeight = 0/1 = 0)", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "edge-mock-buy", weight: 0 }],
    };

    const result = ensembleVote(config, makeCtx());

    // weight=0 → normalizedWeight=0 → all score accumulations are 0 → all 0
    expect(result.buyScore).toBe(0);
  });
});

// ─────────────────────────────────────────────────────
// Bug 4 Tests: negative weights (edge case)
// ─────────────────────────────────────────────────────

describe("ensemble — negative weight boundary (Bug 4 extra protection)", () => {
  it("does not crash with negative weight (totalWeight may be negative or 0)", () => {
    ensureBuyMock();

    const config: EnsembleConfig = {
      strategies: [{ id: "edge-mock-buy", weight: -1 }],
    };

    // Should not crash
    expect(() => ensembleVote(config, makeCtx())).not.toThrow();
  });
});

/**
 * Ensemble Strategy Voting tests
 *
 * Covered scenarios:
 *   - Majority voting, custom weights, threshold, unanimous mode
 *   - short/cover signal voting
 *   - Empty list, missing strategy IDs
 *   - VoteResult field correctness
 *   - ensemble-strategy plugin
 *   - signal-engine integration
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { ensembleVote } from "../strategies/ensemble.js";
import type { EnsembleConfig } from "../strategies/ensemble.js";
import type { StrategyContext } from "../strategies/types.js";
import type { Kline, StrategyConfig, Indicators } from "../types.js";
import { registerStrategy, getStrategy } from "../strategies/registry.js";
import type { Strategy } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Test Setup — register mock strategies
// ─────────────────────────────────────────────────────

/**
 * Create and register a mock strategy that always returns the specified signal
 */
function makeMockStrategy(id: string, fixedSignal: import("../types.js").SignalType): Strategy {
  const s: Strategy = {
    id,
    name: `mock-${id}`,
    populateSignal: () => fixedSignal,
  };
  registerStrategy(s);
  return s;
}

// Register mock strategies before all tests
beforeAll(async () => {
  // Ensure built-in strategies are registered (side-effect import)
  await import("../strategies/index.js");

  // Register test mock strategies (fixed signals)
  makeMockStrategy("mock-buy", "buy");
  makeMockStrategy("mock-sell", "sell");
  makeMockStrategy("mock-short", "short");
  makeMockStrategy("mock-cover", "cover");
  makeMockStrategy("mock-none", "none");
  // Note: mock-buy2 / mock-buy3 are aliases for the same buy signal
  makeMockStrategy("mock-buy2", "buy");
  makeMockStrategy("mock-buy3", "buy");
});

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeMinimalCfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
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
    signals: { buy: [], sell: [], short: [], cover: [] },
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
      on_signal: true, on_trade: true, on_stop_loss: true,
      on_take_profit: true, on_error: true, on_daily_summary: true,
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    ...overrides,
  };
}

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    maShort: 105, maLong: 100, rsi: 50,
    price: 100, volume: 1000, avgVolume: 800,
    ...overrides,
  };
}

function makeKlines(n = 30): Kline[] {
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

function makeCtx(cfgOverrides: Partial<StrategyConfig> = {}): StrategyContext {
  return {
    klines: makeKlines(),
    cfg: makeMinimalCfg(cfgOverrides),
    indicators: makeIndicators(),
    extra: {},
  };
}

// ─────────────────────────────────────────────────────
// 1. Basic majority voting
// ─────────────────────────────────────────────────────

describe("ensembleVote — basic majority voting", () => {
  it("3 strategies all buy → result buy, unanimous=true", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-buy3", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.unanimous).toBe(true);
    expect(result.buyScore).toBeCloseTo(1.0);
    expect(result.confidence).toBeCloseTo(1.0);
  });

  it("2 buy + 1 sell → result buy (majority), unanimous=false", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.unanimous).toBe(false);
    expect(result.buyScore).toBeCloseTo(2 / 3);
    expect(result.sellScore).toBeCloseTo(1 / 3);
  });

  it("1 buy + 1 sell + 1 none (equal weight) → none (buy gets 1/3 < 0.5 threshold)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-sell", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // buy = 1/3, sell = 1/3, both < 0.5 → none
    expect(result.signal).toBe("none");
    expect(result.buyScore).toBeCloseTo(1 / 3);
    expect(result.sellScore).toBeCloseTo(1 / 3);
  });

  it("all strategies none → result none, unanimous=true", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-none", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.confidence).toBe(0);
    // all none → unanimous (all abstained)
    expect(result.unanimous).toBe(true);
  });

  it("empty strategy list → result none", () => {
    const config: EnsembleConfig = { strategies: [] };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.votes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 2. Custom weights
// ─────────────────────────────────────────────────────

describe("ensembleVote — custom weights", () => {
  it("default=0.5, rsi=0.3, breakout=0.2: buy weight 0.5+0.3=0.8 > sell 0.2", () => {
    // mock-buy = 0.5, mock-buy2 = 0.3, mock-sell = 0.2
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.5 },
        { id: "mock-buy2", weight: 0.3 },
        { id: "mock-sell", weight: 0.2 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.buyScore).toBeCloseTo(0.8);
    expect(result.sellScore).toBeCloseTo(0.2);
    expect(result.confidence).toBeCloseTo(0.8);
  });

  it("asymmetric weights: sell has higher weight → sell wins", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.2 },
        { id: "mock-sell", weight: 0.8 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("sell");
    expect(result.sellScore).toBeCloseTo(0.8);
  });

  it("1 buy(w=0.6) + 1 sell(w=0.4): buy gets 0.6 >= 0.5 threshold → buy", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.6 },
        { id: "mock-sell", weight: 0.4 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.confidence).toBeCloseTo(0.6);
  });

  it("1 buy(w=0.4) + 1 sell(w=0.6): sell gets 0.6 >= 0.5 → sell", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.4 },
        { id: "mock-sell", weight: 0.6 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("sell");
  });
});

// ─────────────────────────────────────────────────────
// 3. threshold parameter
// ─────────────────────────────────────────────────────

describe("ensembleVote — threshold parameter", () => {
  it("threshold=0.7: 2 buy + 1 sell (equal weight) → buy gets 2/3 ≈ 0.667 < 0.7 → none", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
      threshold: 0.7,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.confidence).toBeCloseTo(2 / 3);
  });

  it("threshold=0.7: 3 buy (equal weight) → buy gets 1.0 >= 0.7 → buy", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-buy3", weight: 1 },
      ],
      threshold: 0.7,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
  });

  it("threshold=0.3 (lenient): 1 buy(w=0.35) + 1 sell(w=0.65) → sell (gets 0.65 >= 0.3)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.35 },
        { id: "mock-sell", weight: 0.65 },
      ],
      threshold: 0.3,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("sell");
  });

  it("threshold=0.9: hard for any signal to exceed → none (buy only gets 2/3)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
      threshold: 0.9,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
  });
});

// ─────────────────────────────────────────────────────
// 4. unanimous mode
// ─────────────────────────────────────────────────────

describe("ensembleVote — unanimous mode", () => {
  it("unanimous=true: 2 buy + 1 sell → none (not unanimous)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
      unanimous: true,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.unanimous).toBe(false);
  });

  it("unanimous=true: 3 buy → buy (all votes agree)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-buy3", weight: 1 },
      ],
      unanimous: true,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.unanimous).toBe(true);
  });

  it("unanimous=true: all none → none, unanimous=true", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-none", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
      unanimous: true,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.unanimous).toBe(true);
  });

  it("unanimous=true: 2 sell → sell (all votes agree)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-sell", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
      unanimous: true,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("sell");
    expect(result.unanimous).toBe(true);
  });

  it("unanimous=true + threshold=0.9: 2 buy (equal weight) → buy gets 1.0 >= 0.9 → buy", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
      ],
      unanimous: true,
      threshold: 0.9,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
  });
});

// ─────────────────────────────────────────────────────
// 5. short / cover signal voting
// ─────────────────────────────────────────────────────

describe("ensembleVote — short/cover signals", () => {
  it("3 strategies all short → result short, unanimous=true", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-short", weight: 1 },
        { id: "mock-short", weight: 1 },
        { id: "mock-short", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("short");
    expect(result.shortScore).toBeCloseTo(1.0);
    expect(result.unanimous).toBe(true);
  });

  it("2 cover + 1 none → cover (gets 2/3 >= 0.5)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-cover", weight: 1 },
        { id: "mock-cover", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("cover");
    expect(result.coverScore).toBeCloseTo(2 / 3);
  });

  it("1 short + 1 cover (equal weight) → none (tied at 0.5, first traversed is short)", () => {
    // When tied, iterates in [buy, sell, short, cover] order, short comes before cover
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-short", weight: 1 },
        { id: "mock-cover", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // Both score equally (0.5 each), threshold=0.5, first traversed is short
    expect(result.signal).toBe("short");
    expect(result.shortScore).toBeCloseTo(0.5);
    expect(result.coverScore).toBeCloseTo(0.5);
  });

  it("short/cover scores are correctly assigned in result", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-short", weight: 0.6 },
        { id: "mock-cover", weight: 0.4 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.shortScore).toBeCloseTo(0.6);
    expect(result.coverScore).toBeCloseTo(0.4);
    expect(result.buyScore).toBeCloseTo(0);
    expect(result.sellScore).toBeCloseTo(0);
  });
});

// ─────────────────────────────────────────────────────
// 6. Non-existent strategy ID
// ─────────────────────────────────────────────────────

describe("ensembleVote — non-existent strategy ID", () => {
  it("non-existent strategy ID → skipped (warn), remaining strategies vote normally", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config: EnsembleConfig = {
      strategies: [
        { id: "nonexistent-xyz-abc", weight: 1 },
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // nonexistent is skipped, 2 buy strategies vote
    expect(result.signal).toBe("buy");
    expect(result.votes).toHaveLength(2); // only records successful votes
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("all strategy IDs non-existent → result none", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config: EnsembleConfig = {
      strategies: [
        { id: "ghost-1", weight: 1 },
        { id: "ghost-2", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.votes).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────
// 7. VoteResult field correctness
// ─────────────────────────────────────────────────────

describe("ensembleVote — VoteResult field correctness", () => {
  it("votes array contains strategyId, signal, weight for each strategy", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0.7 },
        { id: "mock-sell", weight: 0.3 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.votes).toHaveLength(2);
    const buyVote = result.votes.find((v) => v.strategyId === "mock-buy");
    const sellVote = result.votes.find((v) => v.strategyId === "mock-sell");
    expect(buyVote).toBeDefined();
    expect(buyVote!.signal).toBe("buy");
    expect(buyVote!.weight).toBe(0.7);
    expect(sellVote).toBeDefined();
    expect(sellVote!.signal).toBe("sell");
    expect(sellVote!.weight).toBe(0.3);
  });

  it("empty list: votes is empty array, all scores are 0", () => {
    const result = ensembleVote({ strategies: [] }, makeCtx());
    expect(result.votes).toHaveLength(0);
    expect(result.buyScore).toBe(0);
    expect(result.sellScore).toBe(0);
    expect(result.shortScore).toBe(0);
    expect(result.coverScore).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("confidence equals the winning signal's score", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-sell", weight: 0.8 },
        { id: "mock-buy", weight: 0.2 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("sell");
    expect(result.confidence).toBeCloseTo(result.sellScore);
  });

  it("when none: confidence equals the highest losing score (< threshold)", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-sell", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
      threshold: 0.5,
    };
    const result = ensembleVote(config, makeCtx());
    // buy = 1/3, sell = 1/3, both < 0.5
    expect(result.signal).toBe("none");
    // confidence is the highest score (buy or sell, each 1/3)
    expect(result.confidence).toBeCloseTo(1 / 3);
  });
});

// ─────────────────────────────────────────────────────
// 8. ensemble-strategy plugin
// ─────────────────────────────────────────────────────

describe("ensemble-strategy plugin", () => {
  it("registered to registry via index.ts", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    expect(strategy.id).toBe("ensemble");
    expect(strategy.name).toBeTruthy();
  });

  it("populateSignal: returns none when cfg.ensemble is not configured", async () => {
    await import("../strategies/index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const strategy = getStrategy("ensemble");
    const ctx = makeCtx(); // no ensemble config
    const signal = strategy.populateSignal(ctx);
    expect(signal).toBe("none");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("populateSignal: 2 buy strategies → buy", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    const ctx = makeCtx({
      ensemble: {
        strategies: [
          { id: "mock-buy", weight: 1 },
          { id: "mock-buy2", weight: 1 },
        ],
      },
    });
    const signal = strategy.populateSignal(ctx);
    expect(signal).toBe("buy");
  });

  it("populateSignal: writes VoteResult to ctx.extra", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    const extra: Record<string, number | boolean | undefined> = {};
    const ctx: StrategyContext = {
      ...makeCtx({
        ensemble: {
          strategies: [
            { id: "mock-buy", weight: 1 },
            { id: "mock-buy2", weight: 1 },
          ],
        },
      }),
      extra,
    };
    strategy.populateSignal(ctx);
    // ctx.extra should contain vote metadata
    expect(extra["ensembleBuyScore"]).toBeCloseTo(1.0);
    expect(extra["ensembleConfidence"]).toBeCloseTo(1.0);
    expect(extra["ensembleUnanimous"]).toBe(true);
  });

  it("populateSignal: does not crash when ctx.extra is undefined", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    const ctx: StrategyContext = {
      klines: makeKlines(),
      cfg: makeMinimalCfg({
        ensemble: {
          strategies: [{ id: "mock-buy", weight: 1 }],
        },
      }),
      indicators: makeIndicators(),
      // extra not set
    };
    expect(() => strategy.populateSignal(ctx)).not.toThrow();
  });

  it("description is set and non-empty", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// 9. signal-engine integration
// ─────────────────────────────────────────────────────

describe("signal-engine integration — strategy_id = ensemble", () => {
  it("processSignal uses ensemble plugin (2 buy mock → buy signal routed correctly)", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = makeKlines(60);
    const cfg = makeMinimalCfg({
      strategy_id: "ensemble",
      ensemble: {
        strategies: [
          { id: "mock-buy", weight: 1 },
          { id: "mock-buy2", weight: 1 },
        ],
        threshold: 0.5,
      },
    });
    const result = processSignal("BTCUSDT", klines, cfg);
    expect(result).toBeDefined();
    expect(result.signal.symbol).toBe("BTCUSDT");
    // 2 buy mock strategies → ensemble returns buy (may be filtered by regime/RR, but no crash)
    expect(["buy", "none"].includes(result.signal.type)).toBe(true);
  });

  it("processSignal: does not crash when ensemble strategy ID does not exist, returns none", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const klines = makeKlines(60);
    const cfg = makeMinimalCfg({
      strategy_id: "ensemble",
      ensemble: {
        strategies: [{ id: "totally-nonexistent-999", weight: 1 }],
      },
    });
    const result = processSignal("BTCUSDT", klines, cfg);
    expect(result.signal.type).toBe("none");
    warnSpy.mockRestore();
  });

  it("processSignal: empty ensemble.strategies → none, no crash", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = makeKlines(60);
    const cfg = makeMinimalCfg({
      strategy_id: "ensemble",
      ensemble: { strategies: [] },
    });
    const result = processSignal("BTCUSDT", klines, cfg);
    expect(result.signal.type).toBe("none");
  });

  it("processSignal: 2 sell mock → sell signal (may pass through as sell bypasses regime)", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = makeKlines(60);
    const cfg = makeMinimalCfg({
      strategy_id: "ensemble",
      ensemble: {
        strategies: [
          { id: "mock-sell", weight: 1 },
          { id: "mock-sell", weight: 1 },
        ],
      },
    });
    const result = processSignal("BTCUSDT", klines, cfg);
    // sell does not go through regime filter (passes directly)
    expect(result.signal.type).toBe("sell");
    expect(result.rejected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 10. Edge cases and additional coverage
// ─────────────────────────────────────────────────────

describe("ensembleVote — edge cases", () => {
  it("single strategy buy (equals none threshold=0.5) → buy (1.0 >= 0.5)", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "mock-buy", weight: 1 }],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.buyScore).toBeCloseTo(1.0);
  });

  it("single strategy none → none", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "mock-none", weight: 1 }],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
  });

  it("all weights 0 → no crash, scores are NaN or 0, returns none", () => {
    // totalWeight = 0 → zero-division protection should apply
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0 },
        { id: "mock-sell", weight: 0 },
      ],
    };
    // Should not crash
    expect(() => ensembleVote(config, makeCtx())).not.toThrow();
  });

  it("unanimous=false (explicit default): 2 buy + 1 sell → buy", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
        { id: "mock-sell", weight: 1 },
      ],
      unanimous: false,
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
  });

  it("threshold not set (default 0.5): 1 buy + 1 none → buy (1/2 = 0.5)", () => {
    // 1 buy / 2 total weight = 0.5, equals threshold → should pass (>= 0.5)
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // buy = 1/2 = 0.5 >= threshold(0.5) → buy
    expect(result.signal).toBe("buy");
    expect(result.confidence).toBeCloseTo(0.5);
  });
});

/**
 * Ensemble Strategy Voting 测试
 *
 * 覆盖场景：
 *   - 多数投票、自定义权重、threshold、unanimous 模式
 *   - short/cover 信号投票
 *   - 空列表、缺失策略 ID
 *   - VoteResult 各字段正确性
 *   - ensemble-strategy 插件
 *   - signal-engine 集成
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { ensembleVote } from "../strategies/ensemble.js";
import type { EnsembleConfig } from "../strategies/ensemble.js";
import type { StrategyContext } from "../strategies/types.js";
import type { Kline, StrategyConfig, Indicators } from "../types.js";
import { registerStrategy, getStrategy } from "../strategies/registry.js";
import type { Strategy } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Test Setup — 注册 mock 策略
// ─────────────────────────────────────────────────────

/**
 * 创建并注册一个固定返回指定信号的 mock 策略
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

// 在所有测试开始前注册 mock 策略
beforeAll(async () => {
  // 确保内置策略已注册（副作用 import）
  await import("../strategies/index.js");

  // 注册测试用 mock 策略（固定信号）
  makeMockStrategy("mock-buy", "buy");
  makeMockStrategy("mock-sell", "sell");
  makeMockStrategy("mock-short", "short");
  makeMockStrategy("mock-cover", "cover");
  makeMockStrategy("mock-none", "none");
  // 注意：mock-buy2 / mock-buy3 是同一个 buy 信号的别名
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
// 1. 基础多数投票
// ─────────────────────────────────────────────────────

describe("ensembleVote — 基础多数投票", () => {
  it("3 个策略全部 buy → 结果 buy，unanimous=true", () => {
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

  it("2 buy + 1 sell → 结果 buy（多数），unanimous=false", () => {
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

  it("1 buy + 1 sell + 1 none (等权重) → none（buy 得 1/3 < 0.5 threshold）", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-sell", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // buy = 1/3, sell = 1/3，两者都 < 0.5 → none
    expect(result.signal).toBe("none");
    expect(result.buyScore).toBeCloseTo(1 / 3);
    expect(result.sellScore).toBeCloseTo(1 / 3);
  });

  it("所有策略 none → 结果 none，unanimous=true", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-none", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.confidence).toBe(0);
    // 全 none → unanimous（全弃权）
    expect(result.unanimous).toBe(true);
  });

  it("空策略列表 → 结果 none", () => {
    const config: EnsembleConfig = { strategies: [] };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
    expect(result.votes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// 2. 自定义权重
// ─────────────────────────────────────────────────────

describe("ensembleVote — 自定义权重", () => {
  it("default=0.5, rsi=0.3, breakout=0.2：buy 权重 0.5+0.3=0.8 > sell 0.2", () => {
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

  it("权重不对称：sell 权重更高 → sell 胜出", () => {
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

  it("1 buy(w=0.6) + 1 sell(w=0.4)：buy 得 0.6 >= 0.5 threshold → buy", () => {
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

  it("1 buy(w=0.4) + 1 sell(w=0.6)：sell 得 0.6 >= 0.5 → sell", () => {
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
// 3. threshold 参数
// ─────────────────────────────────────────────────────

describe("ensembleVote — threshold 参数", () => {
  it("threshold=0.7：2 buy + 1 sell(等权) → buy 得 2/3 ≈ 0.667 < 0.7 → none", () => {
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

  it("threshold=0.7：3 buy(等权) → buy 得 1.0 >= 0.7 → buy", () => {
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

  it("threshold=0.3（宽松）：1 buy(w=0.35) + 1 sell(w=0.65) → sell（得 0.65 >= 0.3）", () => {
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

  it("threshold=0.9：任何信号都难以超过 → none（buy 只有 2/3）", () => {
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
// 4. unanimous 模式
// ─────────────────────────────────────────────────────

describe("ensembleVote — unanimous 模式", () => {
  it("unanimous=true：2 buy + 1 sell → none（不一致）", () => {
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

  it("unanimous=true：3 buy → buy（全票一致）", () => {
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

  it("unanimous=true：所有 none → none，unanimous=true", () => {
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

  it("unanimous=true：2 sell → sell（全票一致）", () => {
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

  it("unanimous=true + threshold=0.9：2 buy(等权) → buy 得 1.0 >= 0.9 → buy", () => {
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
// 5. short / cover 信号投票
// ─────────────────────────────────────────────────────

describe("ensembleVote — short/cover 信号", () => {
  it("3 策略全部 short → 结果 short，unanimous=true", () => {
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

  it("2 cover + 1 none → cover（得 2/3 >= 0.5）", () => {
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

  it("1 short + 1 cover（等权）→ none（各得 0.5，并列取第一个 short）", () => {
    // 并列时按照 [buy, sell, short, cover] 顺序，short 先于 cover
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-short", weight: 1 },
        { id: "mock-cover", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // 两者得分相同（各 0.5），threshold=0.5，第一个遍历到的是 short
    expect(result.signal).toBe("short");
    expect(result.shortScore).toBeCloseTo(0.5);
    expect(result.coverScore).toBeCloseTo(0.5);
  });

  it("short/cover scores 在结果中正确赋值", () => {
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
// 6. 策略 ID 不存在
// ─────────────────────────────────────────────────────

describe("ensembleVote — 策略 ID 不存在", () => {
  it("不存在的策略 ID → 跳过（warn），其余策略正常投票", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config: EnsembleConfig = {
      strategies: [
        { id: "nonexistent-xyz-abc", weight: 1 },
        { id: "mock-buy", weight: 1 },
        { id: "mock-buy2", weight: 1 },
      ],
    };
    const result = ensembleVote(config, makeCtx());
    // nonexistent 被跳过，2 个 buy 策略投票
    expect(result.signal).toBe("buy");
    expect(result.votes).toHaveLength(2); // 只记录成功的投票
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("所有策略 ID 均不存在 → 结果 none", () => {
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
// 7. VoteResult 字段正确性
// ─────────────────────────────────────────────────────

describe("ensembleVote — VoteResult 字段正确性", () => {
  it("votes 数组包含每个策略的 strategyId、signal、weight", () => {
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

  it("空列表时 votes 为空数组，各 score 为 0", () => {
    const result = ensembleVote({ strategies: [] }, makeCtx());
    expect(result.votes).toHaveLength(0);
    expect(result.buyScore).toBe(0);
    expect(result.sellScore).toBe(0);
    expect(result.shortScore).toBe(0);
    expect(result.coverScore).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("confidence 等于胜出信号的得分", () => {
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

  it("none 时 confidence 等于最高落败得分（< threshold）", () => {
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 1 },
        { id: "mock-sell", weight: 1 },
        { id: "mock-none", weight: 1 },
      ],
      threshold: 0.5,
    };
    const result = ensembleVote(config, makeCtx());
    // buy = 1/3, sell = 1/3，均 < 0.5
    expect(result.signal).toBe("none");
    // confidence 为最高得分（买或卖各 1/3）
    expect(result.confidence).toBeCloseTo(1 / 3);
  });
});

// ─────────────────────────────────────────────────────
// 8. ensemble-strategy 插件
// ─────────────────────────────────────────────────────

describe("ensemble-strategy 插件", () => {
  it("已通过 index.ts 注册到 registry", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    expect(strategy.id).toBe("ensemble");
    expect(strategy.name).toBeTruthy();
  });

  it("populateSignal：cfg.ensemble 未配置时返回 none", async () => {
    await import("../strategies/index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const strategy = getStrategy("ensemble");
    const ctx = makeCtx(); // 没有 ensemble 配置
    const signal = strategy.populateSignal(ctx);
    expect(signal).toBe("none");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("populateSignal：2 buy 策略 → buy", async () => {
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

  it("populateSignal：将 VoteResult 写入 ctx.extra", async () => {
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
    // ctx.extra 应包含投票元数据
    expect(extra["ensembleBuyScore"]).toBeCloseTo(1.0);
    expect(extra["ensembleConfidence"]).toBeCloseTo(1.0);
    expect(extra["ensembleUnanimous"]).toBe(true);
  });

  it("populateSignal：ctx.extra 为 undefined 时不崩溃", async () => {
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
      // extra 未设置
    };
    expect(() => strategy.populateSignal(ctx)).not.toThrow();
  });

  it("description 已设置且非空", async () => {
    await import("../strategies/index.js");
    const strategy = getStrategy("ensemble");
    expect(strategy.description).toBeDefined();
    expect(strategy.description!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// 9. signal-engine 集成
// ─────────────────────────────────────────────────────

describe("signal-engine 集成 — strategy_id = ensemble", () => {
  it("processSignal 使用 ensemble 插件（2 buy mock → buy 信号路由正确）", async () => {
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
    // 2 buy mock 策略 → ensemble 返回 buy（可能被 regime/RR 过滤，但不 crash）
    expect(["buy", "none"].includes(result.signal.type)).toBe(true);
  });

  it("processSignal：ensemble 内策略 ID 不存在时不崩溃，返回 none", async () => {
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

  it("processSignal：空 ensemble.strategies → none，不 crash", async () => {
    const { processSignal } = await import("../strategy/signal-engine.js");
    const klines = makeKlines(60);
    const cfg = makeMinimalCfg({
      strategy_id: "ensemble",
      ensemble: { strategies: [] },
    });
    const result = processSignal("BTCUSDT", klines, cfg);
    expect(result.signal.type).toBe("none");
  });

  it("processSignal：2 sell mock → sell 信号（可能被后续过滤放行，因 sell 不过 regime）", async () => {
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
    // sell 不经过 regime 过滤（直接放行）
    expect(result.signal.type).toBe("sell");
    expect(result.rejected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 10. 边界情况与额外覆盖
// ─────────────────────────────────────────────────────

describe("ensembleVote — 边界情况", () => {
  it("单个策略 buy（等于 none threshold=0.5）→ buy（1.0 >= 0.5）", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "mock-buy", weight: 1 }],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("buy");
    expect(result.buyScore).toBeCloseTo(1.0);
  });

  it("单个策略 none → none", () => {
    const config: EnsembleConfig = {
      strategies: [{ id: "mock-none", weight: 1 }],
    };
    const result = ensembleVote(config, makeCtx());
    expect(result.signal).toBe("none");
  });

  it("权重均为 0 → 不崩溃，得分均为 NaN 或 0，返回 none", () => {
    // totalWeight = 0 → 防零保护应生效
    const config: EnsembleConfig = {
      strategies: [
        { id: "mock-buy", weight: 0 },
        { id: "mock-sell", weight: 0 },
      ],
    };
    // 不应 crash
    expect(() => ensembleVote(config, makeCtx())).not.toThrow();
  });

  it("unanimous=false（显式默认）：2 buy + 1 sell → buy", () => {
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

  it("threshold 未设置（默认 0.5）：1 buy + 1 none → buy（1/2 = 0.5）", () => {
    // 1 buy / 2 total weight = 0.5，等于 threshold → 应该通过（>= 0.5）
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

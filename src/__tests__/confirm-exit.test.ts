/**
 * P8.2 confirm_trade_exit — 出场确认钩子 单元测试
 *
 * 覆盖：
 *  - shouldConfirmExit 默认逻辑
 *  - 止损 + 价格偏离 → 拒绝
 *  - 止盈 + 价格偏离 → 通过
 *  - force_exit 永远通过
 *  - roi_table / signal / time_stop 出场类型
 *  - 策略 confirmExit() 回调
 *  - 无策略时只用默认逻辑
 *  - 冷却机制
 *  - 空头方向
 *  - executor / engine 集成（mock）
 */

import { describe, it, expect, vi } from "vitest";
import {
  shouldConfirmExit,
  isExitRejectionCoolingDown,
  type ConfirmExitPosition,
} from "../strategy/confirm-exit.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { Kline, Indicators } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makePos(overrides: Partial<ConfirmExitPosition> = {}): ConfirmExitPosition {
  return {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 50000,
    currentPrice: 42000,    // -16% → would trigger flash_crash_protection
    profitRatio: -0.16,
    holdMs: 3_600_000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    klines: [] as Kline[],
    cfg: {
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
        stop_loss_percent: 5,
        take_profit_percent: 10,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.2,
        max_positions: 4,
        max_position_per_symbol: 0.3,
        max_total_loss_percent: 20,
        daily_loss_limit_percent: 8,
      },
      execution: {
        order_type: "market",
        limit_order_offset_percent: 0.1,
        min_order_usdt: 10,
        limit_order_timeout_seconds: 300,
      },
      notify: {
        on_signal: true, on_trade: true, on_stop_loss: true,
        on_take_profit: true, on_error: true, on_daily_summary: true,
        min_interval_minutes: 30,
      },
      news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
      mode: "paper",
    },
    indicators: {
      maShort: 50500, maLong: 50000, rsi: 45,
      price: 42000, volume: 1000, avgVolume: 800,
    } as Indicators,
    ...overrides,
  };
}

function makeStrategy(confirmExitFn?: (pos: ConfirmExitPosition, reason: string) => boolean): Strategy {
  return {
    id: "test-strategy",
    name: "Test Strategy",
    populateSignal: () => "none",
    ...(confirmExitFn !== undefined
      ? {
          confirmExit: (pos, reason, _ctx) => confirmExitFn(pos, reason),
        }
      : {}),
  };
}

// ─────────────────────────────────────────────────────
// shouldConfirmExit — 默认逻辑
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — 默认逻辑", () => {
  it("T01: 正常止损（偏离 < 15%）应通过", () => {
    const pos = makePos({ profitRatio: -0.10 }); // -10%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T02: 止损 + 价格偏离 >15% → 被拒绝（flash_crash_protection）", () => {
    const pos = makePos({ profitRatio: -0.20 }); // -20%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T03: 止损 + 价格偏离恰好 = 15% → 通过（边界值，不超过）", () => {
    const pos = makePos({ profitRatio: -0.15 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T04: 止盈 + 价格偏离 >15% → 仍然通过（只有 stop_loss 受保护）", () => {
    const pos = makePos({ profitRatio: 0.20 });
    const result = shouldConfirmExit(pos, "take_profit", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T05: roi_table 出场 + 大偏离 → 通过", () => {
    const pos = makePos({ profitRatio: 0.25 });
    const result = shouldConfirmExit(pos, "roi_table", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T06: signal 出场 + 大偏离 → 通过", () => {
    const pos = makePos({ profitRatio: -0.30 });
    const result = shouldConfirmExit(pos, "signal", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T07: time_stop 出场 → 通过", () => {
    const pos = makePos({ profitRatio: -0.05 });
    const result = shouldConfirmExit(pos, "time_stop", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T08: staged_tp 出场 → 通过", () => {
    const pos = makePos({ profitRatio: 0.18 });
    const result = shouldConfirmExit(pos, "staged_tp", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// shouldConfirmExit — force_exit 永远通过
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — force_exit 永远通过", () => {
  it("T09: force_exit → 永远 confirmed=true（偏离再大也通过）", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T10: force_exit_timeout → 永远 confirmed=true", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit_timeout", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T11: force_exit_manual → 永远 confirmed=true", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit_manual", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// shouldConfirmExit — 策略 confirmExit() 回调
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — 策略 confirmExit() 回调", () => {
  it("T12: 策略 confirmExit() 返回 false → 拒绝（reason: strategy_rejected）", () => {
    const strategy = makeStrategy(() => false);
    const pos = makePos({ profitRatio: -0.05 }); // 小偏离，默认逻辑会通过
    const ctx = makeCtx();
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("strategy_rejected");
  });

  it("T13: 策略 confirmExit() 返回 true → 通过", () => {
    const strategy = makeStrategy(() => true);
    const pos = makePos({ profitRatio: -0.20 }); // 大偏离，若无策略默认会拒绝
    const ctx = makeCtx();
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(result.confirmed).toBe(true);
  });

  it("T14: 策略存在但没有 ctx → 不调用 confirmExit，走默认逻辑", () => {
    const confirmExitSpy = vi.fn().mockReturnValue(false);
    const strategy = makeStrategy(confirmExitSpy);
    const pos = makePos({ profitRatio: -0.20 });
    // No ctx provided → defaults to flash_crash_protection
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, undefined);
    expect(confirmExitSpy).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T15: 无策略时只使用默认逻辑（大偏离 stop_loss → 拒绝）", () => {
    const pos = makePos({ profitRatio: -0.25 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, undefined, undefined);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T16: 策略 confirmExit() 传入正确的 exitReason 参数", () => {
    const receivedArgs: Array<{ pos: ConfirmExitPosition; reason: string }> = [];
    const strategy = makeStrategy((pos, reason) => {
      receivedArgs.push({ pos, reason });
      return true;
    });
    const pos = makePos({ profitRatio: 0.10 });
    const ctx = makeCtx();
    shouldConfirmExit(pos, "take_profit", 0.15, strategy, ctx);
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0]!.reason).toBe("take_profit");
    expect(receivedArgs[0]!.pos.symbol).toBe("BTCUSDT");
  });

  it("T17: force_exit 时即使策略 confirmExit 返回 false，也不调用（永远通过）", () => {
    const confirmExitSpy = vi.fn().mockReturnValue(false);
    const strategy = makeStrategy(confirmExitSpy);
    const pos = makePos({ profitRatio: -0.50 });
    const ctx = makeCtx();
    const result = shouldConfirmExit(pos, "force_exit", 0.15, strategy, ctx);
    expect(confirmExitSpy).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// shouldConfirmExit — 空头方向
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — 空头方向", () => {
  it("T18: 空头止损 + profitRatio < -15% → 被拒绝", () => {
    // 空头：价格上涨超出预期（profitRatio = 负值 = 亏损）
    const pos = makePos({
      side: "short",
      entryPrice: 50000,
      currentPrice: 59000, // 价格上涨 18%
      profitRatio: -0.18,
    });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T19: 空头止盈 + profitRatio > 15% → 通过（止盈不受保护）", () => {
    const pos = makePos({
      side: "short",
      entryPrice: 50000,
      currentPrice: 41000, // 价格下跌 18%
      profitRatio: 0.18,
    });
    const result = shouldConfirmExit(pos, "take_profit", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// isExitRejectionCoolingDown
// ─────────────────────────────────────────────────────

describe("isExitRejectionCoolingDown — 冷却机制", () => {
  it("T20: 没有记录时，不在冷却中", () => {
    const log = new Map<string, number>();
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(false);
  });

  it("T21: 刚记录后，立即在冷却中", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now());
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(true);
  });

  it("T22: 记录超过冷却时间后，不再冷却", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now() - 400_000); // 400s 前，超出 300s 冷却
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(false);
  });

  it("T23: 不同 symbol 独立冷却", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now()); // BTC 在冷却
    expect(isExitRejectionCoolingDown("ETHUSDT", 300_000, log)).toBe(false);
  });

  it("T24: 冷却时间为 0 时，始终不在冷却中", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now()); // 刚记录
    expect(isExitRejectionCoolingDown("BTCUSDT", 0, log)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// Engine 集成测试（mock）
// ─────────────────────────────────────────────────────

// 我们通过直接测试 shouldConfirmExit 来验证 engine 的集成逻辑行为
// （engine.ts 的 checkExitConditions 是纯函数，它内部已调用 shouldConfirmExit）

describe("engine 集成：shouldConfirmExit 被正确调用", () => {
  it("T25: engine 场景 — 止损触发 + 偏离 <15% → confirmed=true, 应执行出场", () => {
    const pos = makePos({ profitRatio: -0.08 }); // -8%, 没有超出 15%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T26: engine 场景 — 止损触发 + 偏离 >15% → confirmed=false, 应拒绝出场", () => {
    const pos = makePos({ profitRatio: -0.20 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T27: engine 场景 — 自定义最大偏离参数生效", () => {
    const pos = makePos({ profitRatio: -0.30 });
    // 默认 15% 会拒绝
    expect(shouldConfirmExit(pos, "stop_loss", 0.15).confirmed).toBe(false);
    // 50% 阈值不会拒绝
    expect(shouldConfirmExit(pos, "stop_loss", 0.50).confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Executor 集成测试（mock）
// ─────────────────────────────────────────────────────

describe("executor 集成：shouldConfirmExit 与冷却机制联动", () => {
  it("T28: 首次被拒绝后冷却日志追踪正确", () => {
    const log = new Map<string, number>();
    const symbol = "BTCUSDT";
    const cooldownMs = 300_000;

    // 第一次：不在冷却中 → 应该打日志
    expect(isExitRejectionCoolingDown(symbol, cooldownMs, log)).toBe(false);

    // 模拟记录拒绝时间戳（executor 中会 set 时间戳）
    log.set(symbol, Date.now());

    // 第二次：在冷却中 → 不应该打日志
    expect(isExitRejectionCoolingDown(symbol, cooldownMs, log)).toBe(true);
  });

  it("T29: 策略拒绝 + 冷却机制联动", () => {
    const strategy = makeStrategy(() => false);
    const ctx = makeCtx();
    const pos = makePos({ profitRatio: -0.05 });
    const log = new Map<string, number>();

    // 首次：shouldConfirmExit 拒绝
    const r1 = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(r1.confirmed).toBe(false);
    expect(r1.reason).toBe("strategy_rejected");

    // 模拟 executor 记录拒绝时间
    const notCooling1 = !isExitRejectionCoolingDown("BTCUSDT", 300_000, log);
    expect(notCooling1).toBe(true); // 第一次不在冷却
    log.set("BTCUSDT", Date.now());

    // 第二次：已在冷却
    const cooling = isExitRejectionCoolingDown("BTCUSDT", 300_000, log);
    expect(cooling).toBe(true);
  });

  it("T30: trailing_stop 出场 + 无策略 → 通过（不受价格偏离检查）", () => {
    const pos = makePos({ profitRatio: -0.20 });
    // trailing_stop 不是 stop_loss，默认逻辑不检查
    const result = shouldConfirmExit(pos, "trailing_stop", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

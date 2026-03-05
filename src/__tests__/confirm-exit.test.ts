/**
 * P8.2 confirm_trade_exit — Exit confirmation hook unit tests
 *
 * Covers:
 *  - shouldConfirmExit default logic
 *  - stop_loss + price deviation -> rejected
 *  - take_profit + price deviation -> passes
 *  - force_exit always passes
 *  - roi_table / signal / time_stop exit types
 *  - Strategy confirmExit() callback
 *  - No strategy: only default logic
 *  - Cooldown mechanism
 *  - Short direction
 *  - executor / engine integration (mock)
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
    currentPrice: 42000,    // -16% -> would trigger flash_crash_protection
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
// shouldConfirmExit — default logic
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — default logic", () => {
  it("T01: normal stop loss (deviation < 15%) should pass", () => {
    const pos = makePos({ profitRatio: -0.10 }); // -10%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T02: stop loss + price deviation >15% -> rejected (flash_crash_protection)", () => {
    const pos = makePos({ profitRatio: -0.20 }); // -20%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T03: stop loss + price deviation exactly = 15% -> passes (boundary value, does not exceed)", () => {
    const pos = makePos({ profitRatio: -0.15 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T04: take profit + price deviation >15% -> still passes (only stop_loss is protected)", () => {
    const pos = makePos({ profitRatio: 0.20 });
    const result = shouldConfirmExit(pos, "take_profit", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T05: roi_table exit + large deviation -> passes", () => {
    const pos = makePos({ profitRatio: 0.25 });
    const result = shouldConfirmExit(pos, "roi_table", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T06: signal exit + large deviation -> passes", () => {
    const pos = makePos({ profitRatio: -0.30 });
    const result = shouldConfirmExit(pos, "signal", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T07: time_stop exit -> passes", () => {
    const pos = makePos({ profitRatio: -0.05 });
    const result = shouldConfirmExit(pos, "time_stop", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T08: staged_tp exit -> passes", () => {
    const pos = makePos({ profitRatio: 0.18 });
    const result = shouldConfirmExit(pos, "staged_tp", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// shouldConfirmExit — force_exit always passes
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — force_exit always passes", () => {
  it("T09: force_exit -> always confirmed=true (passes regardless of deviation)", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T10: force_exit_timeout -> always confirmed=true", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit_timeout", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T11: force_exit_manual -> always confirmed=true", () => {
    const pos = makePos({ profitRatio: -0.50 });
    const result = shouldConfirmExit(pos, "force_exit_manual", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// shouldConfirmExit — strategy confirmExit() callback
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — strategy confirmExit() callback", () => {
  it("T12: strategy confirmExit() returns false -> rejected (reason: strategy_rejected)", () => {
    const strategy = makeStrategy(() => false);
    const pos = makePos({ profitRatio: -0.05 }); // small deviation, default logic would pass
    const ctx = makeCtx();
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("strategy_rejected");
  });

  it("T13: strategy confirmExit() returns true -> passes", () => {
    const strategy = makeStrategy(() => true);
    const pos = makePos({ profitRatio: -0.20 }); // large deviation, without strategy default would reject
    const ctx = makeCtx();
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(result.confirmed).toBe(true);
  });

  it("T14: strategy exists but no ctx -> does not call confirmExit, uses default logic", () => {
    const confirmExitSpy = vi.fn().mockReturnValue(false);
    const strategy = makeStrategy(confirmExitSpy);
    const pos = makePos({ profitRatio: -0.20 });
    // No ctx provided -> defaults to flash_crash_protection
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, undefined);
    expect(confirmExitSpy).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T15: no strategy -> only uses default logic (large deviation stop_loss -> rejected)", () => {
    const pos = makePos({ profitRatio: -0.25 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15, undefined, undefined);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T16: strategy confirmExit() receives correct exitReason parameter", () => {
    const receivedArgs: { pos: ConfirmExitPosition; reason: string }[] = [];
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

  it("T17: force_exit does not call strategy confirmExit even if it returns false (always passes)", () => {
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
// shouldConfirmExit — short direction
// ─────────────────────────────────────────────────────

describe("shouldConfirmExit — short direction", () => {
  it("T18: short stop loss + profitRatio < -15% -> rejected", () => {
    // Short: price rises beyond expected (profitRatio = negative = loss)
    const pos = makePos({
      side: "short",
      entryPrice: 50000,
      currentPrice: 59000, // price rises 18%
      profitRatio: -0.18,
    });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T19: short take profit + profitRatio > 15% -> passes (take profit not protected)", () => {
    const pos = makePos({
      side: "short",
      entryPrice: 50000,
      currentPrice: 41000, // price drops 18%
      profitRatio: 0.18,
    });
    const result = shouldConfirmExit(pos, "take_profit", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// isExitRejectionCoolingDown
// ─────────────────────────────────────────────────────

describe("isExitRejectionCoolingDown — cooldown mechanism", () => {
  it("T20: no record -> not cooling down", () => {
    const log = new Map<string, number>();
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(false);
  });

  it("T21: just recorded -> immediately cooling down", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now());
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(true);
  });

  it("T22: record exceeds cooldown time -> no longer cooling down", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now() - 400_000); // 400s ago, exceeds 300s cooldown
    expect(isExitRejectionCoolingDown("BTCUSDT", 300_000, log)).toBe(false);
  });

  it("T23: different symbols cool down independently", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now()); // BTC is cooling down
    expect(isExitRejectionCoolingDown("ETHUSDT", 300_000, log)).toBe(false);
  });

  it("T24: cooldown time = 0 -> never cooling down", () => {
    const log = new Map<string, number>();
    log.set("BTCUSDT", Date.now()); // just recorded
    expect(isExitRejectionCoolingDown("BTCUSDT", 0, log)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// Engine integration tests (mock)
// ─────────────────────────────────────────────────────

// We verify engine integration logic behavior by directly testing shouldConfirmExit
// (engine.ts's checkExitConditions is a pure function that internally calls shouldConfirmExit)

describe("Engine integration: shouldConfirmExit called correctly", () => {
  it("T25: engine scenario — stop loss triggered + deviation <15% -> confirmed=true, should execute exit", () => {
    const pos = makePos({ profitRatio: -0.08 }); // -8%, does not exceed 15%
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(true);
  });

  it("T26: engine scenario — stop loss triggered + deviation >15% -> confirmed=false, should reject exit", () => {
    const pos = makePos({ profitRatio: -0.20 });
    const result = shouldConfirmExit(pos, "stop_loss", 0.15);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("flash_crash_protection");
  });

  it("T27: engine scenario — custom max deviation parameter takes effect", () => {
    const pos = makePos({ profitRatio: -0.30 });
    // Default 15% would reject
    expect(shouldConfirmExit(pos, "stop_loss", 0.15).confirmed).toBe(false);
    // 50% threshold would not reject
    expect(shouldConfirmExit(pos, "stop_loss", 0.50).confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Executor integration tests (mock)
// ─────────────────────────────────────────────────────

describe("Executor integration: shouldConfirmExit and cooldown mechanism coordination", () => {
  it("T28: rejection log tracked correctly after first rejection", () => {
    const log = new Map<string, number>();
    const symbol = "BTCUSDT";
    const cooldownMs = 300_000;

    // First time: not cooling down -> should log
    expect(isExitRejectionCoolingDown(symbol, cooldownMs, log)).toBe(false);

    // Simulate recording rejection timestamp (executor would set timestamp)
    log.set(symbol, Date.now());

    // Second time: cooling down -> should not log
    expect(isExitRejectionCoolingDown(symbol, cooldownMs, log)).toBe(true);
  });

  it("T29: strategy rejection + cooldown mechanism coordination", () => {
    const strategy = makeStrategy(() => false);
    const ctx = makeCtx();
    const pos = makePos({ profitRatio: -0.05 });
    const log = new Map<string, number>();

    // First: shouldConfirmExit rejects
    const r1 = shouldConfirmExit(pos, "stop_loss", 0.15, strategy, ctx);
    expect(r1.confirmed).toBe(false);
    expect(r1.reason).toBe("strategy_rejected");

    // Simulate executor recording rejection time
    const notCooling1 = !isExitRejectionCoolingDown("BTCUSDT", 300_000, log);
    expect(notCooling1).toBe(true); // first time not cooling
    log.set("BTCUSDT", Date.now());

    // Second: already cooling down
    const cooling = isExitRejectionCoolingDown("BTCUSDT", 300_000, log);
    expect(cooling).toBe(true);
  });

  it("T30: trailing_stop exit + no strategy -> passes (not subject to price deviation check)", () => {
    const pos = makePos({ profitRatio: -0.20 });
    // trailing_stop is not stop_loss, default logic does not check
    const result = shouldConfirmExit(pos, "trailing_stop", 0.15);
    expect(result.confirmed).toBe(true);
  });
});

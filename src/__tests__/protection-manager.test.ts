/**
 * Protection Manager 测试 (G1)
 * 覆盖 4 个 protection 插件的核心逻辑：
 *   CooldownPeriod / StoplossGuard / MaxDrawdownProtection / LowProfitPairs
 */
import { describe, it, expect } from "vitest";
import {
  checkProtections,
  parseTradeRecords,
  type ProtectionConfig,
  type TradeRecord,
} from "../strategy/protection-manager.js";

const CANDLE_1H_MS = 60 * 60_000; // 1h K 线

function makeTrade(overrides: Partial<TradeRecord> & { closedAt: number }): TradeRecord {
  return {
    symbol: overrides.symbol ?? "BTCUSDT",
    closedAt: overrides.closedAt,
    pnlRatio: overrides.pnlRatio ?? -0.02,
    wasStopLoss: overrides.wasStopLoss ?? false,
  };
}

const now = Date.now();

// ─────────────────────────────────────────────────────
// CooldownPeriod
// ─────────────────────────────────────────────────────

describe("CooldownPeriod", () => {
  const config: ProtectionConfig = {
    cooldown: { enabled: true, stop_duration_candles: 10 },
  };

  it("没有止损记录时允许开仓", () => {
    const result = checkProtections("BTCUSDT", config, [], CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("冷却期内有止损记录时拒绝", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 5 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Cooldown");
  });

  it("冷却期外的止损记录不影响开仓", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 15 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("非止损平仓不触发 CooldownPeriod", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 2 * CANDLE_1H_MS, wasStopLoss: false, pnlRatio: 0.05 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("不同 pair 的止损不影响当前 pair", () => {
    const trades: TradeRecord[] = [
      { symbol: "ETHUSDT", closedAt: now - 2 * CANDLE_1H_MS, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("cooldown.enabled=false 时不执行检查", () => {
    const disabledConfig: ProtectionConfig = {
      cooldown: { enabled: false, stop_duration_candles: 10 },
    };
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 2 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", disabledConfig, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// StoplossGuard
// ─────────────────────────────────────────────────────

describe("StoplossGuard — 全局模式", () => {
  const config: ProtectionConfig = {
    stoploss_guard: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 3,
      stop_duration_candles: 10,
      only_per_pair: false,
    },
  };

  it("止损次数未达上限时允许开仓", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, wasStopLoss: true }),
      makeTrade({ symbol: "ETHUSDT", closedAt: now - 2_000, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("全局止损次数达到上限时拒绝", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, wasStopLoss: true }),
      { symbol: "ETHUSDT", closedAt: now - 2_000, pnlRatio: -0.03, wasStopLoss: true },
      { symbol: "SOLUSDT", closedAt: now - 3_000, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("StoplossGuard");
  });

  it("超出回看窗口的止损不计入", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 25 * CANDLE_1H_MS, wasStopLoss: true }), // 超出 20 根
      makeTrade({ closedAt: now - 26 * CANDLE_1H_MS, wasStopLoss: true }),
      makeTrade({ closedAt: now - 27 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });
});

describe("StoplossGuard — only_per_pair 模式", () => {
  const config: ProtectionConfig = {
    stoploss_guard: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 2,
      stop_duration_candles: 5,
      only_per_pair: true,
    },
  };

  it("only_per_pair=true 时，其他 pair 的止损不影响当前 pair", () => {
    const trades: TradeRecord[] = [
      { symbol: "ETHUSDT", closedAt: now - 1_000, pnlRatio: -0.02, wasStopLoss: true },
      { symbol: "SOLUSDT", closedAt: now - 2_000, pnlRatio: -0.02, wasStopLoss: true },
      { symbol: "DOGEUSDT", closedAt: now - 3_000, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("only_per_pair=true 时，本 pair 止损次数达上限则拒绝", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, wasStopLoss: true }),
      makeTrade({ closedAt: now - 2_000, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// MaxDrawdownProtection
// ─────────────────────────────────────────────────────

describe("MaxDrawdownProtection", () => {
  const config: ProtectionConfig = {
    max_drawdown: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 3,
      max_allowed_drawdown: 0.15, // 允许的最大亏损 15%（存储为正数）
      stop_duration_candles: 10,
    },
  };

  it("交易记录不足 trade_limit 时不触发", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.10 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("总亏损超过阈值时拒绝", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.08 }), // 总计 -0.24 < -0.15
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("MaxDrawdown");
  });

  it("总亏损在阈值内时允许开仓", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.03 }), // 总计 -0.09 > -0.15 (OK)
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("max_allowed_drawdown 传入负数也正常处理", () => {
    const negConfig: ProtectionConfig = {
      max_drawdown: {
        enabled: true,
        lookback_period_candles: 20,
        trade_limit: 2,
        max_allowed_drawdown: -0.10,
        stop_duration_candles: 5,
      },
    };
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.08 }), // 总计 -0.16 < -0.10
    ];
    const result = checkProtections("BTCUSDT", negConfig, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// LowProfitPairs
// ─────────────────────────────────────────────────────

describe("LowProfitPairs", () => {
  const config: ProtectionConfig = {
    low_profit_pairs: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 3,
      required_profit: 0.0, // 平均不亏损才允许
      stop_duration_candles: 10,
    },
  };

  it("记录不足 trade_limit 时不触发", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.05 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("平均盈亏低于要求时拒绝", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.02 }), // avg = -0.033 < 0
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("LowProfitPairs");
  });

  it("平均盈亏达到要求时允许", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: 0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.02 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: 0.01 }), // avg = 0.013 >= 0
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("不同 pair 的记录不影响当前 pair 的 LowProfit 判断", () => {
    const trades: TradeRecord[] = [
      { symbol: "ETHUSDT", closedAt: now - 1_000, pnlRatio: -0.1, wasStopLoss: false },
      { symbol: "ETHUSDT", closedAt: now - 2_000, pnlRatio: -0.1, wasStopLoss: false },
      { symbol: "ETHUSDT", closedAt: now - 3_000, pnlRatio: -0.1, wasStopLoss: false },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// 组合检查
// ─────────────────────────────────────────────────────

describe("多 Protection 组合", () => {
  it("空 config 时始终允许开仓", () => {
    const result = checkProtections("BTCUSDT", {}, [], CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("所有 protection 均通过时 allowed=true", () => {
    const config: ProtectionConfig = {
      cooldown: { enabled: true, stop_duration_candles: 5 },
      stoploss_guard: {
        enabled: true, lookback_period_candles: 10,
        trade_limit: 3, stop_duration_candles: 5,
      },
    };
    // 止损记录在冷却期外
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 10 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// parseTradeRecords
// ─────────────────────────────────────────────────────

describe("parseTradeRecords", () => {
  it("解析有效的 JSONL 行", () => {
    const lines = [
      JSON.stringify({
        status: "closed", symbol: "BTCUSDT", closedAt: now - 1000,
        pnlPercent: -2.5, exitReason: "stop_loss",
      }),
      JSON.stringify({
        status: "closed", symbol: "ETHUSDT", closedAt: now - 2000,
        pnlPercent: 3.0, exitReason: "take_profit",
      }),
    ];
    const records = parseTradeRecords(lines, now - 10_000);
    expect(records).toHaveLength(2);
    expect(records[0]?.symbol).toBe("BTCUSDT");
    expect(records[0]?.wasStopLoss).toBe(true);
    expect(records[0]?.pnlRatio).toBeCloseTo(-0.025);
    expect(records[1]?.wasStopLoss).toBe(false);
  });

  it("过滤掉 sinceMs 之前的记录", () => {
    const lines = [
      JSON.stringify({ status: "closed", symbol: "BTCUSDT", closedAt: now - 1000, pnlPercent: -1 }),
      JSON.stringify({ status: "closed", symbol: "BTCUSDT", closedAt: now - 5000, pnlPercent: -1 }),
    ];
    const records = parseTradeRecords(lines, now - 2000);
    expect(records).toHaveLength(1);
  });

  it("跳过格式错误的行", () => {
    const lines = ["invalid json", JSON.stringify({ status: "open", symbol: "X" })];
    const records = parseTradeRecords(lines, 0);
    expect(records).toHaveLength(0);
  });

  it("trailing_stop 出场也标记为 wasStopLoss=true", () => {
    const lines = [
      JSON.stringify({
        status: "closed", symbol: "BTCUSDT", closedAt: now - 1000,
        pnlPercent: -1.0, exitReason: "trailing_stop",
      }),
    ];
    const records = parseTradeRecords(lines, 0);
    expect(records[0]?.wasStopLoss).toBe(true);
  });
});

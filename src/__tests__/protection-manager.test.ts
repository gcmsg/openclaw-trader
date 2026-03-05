/**
 * Protection Manager tests (G1)
 * Covers core logic of 4 protection plugins:
 *   CooldownPeriod / StoplossGuard / MaxDrawdownProtection / LowProfitPairs
 */
import { describe, it, expect } from "vitest";
import {
  checkProtections,
  parseTradeRecords,
  type ProtectionConfig,
  type TradeRecord,
} from "../strategy/protection-manager.js";

const CANDLE_1H_MS = 60 * 60_000; // 1h candle

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

  it("allows opening when no stop-loss records exist", () => {
    const result = checkProtections("BTCUSDT", config, [], CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("rejects when stop-loss record exists within cooldown period", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 5 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Cooldown");
  });

  it("stop-loss records outside cooldown period do not block opening", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 15 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("non-stop-loss close does not trigger CooldownPeriod", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 2 * CANDLE_1H_MS, wasStopLoss: false, pnlRatio: 0.05 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("stop-loss from a different pair does not affect the current pair", () => {
    const trades: TradeRecord[] = [
      { symbol: "ETHUSDT", closedAt: now - 2 * CANDLE_1H_MS, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("skips check when cooldown.enabled=false", () => {
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

describe("StoplossGuard — global mode", () => {
  const config: ProtectionConfig = {
    stoploss_guard: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 3,
      stop_duration_candles: 10,
      only_per_pair: false,
    },
  };

  it("allows opening when stop-loss count has not reached the limit", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, wasStopLoss: true }),
      makeTrade({ symbol: "ETHUSDT", closedAt: now - 2_000, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("rejects when global stop-loss count reaches the limit", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, wasStopLoss: true }),
      { symbol: "ETHUSDT", closedAt: now - 2_000, pnlRatio: -0.03, wasStopLoss: true },
      { symbol: "SOLUSDT", closedAt: now - 3_000, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("StoplossGuard");
  });

  it("stop-losses outside lookback window are not counted", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 25 * CANDLE_1H_MS, wasStopLoss: true }), // Beyond 20 candles
      makeTrade({ closedAt: now - 26 * CANDLE_1H_MS, wasStopLoss: true }),
      makeTrade({ closedAt: now - 27 * CANDLE_1H_MS, wasStopLoss: true }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });
});

describe("StoplossGuard — only_per_pair mode", () => {
  const config: ProtectionConfig = {
    stoploss_guard: {
      enabled: true,
      lookback_period_candles: 20,
      trade_limit: 2,
      stop_duration_candles: 5,
      only_per_pair: true,
    },
  };

  it("only_per_pair=true: stop-losses from other pairs do not affect current pair", () => {
    const trades: TradeRecord[] = [
      { symbol: "ETHUSDT", closedAt: now - 1_000, pnlRatio: -0.02, wasStopLoss: true },
      { symbol: "SOLUSDT", closedAt: now - 2_000, pnlRatio: -0.02, wasStopLoss: true },
      { symbol: "DOGEUSDT", closedAt: now - 3_000, pnlRatio: -0.02, wasStopLoss: true },
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("only_per_pair=true: rejects when this pair's stop-loss count reaches the limit", () => {
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
      max_allowed_drawdown: 0.15, // Max allowed loss 15% (stored as positive number)
      stop_duration_candles: 10,
    },
  };

  it("does not trigger when trade records are fewer than trade_limit", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.10 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("rejects when total loss exceeds threshold", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.08 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.08 }), // Total -0.24 < -0.15
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("MaxDrawdown");
  });

  it("allows opening when total loss is within threshold", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.03 }), // Total -0.09 > -0.15 (OK)
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("handles max_allowed_drawdown correctly when passed as negative number", () => {
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
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.08 }), // Total -0.16 < -0.10
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
      required_profit: 0.0, // Only allow if average is not losing
      stop_duration_candles: 10,
    },
  };

  it("does not trigger when records are fewer than trade_limit", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.05 }),
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("rejects when average PnL is below requirement", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: -0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.03 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: -0.02 }), // avg = -0.033 < 0
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("LowProfitPairs");
  });

  it("allows when average PnL meets requirement", () => {
    const trades: TradeRecord[] = [
      makeTrade({ closedAt: now - 1_000, pnlRatio: 0.05 }),
      makeTrade({ closedAt: now - 2_000, pnlRatio: -0.02 }),
      makeTrade({ closedAt: now - 3_000, pnlRatio: 0.01 }), // avg = 0.013 >= 0
    ];
    const result = checkProtections("BTCUSDT", config, trades, CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
  });

  it("records from different pairs do not affect current pair's LowProfit check", () => {
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
// Combined checks
// ─────────────────────────────────────────────────────

describe("Multiple Protection combination", () => {
  it("always allows opening when config is empty", () => {
    const result = checkProtections("BTCUSDT", {}, [], CANDLE_1H_MS, now);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("allowed=true when all protections pass", () => {
    const config: ProtectionConfig = {
      cooldown: { enabled: true, stop_duration_candles: 5 },
      stoploss_guard: {
        enabled: true, lookback_period_candles: 10,
        trade_limit: 3, stop_duration_candles: 5,
      },
    };
    // Stop-loss record is outside cooldown period
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
  it("parses valid JSONL lines", () => {
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

  it("filters out records before sinceMs", () => {
    const lines = [
      JSON.stringify({ status: "closed", symbol: "BTCUSDT", closedAt: now - 1000, pnlPercent: -1 }),
      JSON.stringify({ status: "closed", symbol: "BTCUSDT", closedAt: now - 5000, pnlPercent: -1 }),
    ];
    const records = parseTradeRecords(lines, now - 2000);
    expect(records).toHaveLength(1);
  });

  it("skips malformed lines", () => {
    const lines = ["invalid json", JSON.stringify({ status: "open", symbol: "X" })];
    const records = parseTradeRecords(lines, 0);
    expect(records).toHaveLength(0);
  });

  it("trailing_stop exit is also marked as wasStopLoss=true", () => {
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

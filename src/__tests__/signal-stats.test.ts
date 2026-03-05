/**
 * P4.1 Signal statistics analysis — unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  calcSignalStats,
  rankSignals,
  formatSignalStats,
} from "../analysis/signal-stats.js";
import {
  collectFromBacktest,
  collectFromSignalHistory,
  mergeRecords,
} from "../analysis/trade-collector.js";
import type { TradeRecord } from "../analysis/analysis-types.js";

// ─────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    signalConditions: ["ma_bullish", "rsi_bullish"],
    entryPrice: 100,
    exitPrice: 110,
    pnlPercent: 0.1, // +10%
    pnlUsdt: 10,
    exitReason: "take_profit",
    holdMs: 3_600_000, // 1 hour
    entryTime: 1_000_000,
    exitTime: 1_003_600_000,
    ...overrides,
  };
}

function makeWin(
  conditions: string[] = ["ma_bullish"],
  pnl = 0.05
): TradeRecord {
  return makeTrade({ signalConditions: conditions, pnlPercent: pnl });
}

function makeLoss(
  conditions: string[] = ["ma_bullish"],
  pnl = -0.03
): TradeRecord {
  return makeTrade({ signalConditions: conditions, pnlPercent: pnl });
}

// ─────────────────────────────────────────────────────
// calcSignalStats
// ─────────────────────────────────────────────────────

describe("calcSignalStats", () => {
  it("empty trade list -> empty result", () => {
    expect(calcSignalStats([])).toEqual([]);
  });

  it("trade count < minTrades -> filtered out", () => {
    const trades = [makeWin(["a"]), makeWin(["a"])]; // 2 trades, default minTrades=5
    expect(calcSignalStats(trades)).toHaveLength(0);
  });

  it("custom minTrades -> filtering takes effect", () => {
    const trades = [makeWin(["a"]), makeLoss(["a"]), makeWin(["a"])];
    // minTrades=3, 3 trades -> should include
    expect(calcSignalStats(trades, 3)).toHaveLength(1);
    // minTrades=4, 3 trades -> should filter
    expect(calcSignalStats(trades, 4)).toHaveLength(0);
  });

  it("single signal combination winRate calculated correctly", () => {
    const trades = [
      makeWin(["ma_bullish"]),
      makeWin(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
    ]; // 2 wins, 3 losses -> winRate = 0.4
    const [stat] = calcSignalStats(trades, 5);
    expect(stat).toBeDefined();
    expect(stat!.winRate).toBeCloseTo(0.4);
    expect(stat!.wins).toBe(2);
    expect(stat!.losses).toBe(3);
    expect(stat!.totalTrades).toBe(5);
  });

  it("avgWinPercent calculated correctly", () => {
    const trades = [
      makeWin(["x"], 0.1),
      makeWin(["x"], 0.2),
      makeLoss(["x"], -0.05),
      makeLoss(["x"], -0.05),
      makeLoss(["x"], -0.05),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.avgWinPercent).toBeCloseTo(0.15);
  });

  it("avgLossPercent calculated correctly (negative)", () => {
    const trades = [
      makeWin(["y"], 0.1),
      makeWin(["y"], 0.1),
      makeWin(["y"], 0.1),
      makeLoss(["y"], -0.04),
      makeLoss(["y"], -0.06),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.avgLossPercent).toBeCloseTo(-0.05);
  });

  it("expectancy calculated correctly", () => {
    // winRate 0.6, avgWin 0.1, avgLoss -0.05
    // expectancy = 0.6*0.1 + 0.4*(-0.05) = 0.06 - 0.02 = 0.04
    const trades = [
      makeWin(["z"], 0.1),
      makeWin(["z"], 0.1),
      makeWin(["z"], 0.1),
      makeLoss(["z"], -0.05),
      makeLoss(["z"], -0.05),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.expectancy).toBeCloseTo(0.04);
  });

  it("profitFactor calculated correctly (with losses)", () => {
    // totalWin = 0.1 + 0.1 = 0.2, totalLoss = 0.05 + 0.05 = 0.1 -> PF = 2.0
    const trades = [
      makeWin(["w"], 0.1),
      makeWin(["w"], 0.1),
      makeLoss(["w"], -0.05),
      makeLoss(["w"], -0.05),
      makeWin(["w"], 0.1), // extra win to hit minTrades=5
    ];
    const [stat] = calcSignalStats(trades, 5);
    // totalWin = 0.3, totalLoss = 0.1 -> PF = 3.0
    expect(stat!.profitFactor).toBeCloseTo(3.0);
  });

  it("profitFactor = Infinity when total loss is 0", () => {
    const trades = Array.from({ length: 5 }, () => makeWin(["all_wins"], 0.05));
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.profitFactor).toBe(Infinity);
  });

  it("bestTrade and worstTrade are correct", () => {
    const trades = [
      makeWin(["q"], 0.2),
      makeWin(["q"], 0.05),
      makeLoss(["q"], -0.01),
      makeLoss(["q"], -0.1),
      makeWin(["q"], 0.08),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.bestTrade).toBeCloseTo(0.2);
    expect(stat!.worstTrade).toBeCloseTo(-0.1);
  });

  it("exitReasons count is correct", () => {
    const trades = [
      makeTrade({ signalConditions: ["s"], exitReason: "stop_loss" }),
      makeTrade({ signalConditions: ["s"], exitReason: "stop_loss" }),
      makeTrade({ signalConditions: ["s"], exitReason: "take_profit" }),
      makeTrade({ signalConditions: ["s"], exitReason: "take_profit" }),
      makeTrade({ signalConditions: ["s"], exitReason: "signal" }),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.exitReasons["stop_loss"]).toBe(2);
    expect(stat!.exitReasons["take_profit"]).toBe(2);
    expect(stat!.exitReasons["signal"]).toBe(1);
  });

  it("avgHoldMinutes calculated correctly", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({
        signalConditions: ["h"],
        holdMs: (i + 1) * 60_000, // 1~5 minutes
      })
    );
    const [stat] = calcSignalStats(trades, 5);
    // average = (1+2+3+4+5)/5 = 3 minutes
    expect(stat!.avgHoldMinutes).toBeCloseTo(3);
  });

  it("multiple signal combinations are independently tracked", () => {
    const tradesA = Array.from({ length: 5 }, () => makeWin(["combo_a"], 0.1));
    const tradesB = Array.from({ length: 5 }, () => makeLoss(["combo_b"], -0.05));
    const stats = calcSignalStats([...tradesA, ...tradesB], 5);
    expect(stats).toHaveLength(2);
    const a = stats.find((s) => s.signalCombo === "combo_a");
    const b = stats.find((s) => s.signalCombo === "combo_b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.winRate).toBeCloseTo(1.0);
    expect(b!.winRate).toBeCloseTo(0.0);
  });

  it("multiple signal combinations sorted by expectancy descending", () => {
    // combo_high has higher expectancy
    const high = Array.from({ length: 5 }, () => makeWin(["combo_high"], 0.2));
    const low = Array.from({ length: 5 }, () => makeWin(["combo_low"], 0.02));
    const stats = calcSignalStats([...high, ...low], 5);
    expect(stats[0]!.signalCombo).toBe("combo_high");
    expect(stats[1]!.signalCombo).toBe("combo_low");
  });

  it("signal combinations with different order are grouped under the same key", () => {
    const tradesA = Array.from({ length: 3 }, () =>
      makeWin(["rsi_bullish", "ma_bullish"], 0.05)
    );
    const tradesB = Array.from({ length: 3 }, () =>
      makeWin(["ma_bullish", "rsi_bullish"], 0.05)
    );
    const stats = calcSignalStats([...tradesA, ...tradesB], 6);
    // Should be merged into a single combo
    expect(stats).toHaveLength(1);
    expect(stats[0]!.totalTrades).toBe(6);
  });

  it("side='short' stats are correct (using negative pnlPercent)", () => {
    const trades: TradeRecord[] = [
      makeTrade({
        side: "short",
        signalConditions: ["short_signal"],
        pnlPercent: 0.08,
        exitReason: "take_profit",
      }),
      makeTrade({
        side: "short",
        signalConditions: ["short_signal"],
        pnlPercent: 0.05,
        exitReason: "take_profit",
      }),
      makeTrade({
        side: "short",
        signalConditions: ["short_signal"],
        pnlPercent: -0.04,
        exitReason: "stop_loss",
      }),
      makeTrade({
        side: "short",
        signalConditions: ["short_signal"],
        pnlPercent: -0.06,
        exitReason: "stop_loss",
      }),
      makeTrade({
        side: "short",
        signalConditions: ["short_signal"],
        pnlPercent: 0.1,
        exitReason: "take_profit",
      }),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.winRate).toBeCloseTo(0.6); // 3 wins
    expect(stat!.avgWinPercent).toBeGreaterThan(0);
    expect(stat!.avgLossPercent).toBeLessThan(0);
  });

  it("avgLossPercent = 0 when there are no losses", () => {
    const trades = Array.from({ length: 5 }, () => makeWin(["pure_wins"], 0.05));
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.avgLossPercent).toBe(0);
    expect(stat!.losses).toBe(0);
  });

  it("pnlPercent = 0 is treated as a loss (not a win)", () => {
    const trades = [
      makeTrade({ signalConditions: ["breakeven"], pnlPercent: 0 }),
      makeTrade({ signalConditions: ["breakeven"], pnlPercent: 0 }),
      makeTrade({ signalConditions: ["breakeven"], pnlPercent: 0 }),
      makeWin(["breakeven"], 0.1),
      makeWin(["breakeven"], 0.1),
    ];
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.wins).toBe(2);
    expect(stat!.losses).toBe(3);
  });
});

// ─────────────────────────────────────────────────────
// rankSignals
// ─────────────────────────────────────────────────────

describe("rankSignals", () => {
  it("empty list -> empty result", () => {
    const { best, worst } = rankSignals([]);
    expect(best).toHaveLength(0);
    expect(worst).toHaveLength(0);
  });

  it("returns correct best/worst (by expectancy)", () => {
    const trades = [
      ...Array.from({ length: 5 }, () => makeWin(["alpha"], 0.2)),
      ...Array.from({ length: 5 }, () => makeLoss(["beta"], -0.1)),
      ...Array.from({ length: 5 }, () => makeWin(["gamma"], 0.05)),
    ];
    const stats = calcSignalStats(trades, 5);
    const { best, worst } = rankSignals(stats, 1);
    expect(best[0]!.signalCombo).toBe("alpha");
    expect(worst[0]!.signalCombo).toBe("beta");
  });

  it("topN limits the count", () => {
    const trades = [
      ...Array.from({ length: 5 }, () => makeWin(["a"], 0.1)),
      ...Array.from({ length: 5 }, () => makeWin(["b"], 0.08)),
      ...Array.from({ length: 5 }, () => makeWin(["c"], 0.06)),
      ...Array.from({ length: 5 }, () => makeWin(["d"], 0.04)),
      ...Array.from({ length: 5 }, () => makeWin(["e"], 0.02)),
    ];
    const stats = calcSignalStats(trades, 5);
    const { best, worst } = rankSignals(stats, 2);
    expect(best).toHaveLength(2);
    expect(worst).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────
// formatSignalStats
// ─────────────────────────────────────────────────────

describe("formatSignalStats", () => {
  it("empty list -> returns non-empty hint string", () => {
    const output = formatSignalStats([]);
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(0);
  });

  it("with data, output is non-empty and contains signal combo names", () => {
    const trades = Array.from({ length: 5 }, () =>
      makeWin(["ma_bullish", "rsi_oversold"], 0.05)
    );
    const stats = calcSignalStats(trades, 5);
    const output = formatSignalStats(stats);
    expect(output).toBeTruthy();
    expect(output).toContain("ma_bullish");
    expect(output).toContain("rsi_oversold");
  });

  it("output contains win rate, trade count, expectancy and other key info", () => {
    const trades = Array.from({ length: 5 }, () => makeWin(["key_signal"], 0.1));
    const stats = calcSignalStats(trades, 5);
    const output = formatSignalStats(stats);
    expect(output).toContain("100.0%"); // 100% win rate
    expect(output).toContain("key_signal");
  });
});

// ─────────────────────────────────────────────────────
// collectFromBacktest
// ─────────────────────────────────────────────────────

describe("collectFromBacktest", () => {
  it("invalid input -> empty array", () => {
    expect(collectFromBacktest(null)).toEqual([]);
    expect(collectFromBacktest({})).toEqual([]);
    expect(collectFromBacktest({ trades: "not_array" })).toEqual([]);
  });

  it("only extracts sell/cover, skips buy/short", () => {
    const result = collectFromBacktest({
      trades: [
        { symbol: "BTCUSDT", side: "buy", entryTime: 1000, exitTime: 1000, entryPrice: 100, exitPrice: 100, pnlPercent: 0, pnl: 0 },
        { symbol: "BTCUSDT", side: "sell", entryTime: 1000, exitTime: 2000, entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit" },
        { symbol: "ETHUSDT", side: "short", entryTime: 1000, exitTime: 1000, entryPrice: 50, exitPrice: 50, pnlPercent: 0, pnl: 0 },
        { symbol: "ETHUSDT", side: "cover", entryTime: 1000, exitTime: 3000, entryPrice: 50, exitPrice: 45, pnlPercent: 0.1, pnl: 5, exitReason: "take_profit" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.side).toBe("long"); // sell -> long
    expect(result[1]!.side).toBe("short"); // cover -> short
  });

  it("holdMs calculated correctly", () => {
    const result = collectFromBacktest({
      trades: [
        {
          symbol: "BTCUSDT",
          side: "sell",
          entryTime: 1_000_000,
          exitTime: 4_600_000,
          entryPrice: 100,
          exitPrice: 110,
          pnlPercent: 0.1,
          pnl: 10,
          exitReason: "take_profit",
        },
      ],
    });
    expect(result[0]!.holdMs).toBe(3_600_000); // 1 hour
  });

  it("signalConditions mapped correctly", () => {
    const result = collectFromBacktest({
      trades: [
        {
          symbol: "BTCUSDT",
          side: "sell",
          entryTime: 1000,
          exitTime: 2000,
          entryPrice: 100,
          exitPrice: 110,
          pnlPercent: 0.1,
          pnl: 10,
          exitReason: "signal",
          signalConditions: ["ma_bullish", "rsi_bullish"],
        },
      ],
    });
    expect(result[0]!.signalConditions).toEqual(["ma_bullish", "rsi_bullish"]);
  });

  it("missing signalConditions defaults to empty array", () => {
    const result = collectFromBacktest({
      trades: [
        {
          symbol: "BTCUSDT",
          side: "sell",
          entryTime: 1000,
          exitTime: 2000,
          entryPrice: 100,
          exitPrice: 110,
          pnlPercent: 0.1,
          pnl: 10,
          exitReason: "signal",
        },
      ],
    });
    expect(result[0]!.signalConditions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────
// collectFromSignalHistory
// ─────────────────────────────────────────────────────

describe("collectFromSignalHistory", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-stats-test-"));
    tmpFile = path.join(tmpDir, "signal-history.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("file does not exist -> empty array", () => {
    const result = collectFromSignalHistory("/nonexistent/path/file.jsonl");
    expect(result).toEqual([]);
  });

  it("parses JSONL format correctly", () => {
    const records = [
      {
        id: "sig_1",
        symbol: "BTCUSDT",
        type: "buy",
        entryPrice: 100,
        exitPrice: 110,
        entryTime: 1_000_000,
        exitTime: 4_600_000,
        holdingHours: 1,
        pnlPercent: 0.1,
        pnl: 10,
        exitReason: "take_profit",
        status: "closed",
        entryConditions: { triggeredRules: ["ma_bullish", "rsi_bullish"] },
      },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = collectFromSignalHistory(tmpFile);
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
    expect(result[0]!.side).toBe("long");
    expect(result[0]!.pnlPercent).toBeCloseTo(0.1);
    expect(result[0]!.signalConditions).toEqual(["ma_bullish", "rsi_bullish"]);
    expect(result[0]!.holdMs).toBe(3_600_000);
  });

  it("only loads records with status=closed", () => {
    const records = [
      { id: "1", symbol: "BTC", type: "buy", status: "closed", entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, entryConditions: {} },
      { id: "2", symbol: "ETH", type: "buy", status: "open", entryPrice: 100, exitPrice: 105, pnlPercent: 0.05, pnl: 5, exitReason: null, entryTime: 1000, exitTime: 2000, entryConditions: {} },
      { id: "3", symbol: "SOL", type: "buy", status: "expired", entryPrice: 100, exitPrice: 95, pnlPercent: -0.05, pnl: -5, exitReason: "time_stop", entryTime: 1000, exitTime: 2000, entryConditions: {} },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));

    const result = collectFromSignalHistory(tmpFile);
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTC");
  });

  it("invalid JSON lines are skipped", () => {
    const content = [
      JSON.stringify({ id: "1", symbol: "BTC", type: "buy", status: "closed", entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, entryConditions: {} }),
      "{ invalid json }",
      JSON.stringify({ id: "2", symbol: "ETH", type: "buy", status: "closed", entryPrice: 50, exitPrice: 55, pnlPercent: 0.1, pnl: 5, exitReason: "signal", entryTime: 1000, exitTime: 2000, entryConditions: {} }),
    ].join("\n");
    fs.writeFileSync(tmpFile, content);

    const result = collectFromSignalHistory(tmpFile);
    expect(result).toHaveLength(2); // skips invalid line
  });

  it("short signal type is correctly mapped to side=short", () => {
    const records = [
      { id: "1", symbol: "BTCUSDT", type: "short", status: "closed", entryPrice: 100, exitPrice: 90, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, holdingHours: 0.5, entryConditions: { triggeredRules: ["bearish"] } },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));

    const result = collectFromSignalHistory(tmpFile);
    expect(result[0]!.side).toBe("short");
    expect(result[0]!.signalConditions).toEqual(["bearish"]);
  });

  it("holdMs calculated from holdingHours", () => {
    const records = [
      { id: "1", symbol: "BTC", type: "buy", status: "closed", entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, holdingHours: 2, entryConditions: {} },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));
    const result = collectFromSignalHistory(tmpFile);
    expect(result[0]!.holdMs).toBe(2 * 3_600_000);
  });
});

// ─────────────────────────────────────────────────────
// mergeRecords
// ─────────────────────────────────────────────────────

describe("mergeRecords", () => {
  it("empty sources -> empty result", () => {
    expect(mergeRecords()).toEqual([]);
    expect(mergeRecords([])).toEqual([]);
  });

  it("merges multiple sources", () => {
    const a = [makeTrade({ symbol: "BTCUSDT", entryTime: 1000, exitTime: 2000 })];
    const b = [makeTrade({ symbol: "ETHUSDT", entryTime: 3000, exitTime: 4000 })];
    const merged = mergeRecords(a, b);
    expect(merged).toHaveLength(2);
  });

  it("dedup: same symbol/side/entryTime/exitTime keeps only one record", () => {
    const trade = makeTrade({ symbol: "BTCUSDT", side: "long", entryTime: 1000, exitTime: 2000 });
    const merged = mergeRecords([trade], [trade], [trade]);
    expect(merged).toHaveLength(1);
  });

  it("sorted by entry time", () => {
    const t1 = makeTrade({ entryTime: 3000, exitTime: 4000 });
    const t2 = makeTrade({ entryTime: 1000, exitTime: 2000 });
    const t3 = makeTrade({ entryTime: 2000, exitTime: 3000, symbol: "ETHUSDT" });
    const merged = mergeRecords([t1], [t2], [t3]);
    expect(merged[0]!.entryTime).toBe(1000);
    expect(merged[1]!.entryTime).toBe(2000);
    expect(merged[2]!.entryTime).toBe(3000);
  });

  it("different symbols with same timestamp are not treated as duplicates", () => {
    const btc = makeTrade({ symbol: "BTCUSDT", entryTime: 1000, exitTime: 2000 });
    const eth = makeTrade({ symbol: "ETHUSDT", entryTime: 1000, exitTime: 2000 });
    const merged = mergeRecords([btc], [eth]);
    expect(merged).toHaveLength(2);
  });
});

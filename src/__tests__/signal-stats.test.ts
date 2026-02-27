/**
 * P4.1 信号统计分析 — 单元测试
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
// 测试辅助
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
  it("空交易列表 → 空结果", () => {
    expect(calcSignalStats([])).toEqual([]);
  });

  it("交易数 < minTrades → 过滤掉", () => {
    const trades = [makeWin(["a"]), makeWin(["a"])]; // 2 trades, default minTrades=5
    expect(calcSignalStats(trades)).toHaveLength(0);
  });

  it("minTrades 自定义 → 过滤生效", () => {
    const trades = [makeWin(["a"]), makeLoss(["a"]), makeWin(["a"])];
    // minTrades=3, 3 trades → 应包含
    expect(calcSignalStats(trades, 3)).toHaveLength(1);
    // minTrades=4, 3 trades → 应过滤
    expect(calcSignalStats(trades, 4)).toHaveLength(0);
  });

  it("单一信号组合 winRate 计算正确", () => {
    const trades = [
      makeWin(["ma_bullish"]),
      makeWin(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
      makeLoss(["ma_bullish"]),
    ]; // 2 wins, 3 losses → winRate = 0.4
    const [stat] = calcSignalStats(trades, 5);
    expect(stat).toBeDefined();
    expect(stat!.winRate).toBeCloseTo(0.4);
    expect(stat!.wins).toBe(2);
    expect(stat!.losses).toBe(3);
    expect(stat!.totalTrades).toBe(5);
  });

  it("avgWinPercent 计算正确", () => {
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

  it("avgLossPercent 计算正确（负数）", () => {
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

  it("expectancy 计算正确", () => {
    // 胜率 0.6, 均盈 0.1, 均亏 -0.05
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

  it("profitFactor 计算正确（有亏损）", () => {
    // totalWin = 0.1 + 0.1 = 0.2, totalLoss = 0.05 + 0.05 = 0.1 → PF = 2.0
    const trades = [
      makeWin(["w"], 0.1),
      makeWin(["w"], 0.1),
      makeLoss(["w"], -0.05),
      makeLoss(["w"], -0.05),
      makeWin(["w"], 0.1), // extra win to hit minTrades=5
    ];
    const [stat] = calcSignalStats(trades, 5);
    // totalWin = 0.3, totalLoss = 0.1 → PF = 3.0
    expect(stat!.profitFactor).toBeCloseTo(3.0);
  });

  it("profitFactor = Infinity 当总亏损为 0", () => {
    const trades = Array.from({ length: 5 }, () => makeWin(["all_wins"], 0.05));
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.profitFactor).toBe(Infinity);
  });

  it("bestTrade 和 worstTrade 正确", () => {
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

  it("exitReasons 计数正确", () => {
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

  it("avgHoldMinutes 计算正确", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({
        signalConditions: ["h"],
        holdMs: (i + 1) * 60_000, // 1~5 分钟
      })
    );
    const [stat] = calcSignalStats(trades, 5);
    // 平均 = (1+2+3+4+5)/5 = 3 分钟
    expect(stat!.avgHoldMinutes).toBeCloseTo(3);
  });

  it("多个信号组合各自独立统计", () => {
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

  it("多个信号组合按期望收益降序排列", () => {
    // combo_high 有更高 expectancy
    const high = Array.from({ length: 5 }, () => makeWin(["combo_high"], 0.2));
    const low = Array.from({ length: 5 }, () => makeWin(["combo_low"], 0.02));
    const stats = calcSignalStats([...high, ...low], 5);
    expect(stats[0]!.signalCombo).toBe("combo_high");
    expect(stats[1]!.signalCombo).toBe("combo_low");
  });

  it("信号顺序不同的组合归为同一 key", () => {
    const tradesA = Array.from({ length: 3 }, () =>
      makeWin(["rsi_bullish", "ma_bullish"], 0.05)
    );
    const tradesB = Array.from({ length: 3 }, () =>
      makeWin(["ma_bullish", "rsi_bullish"], 0.05)
    );
    const stats = calcSignalStats([...tradesA, ...tradesB], 6);
    // 应该合并为同一个 combo
    expect(stats).toHaveLength(1);
    expect(stats[0]!.totalTrades).toBe(6);
  });

  it("side='short' 的统计正确（使用 pnlPercent 负值）", () => {
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

  it("没有亏损时 avgLossPercent = 0", () => {
    const trades = Array.from({ length: 5 }, () => makeWin(["pure_wins"], 0.05));
    const [stat] = calcSignalStats(trades, 5);
    expect(stat!.avgLossPercent).toBe(0);
    expect(stat!.losses).toBe(0);
  });

  it("pnlPercent = 0 视为亏损（非盈）", () => {
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
  it("空列表 → 空结果", () => {
    const { best, worst } = rankSignals([]);
    expect(best).toHaveLength(0);
    expect(worst).toHaveLength(0);
  });

  it("返回正确的 best/worst（按 expectancy）", () => {
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

  it("topN 限制数量", () => {
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
  it("空列表 → 返回非空提示字符串", () => {
    const output = formatSignalStats([]);
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(0);
  });

  it("有数据时输出非空且包含信号组合名称", () => {
    const trades = Array.from({ length: 5 }, () =>
      makeWin(["ma_bullish", "rsi_oversold"], 0.05)
    );
    const stats = calcSignalStats(trades, 5);
    const output = formatSignalStats(stats);
    expect(output).toBeTruthy();
    expect(output).toContain("ma_bullish");
    expect(output).toContain("rsi_oversold");
  });

  it("输出包含胜率、交易次数、期望收益等关键信息", () => {
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
  it("无效输入 → 空数组", () => {
    expect(collectFromBacktest(null)).toEqual([]);
    expect(collectFromBacktest({})).toEqual([]);
    expect(collectFromBacktest({ trades: "not_array" })).toEqual([]);
  });

  it("只提取 sell/cover，跳过 buy/short", () => {
    const result = collectFromBacktest({
      trades: [
        { symbol: "BTCUSDT", side: "buy", entryTime: 1000, exitTime: 1000, entryPrice: 100, exitPrice: 100, pnlPercent: 0, pnl: 0 },
        { symbol: "BTCUSDT", side: "sell", entryTime: 1000, exitTime: 2000, entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit" },
        { symbol: "ETHUSDT", side: "short", entryTime: 1000, exitTime: 1000, entryPrice: 50, exitPrice: 50, pnlPercent: 0, pnl: 0 },
        { symbol: "ETHUSDT", side: "cover", entryTime: 1000, exitTime: 3000, entryPrice: 50, exitPrice: 45, pnlPercent: 0.1, pnl: 5, exitReason: "take_profit" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.side).toBe("long"); // sell → long
    expect(result[1]!.side).toBe("short"); // cover → short
  });

  it("holdMs 计算正确", () => {
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

  it("signalConditions 映射正确", () => {
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

  it("缺失 signalConditions 时使用空数组", () => {
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

  it("文件不存在 → 空数组", () => {
    const result = collectFromSignalHistory("/nonexistent/path/file.jsonl");
    expect(result).toEqual([]);
  });

  it("解析 JSONL 格式正确", () => {
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

  it("只加载 status=closed 的记录", () => {
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

  it("无效 JSON 行被跳过", () => {
    const content = [
      JSON.stringify({ id: "1", symbol: "BTC", type: "buy", status: "closed", entryPrice: 100, exitPrice: 110, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, entryConditions: {} }),
      "{ invalid json }",
      JSON.stringify({ id: "2", symbol: "ETH", type: "buy", status: "closed", entryPrice: 50, exitPrice: 55, pnlPercent: 0.1, pnl: 5, exitReason: "signal", entryTime: 1000, exitTime: 2000, entryConditions: {} }),
    ].join("\n");
    fs.writeFileSync(tmpFile, content);

    const result = collectFromSignalHistory(tmpFile);
    expect(result).toHaveLength(2); // 跳过无效行
  });

  it("short 信号 type 正确映射为 side=short", () => {
    const records = [
      { id: "1", symbol: "BTCUSDT", type: "short", status: "closed", entryPrice: 100, exitPrice: 90, pnlPercent: 0.1, pnl: 10, exitReason: "take_profit", entryTime: 1000, exitTime: 2000, holdingHours: 0.5, entryConditions: { triggeredRules: ["bearish"] } },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));

    const result = collectFromSignalHistory(tmpFile);
    expect(result[0]!.side).toBe("short");
    expect(result[0]!.signalConditions).toEqual(["bearish"]);
  });

  it("holdMs 从 holdingHours 计算", () => {
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
  it("空来源 → 空结果", () => {
    expect(mergeRecords()).toEqual([]);
    expect(mergeRecords([])).toEqual([]);
  });

  it("合并多个来源", () => {
    const a = [makeTrade({ symbol: "BTCUSDT", entryTime: 1000, exitTime: 2000 })];
    const b = [makeTrade({ symbol: "ETHUSDT", entryTime: 3000, exitTime: 4000 })];
    const merged = mergeRecords(a, b);
    expect(merged).toHaveLength(2);
  });

  it("去重：相同 symbol/side/entryTime/exitTime 只保留一条", () => {
    const trade = makeTrade({ symbol: "BTCUSDT", side: "long", entryTime: 1000, exitTime: 2000 });
    const merged = mergeRecords([trade], [trade], [trade]);
    expect(merged).toHaveLength(1);
  });

  it("按入场时间排序", () => {
    const t1 = makeTrade({ entryTime: 3000, exitTime: 4000 });
    const t2 = makeTrade({ entryTime: 1000, exitTime: 2000 });
    const t3 = makeTrade({ entryTime: 2000, exitTime: 3000, symbol: "ETHUSDT" });
    const merged = mergeRecords([t1], [t2], [t3]);
    expect(merged[0]!.entryTime).toBe(1000);
    expect(merged[1]!.entryTime).toBe(2000);
    expect(merged[2]!.entryTime).toBe(3000);
  });

  it("不同 symbol 的相同时间戳不视为重复", () => {
    const btc = makeTrade({ symbol: "BTCUSDT", entryTime: 1000, exitTime: 2000 });
    const eth = makeTrade({ symbol: "ETHUSDT", entryTime: 1000, exitTime: 2000 });
    const merged = mergeRecords([btc], [eth]);
    expect(merged).toHaveLength(2);
  });
});

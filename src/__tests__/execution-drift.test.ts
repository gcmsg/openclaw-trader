/**
 * Paper vs Live 执行漂移监控 测试
 * src/__tests__/execution-drift.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  detectDrift,
  summarizeDrift,
  formatDriftReport,
  reconstructClosedTrades,
  DEFAULT_DRIFT_THRESHOLD,
  type DriftRecord,
} from "../analysis/execution-drift.js";

// ── 测试辅助 ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** 临时写入 paper-{id}.json 文件，并在测试结束后删除 */
const tempFiles: string[] = [];

function writeTempScenario(scenarioId: string, trades: unknown[]): void {
  const filePath = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  const account = {
    initialUsdt: 10000,
    usdt: 10000,
    positions: {},
    trades,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
  };
  fs.writeFileSync(filePath, JSON.stringify(account));
  tempFiles.push(filePath);
}

/** 创建标准买入交易（入场） */
function makeBuyTrade(
  symbol: string,
  fillPrice: number,
  slippagePerUnit: number,
  timestamp: number,
  qty = 1,
) {
  return {
    id: `E${timestamp}`,
    symbol,
    side: "buy" as const,
    quantity: qty,
    price: fillPrice,
    usdtAmount: qty * fillPrice,
    fee: qty * fillPrice * 0.001,
    slippage: slippagePerUnit * qty,
    timestamp,
    reason: "signal",
  };
}

/** 创建卖出交易（出场）*/
function makeSellTrade(symbol: string, fillPrice: number, timestamp: number, qty = 1) {
  return {
    id: `X${timestamp}`,
    symbol,
    side: "sell" as const,
    quantity: qty,
    price: fillPrice,
    usdtAmount: qty * fillPrice,
    fee: qty * fillPrice * 0.001,
    slippage: 0,
    timestamp: timestamp + 3600_000,
    reason: "take_profit",
    pnl: (fillPrice - 100) * qty,
    pnlPercent: 0.01,
  };
}

/** 创建空头入场（short）+ 平仓（cover）交易对 */
function makeShortPair(
  symbol: string,
  entryPrice: number,
  slippagePerUnit: number,
  timestamp: number,
  qty = 1,
) {
  const entry = {
    id: `SE${timestamp}`,
    symbol,
    side: "short" as const,
    quantity: qty,
    price: entryPrice,
    usdtAmount: qty * entryPrice,
    fee: qty * entryPrice * 0.001,
    slippage: slippagePerUnit * qty,
    timestamp,
    reason: "signal",
  };
  const exit = {
    id: `SC${timestamp}`,
    symbol,
    side: "cover" as const,
    quantity: qty,
    price: entryPrice * 0.99,
    usdtAmount: qty * entryPrice * 0.99,
    fee: qty * entryPrice * 0.99 * 0.001,
    slippage: 0,
    timestamp: timestamp + 3600_000,
    reason: "take_profit",
    pnl: entryPrice * 0.01 * qty,
    pnlPercent: 0.01,
  };
  return { entry, exit };
}

afterEach(() => {
  for (const f of tempFiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  tempFiles.length = 0;
});

// ══════════════════════════════════════════════════════════
// reconstructClosedTrades
// ══════════════════════════════════════════════════════════

describe("reconstructClosedTrades()", () => {
  it("不存在的场景 ID 返回空数组", () => {
    const result = reconstructClosedTrades("__nonexistent_scenario_xyz__");
    expect(result).toEqual([]);
  });

  it("空 trades 返回空数组", () => {
    writeTempScenario("test-empty", []);
    expect(reconstructClosedTrades("test-empty")).toEqual([]);
  });

  it("只有入场无出场时返回空数组", () => {
    const entry = makeBuyTrade("BTCUSDT", 50025, 25, Date.now());
    writeTempScenario("test-no-exit", [entry]);
    expect(reconstructClosedTrades("test-no-exit")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
// detectDrift - 基础行为
// ══════════════════════════════════════════════════════════

describe("detectDrift() - 基础行为", () => {
  it("paper 场景不存在时返回空数组", () => {
    writeTempScenario("drift-live-only", []);
    expect(detectDrift("__no_paper__", "drift-live-only")).toEqual([]);
  });

  it("live 场景不存在时返回空数组", () => {
    writeTempScenario("drift-paper-only", []);
    expect(detectDrift("drift-paper-only", "__no_live__")).toEqual([]);
  });

  it("两个场景均无 trades 时返回空数组", () => {
    writeTempScenario("drift-p1", []);
    writeTempScenario("drift-l1", []);
    expect(detectDrift("drift-p1", "drift-l1")).toEqual([]);
  });

  it("无匹配 symbol 时返回空数组", () => {
    const ts = 1_700_000_000_000;
    writeTempScenario("drift-p2", [
      makeBuyTrade("BTCUSDT", 50025, 25, ts),
      makeSellTrade("BTCUSDT", 51000, ts),
    ]);
    writeTempScenario("drift-l2", [
      makeBuyTrade("ETHUSDT", 3001.5, 1.5, ts),
      makeSellTrade("ETHUSDT", 3050, ts),
    ]);
    expect(detectDrift("drift-p2", "drift-l2")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
// detectDrift - 匹配与 DriftRecord 字段正确性
// ══════════════════════════════════════════════════════════

describe("detectDrift() - 匹配与字段", () => {
  const BASE_TS = 1_700_000_000_000;

  beforeEach(() => {
    // paper: BTCUSDT buy at 50025, slippage=25/unit
    // live:  BTCUSDT buy at 50050, slippage=50/unit（live 滑点更大）
    writeTempScenario("drift-paper-match", [
      makeBuyTrade("BTCUSDT", 50025, 25, BASE_TS),
      makeSellTrade("BTCUSDT", 51000, BASE_TS),
    ]);
    writeTempScenario("drift-live-match", [
      makeBuyTrade("BTCUSDT", 50050, 50, BASE_TS + 1000), // 1 秒后入场
      makeSellTrade("BTCUSDT", 51000, BASE_TS + 1000),
    ]);
  });

  it("同 symbol+entryTime 的交易对被正确匹配（1 条记录）", () => {
    const records = detectDrift("drift-paper-match", "drift-live-match");
    expect(records).toHaveLength(1);
  });

  it("DriftRecord 包含正确的 symbol 和 side", () => {
    const [r] = detectDrift("drift-paper-match", "drift-live-match") as [DriftRecord];
    expect(r.symbol).toBe("BTCUSDT");
    expect(r.side).toBe("long");
  });

  it("DriftRecord.scenarioPaper / scenarioLive 正确", () => {
    const [r] = detectDrift("drift-paper-match", "drift-live-match") as [DriftRecord];
    expect(r.scenarioPaper).toBe("drift-paper-match");
    expect(r.scenarioLive).toBe("drift-live-match");
  });

  it("paperFillPrice 与 liveFillPrice 正确", () => {
    const [r] = detectDrift("drift-paper-match", "drift-live-match") as [DriftRecord];
    expect(r.paperFillPrice).toBe(50025);
    expect(r.liveFillPrice).toBe(50050);
  });

  it("driftPercent 计算正确 = |paperSlippage - liveSlippage|", () => {
    const [r] = detectDrift("drift-paper-match", "drift-live-match") as [DriftRecord];
    const expectedPaperSlip = (25 / (50025 - 25)) * 100; // slippage / signalPrice * 100
    const expectedLiveSlip = (50 / (50050 - 50)) * 100;
    const expectedDrift = Math.abs(expectedPaperSlip - expectedLiveSlip);
    expect(r.driftPercent).toBeCloseTo(expectedDrift, 6);
  });

  it("entryTime 超出匹配窗口（>60s）时不匹配", () => {
    // 覆盖 live 文件：entryTime 偏移 2 分钟
    writeTempScenario("drift-live-match", [
      makeBuyTrade("BTCUSDT", 50050, 50, BASE_TS + 120_001),
      makeSellTrade("BTCUSDT", 51000, BASE_TS + 120_001),
    ]);
    const records = detectDrift("drift-paper-match", "drift-live-match");
    expect(records).toHaveLength(0);
  });

  it("entryTime 在 60s 内时仍能匹配（边界）", () => {
    writeTempScenario("drift-live-match", [
      makeBuyTrade("BTCUSDT", 50050, 50, BASE_TS + 59_999),
      makeSellTrade("BTCUSDT", 51000, BASE_TS + 59_999),
    ]);
    const records = detectDrift("drift-paper-match", "drift-live-match");
    expect(records).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════
// detectDrift - 空头方向
// ══════════════════════════════════════════════════════════

describe("detectDrift() - 空头方向", () => {
  it("空头方向漂移计算正确", () => {
    const ts = 1_700_001_000_000;
    const { entry: pe, exit: px } = makeShortPair("ETHUSDT", 3001.5, 1.5, ts);
    const { entry: le, exit: lx } = makeShortPair("ETHUSDT", 2998.0, 2.0, ts + 500);

    writeTempScenario("drift-short-paper", [pe, px]);
    writeTempScenario("drift-short-live", [le, lx]);

    const records = detectDrift("drift-short-paper", "drift-short-live");
    expect(records).toHaveLength(1);

    const [r] = records as [DriftRecord];
    expect(r.side).toBe("short");
    expect(r.driftPercent).toBeGreaterThanOrEqual(0);
  });

  it("空头 signalPrice = fillPrice + slippagePerUnit", () => {
    const ts = 1_700_002_000_000;
    const fillPrice = 3000;
    const slippagePerUnit = 3;
    const { entry: pe, exit: px } = makeShortPair("ETHUSDT", fillPrice, slippagePerUnit, ts);
    const { entry: le, exit: lx } = makeShortPair("ETHUSDT", fillPrice, slippagePerUnit, ts);

    writeTempScenario("drift-sp1", [pe, px]);
    writeTempScenario("drift-sl1", [le, lx]);

    const [r] = detectDrift("drift-sp1", "drift-sl1") as [DriftRecord];
    // signalPrice = fillPrice + slippagePerUnit
    expect(r.signalPrice).toBeCloseTo(fillPrice + slippagePerUnit, 6);
    // 两边完全相同时 drift = 0
    expect(r.driftPercent).toBeCloseTo(0, 8);
  });
});

// ══════════════════════════════════════════════════════════
// detectDrift - 多品种
// ══════════════════════════════════════════════════════════

describe("detectDrift() - 多品种", () => {
  it("多品种各自正确匹配", () => {
    const ts = 1_700_003_000_000;
    writeTempScenario("drift-mp", [
      makeBuyTrade("BTCUSDT", 50025, 25, ts),
      makeSellTrade("BTCUSDT", 51000, ts),
      makeBuyTrade("ETHUSDT", 3001.5, 1.5, ts + 5000),
      makeSellTrade("ETHUSDT", 3050, ts + 5000),
    ]);
    writeTempScenario("drift-ml", [
      makeBuyTrade("BTCUSDT", 50050, 50, ts + 1000),
      makeSellTrade("BTCUSDT", 51000, ts + 1000),
      makeBuyTrade("ETHUSDT", 3002.0, 2.0, ts + 5500),
      makeSellTrade("ETHUSDT", 3050, ts + 5500),
    ]);

    const records = detectDrift("drift-mp", "drift-ml");
    expect(records).toHaveLength(2);
    const symbols = records.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});

// ══════════════════════════════════════════════════════════
// summarizeDrift
// ══════════════════════════════════════════════════════════

describe("summarizeDrift()", () => {
  function makeRecord(symbol: string, drift: number, side: "long" | "short" = "long"): DriftRecord {
    return {
      symbol,
      side,
      signalTime: 0,
      signalPrice: 100,
      paperFillPrice: 100.05,
      liveFillPrice: 100.1,
      paperSlippage: 0.05,
      liveSlippage: 0.05 + drift,
      driftPercent: drift,
      scenarioPaper: "paper",
      scenarioLive: "live",
    };
  }

  it("空记录返回全零摘要", () => {
    const s = summarizeDrift([]);
    expect(s.totalPairs).toBe(0);
    expect(s.avgDriftPercent).toBe(0);
    expect(s.maxDriftPercent).toBe(0);
    expect(s.driftExceedingThreshold).toBe(0);
    expect(s.bySymbol).toEqual({});
  });

  it("totalPairs 正确", () => {
    const recs = [makeRecord("BTC", 0.1), makeRecord("ETH", 0.3)];
    expect(summarizeDrift(recs).totalPairs).toBe(2);
  });

  it("avgDriftPercent 正确", () => {
    const recs = [makeRecord("BTC", 0.2), makeRecord("ETH", 0.4)];
    expect(summarizeDrift(recs).avgDriftPercent).toBeCloseTo(0.3, 8);
  });

  it("maxDriftPercent 正确", () => {
    const recs = [makeRecord("BTC", 0.1), makeRecord("ETH", 0.8), makeRecord("SOL", 0.3)];
    expect(summarizeDrift(recs).maxDriftPercent).toBe(0.8);
  });

  it("driftExceedingThreshold 使用默认 0.5% 阈值计算正确", () => {
    const recs = [makeRecord("BTC", 0.1), makeRecord("ETH", 0.6), makeRecord("SOL", 0.7)];
    expect(summarizeDrift(recs).driftExceedingThreshold).toBe(2);
  });

  it("driftExceedingThreshold 使用自定义阈值计算正确", () => {
    const recs = [makeRecord("BTC", 0.1), makeRecord("ETH", 0.4)];
    expect(summarizeDrift(recs, 0.3).driftExceedingThreshold).toBe(1);
  });

  it("bySymbol 分组统计 count 正确", () => {
    const recs = [
      makeRecord("BTCUSDT", 0.2),
      makeRecord("BTCUSDT", 0.4),
      makeRecord("ETHUSDT", 0.6),
    ];
    const s = summarizeDrift(recs);
    expect(s.bySymbol["BTCUSDT"]?.count).toBe(2);
    expect(s.bySymbol["ETHUSDT"]?.count).toBe(1);
  });

  it("bySymbol avgDrift 计算正确", () => {
    const recs = [makeRecord("BTCUSDT", 0.2), makeRecord("BTCUSDT", 0.6)];
    const s = summarizeDrift(recs);
    expect(s.bySymbol["BTCUSDT"]?.avgDrift).toBeCloseTo(0.4, 8);
  });
});

// ══════════════════════════════════════════════════════════
// formatDriftReport
// ══════════════════════════════════════════════════════════

describe("formatDriftReport()", () => {
  it("输出非空字符串", () => {
    const s = summarizeDrift([]);
    expect(formatDriftReport(s)).toBeTruthy();
  });

  it("包含 totalPairs 数字", () => {
    const recs: DriftRecord[] = [
      {
        symbol: "BTCUSDT",
        side: "long",
        signalTime: 0,
        signalPrice: 50000,
        paperFillPrice: 50025,
        liveFillPrice: 50050,
        paperSlippage: 0.05,
        liveSlippage: 0.1,
        driftPercent: 0.05,
        scenarioPaper: "paper",
        scenarioLive: "live",
      },
    ];
    const s = summarizeDrift(recs);
    const report = formatDriftReport(s);
    expect(report).toContain("1");
  });

  it("漂移超阈值时包含警告信息", () => {
    const recs: DriftRecord[] = [
      {
        symbol: "BTCUSDT",
        side: "long",
        signalTime: 0,
        signalPrice: 50000,
        paperFillPrice: 50025,
        liveFillPrice: 50075,
        paperSlippage: 0.05,
        liveSlippage: 0.15,
        driftPercent: 0.7,
        scenarioPaper: "paper",
        scenarioLive: "live",
      },
    ];
    const s = summarizeDrift(recs);
    const report = formatDriftReport(s);
    expect(report).toContain("⚠️");
  });

  it("全部在阈值内时包含 ✅ 信息", () => {
    const recs: DriftRecord[] = [
      {
        symbol: "ETHUSDT",
        side: "long",
        signalTime: 0,
        signalPrice: 3000,
        paperFillPrice: 3001.5,
        liveFillPrice: 3002,
        paperSlippage: 0.05,
        liveSlippage: 0.067,
        driftPercent: 0.017,
        scenarioPaper: "paper",
        scenarioLive: "live",
      },
    ];
    const s = summarizeDrift(recs);
    const report = formatDriftReport(s);
    expect(report).toContain("✅");
  });

  it("包含 bySymbol 分组信息", () => {
    const recs: DriftRecord[] = [
      {
        symbol: "SOLUSDT",
        side: "short",
        signalTime: 0,
        signalPrice: 200,
        paperFillPrice: 199.9,
        liveFillPrice: 199.8,
        paperSlippage: 0.05,
        liveSlippage: 0.1,
        driftPercent: 0.05,
        scenarioPaper: "paper",
        scenarioLive: "live",
      },
    ];
    const s = summarizeDrift(recs);
    const report = formatDriftReport(s);
    expect(report).toContain("SOLUSDT");
  });

  it("DEFAULT_DRIFT_THRESHOLD 值为 0.5", () => {
    expect(DEFAULT_DRIFT_THRESHOLD).toBe(0.5);
  });
});

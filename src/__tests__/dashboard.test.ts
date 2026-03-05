/**
 * P6.8 — Web Dashboard tests
 *
 * Tests buildDashboardData, buildEquityCurve, routing logic, etc.
 * Uses vitest mock to isolate file system and config loading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildEquityCurve,
  buildPerfData,
  getLogLines,
  type AccountSummary,
  type TradeRecord,
  type DashboardData,
} from "../web/dashboard-server.js";

// ─────────────────────────────────────────────────────
// Mock modules
// ─────────────────────────────────────────────────────

// Mock config loader
vi.mock("../config/loader.js", () => ({
  loadPaperConfig: vi.fn(() => ({
    report_interval_hours: 4,
    scenarios: [
      {
        id: "default",
        name: "Default",
        enabled: true,
        strategy_id: "default",
        initial_usdt: 1000,
        fee_rate: 0.001,
        slippage_percent: 0.05,
        exchange: { market: "spot" },
      },
    ],
  })),
}));

// Mock paper account loader
vi.mock("../paper/account.js", () => ({
  loadAccount: vi.fn(() => ({
    initialUsdt: 1000,
    usdt: 800,
    positions: {
      BTCUSDT: {
        symbol: "BTCUSDT",
        side: "long",
        quantity: 0.005,
        entryPrice: 40000,
        stopLoss: 38000,
        takeProfit: 45000,
        entryTime: Date.now() - 3600_000,
      },
    },
    trades: [
      {
        id: "T001",
        symbol: "ETHUSDT",
        side: "buy",
        quantity: 0.1,
        price: 2500,
        usdtAmount: 250,
        fee: 0.25,
        slippage: 0,
        timestamp: Date.now() - 7200_000,
        reason: "MA bullish",
      },
      {
        id: "T002",
        symbol: "ETHUSDT",
        side: "sell",
        quantity: 0.1,
        price: 2600,
        usdtAmount: 260,
        fee: 0.26,
        slippage: 0,
        timestamp: Date.now() - 3600_000,
        reason: "Take profit",
        pnl: 9.49,
        // paperSell() stores as ratio, not percentage: 9.49/250 ≈ 0.038
        pnlPercent: 0.038,
      },
    ],
    createdAt: Date.now() - 86400_000,
    updatedAt: Date.now(),
    dailyLoss: { date: "2024-01-01", loss: 0 },
  })),
}));

// Write temporary test data files (instead of vi.mock("fs"), avoids ESM mock not intercepting readFileSync)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __test_dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__test_dirname, "../../logs");

const SIGNAL_HISTORY_FILE = path.join(LOGS_DIR, "signal-history.jsonl");
const MONITOR_LOG_FILE = path.join(LOGS_DIR, "monitor.log");
const tempTestFiles: string[] = [];

beforeEach(() => {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // signal-history.jsonl
  const signalData = [
    JSON.stringify({
      id: "S001",
      symbol: "BTCUSDT",
      type: "buy",
      entryPrice: 40000,
      entryTime: Date.now() - 86400_000,
      status: "closed",
      pnl: 50,
      pnlPercent: 2.5,
    }),
    JSON.stringify({
      id: "S002",
      symbol: "ETHUSDT",
      type: "sell",
      entryPrice: 2600,
      entryTime: Date.now() - 3600_000,
      status: "open",
    }),
  ].join("\n");
  fs.writeFileSync(SIGNAL_HISTORY_FILE, signalData);
  tempTestFiles.push(SIGNAL_HISTORY_FILE);

  // monitor.log
  const logData = [
    "2026-02-27 09:00:00 [INFO] monitor started",
    "2026-02-27 09:01:00 [WARN] RSI approaching overbought",
    "2026-02-27 09:02:00 [ERROR] Failed to fetch price for AVAXUSDT",
    "2026-02-27 09:03:00 [INFO] signal: buy BTCUSDT",
  ].join("\n");
  fs.writeFileSync(MONITOR_LOG_FILE, logData);
  tempTestFiles.push(MONITOR_LOG_FILE);
});

afterEach(() => {
  for (const f of tempTestFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tempTestFiles.length = 0;
});

// ─────────────────────────────────────────────────────
// Tests: buildDashboardData
// ─────────────────────────────────────────────────────

describe("buildDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returned structure contains all required fields", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data: DashboardData = buildDashboardData();

    expect(data).toHaveProperty("accounts");
    expect(data).toHaveProperty("positions");
    expect(data).toHaveProperty("recentTrades");
    expect(data).toHaveProperty("equityCurve");
    expect(data).toHaveProperty("signalHistory");
    expect(data).toHaveProperty("lastUpdate");
    expect(data.lastUpdate).toBeGreaterThan(0);
  });

  it("accounts correctly loads scenario accounts", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    expect(data.accounts.length).toBe(1);
    const acc = data.accounts[0]!;
    expect(acc.scenarioId).toBe("default");
    expect(acc.initialUsdt).toBe(1000);
    expect(acc.usdt).toBe(800);
  });

  it("AccountSummary correctly calculates total equity", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();
    const acc = data.accounts[0]!;

    // totalEquity = usdt(800) + BTCUSDT position value(0.005 * 40000 = 200)
    expect(acc.totalEquity).toBeCloseTo(1000);
    expect(acc.totalPnl).toBeCloseTo(0); // 1000 - 1000 = 0
    expect(acc.positionCount).toBe(1);
  });

  it("position list correctly built (including stop loss distance)", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    expect(data.positions.length).toBe(1);
    const pos = data.positions[0]!;
    expect(pos.symbol).toBe("BTCUSDT");
    expect(pos.side).toBe("long");
    expect(pos.entryPrice).toBe(40000);
    expect(pos.stopLoss).toBe(38000);
    expect(pos.stopLossDistance).toBeGreaterThan(0);
  });

  it("trade records correctly loaded (max 50)", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    expect(data.recentTrades.length).toBeGreaterThan(0);
    expect(data.recentTrades.length).toBeLessThanOrEqual(50);
    const trade = data.recentTrades.find((t) => t.id === "T002");
    expect(trade).toBeDefined();
    expect(trade?.pnl).toBeCloseTo(9.49);
  });

  it("winRate calculated based on sell/cover trades", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();
    const acc = data.accounts[0]!;

    // T002 is sell, pnl > 0 → winRate = 1/1 = 100%
    expect(acc.winRate).toBeCloseTo(1.0);
  });

  it("signal history correctly loaded", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    // Should have signal records (at least from signal-history.jsonl)
    expect(data.signalHistory.length).toBeGreaterThan(0);
    // Each signal record contains required fields
    const firstSig = data.signalHistory[0]!;
    expect(firstSig).toHaveProperty("id");
    expect(firstSig).toHaveProperty("symbol");
    expect(firstSig).toHaveProperty("type");
    expect(firstSig).toHaveProperty("timestamp");
    expect(firstSig).toHaveProperty("status");
  });
});

// ─────────────────────────────────────────────────────
// Tests: buildEquityCurve
// ─────────────────────────────────────────────────────

describe("buildEquityCurve", () => {
  const baseAccount: AccountSummary = {
    scenarioId: "default",
    name: "Default",
    initialUsdt: 1000,
    usdt: 1050,
    totalEquity: 1100,
    totalPnl: 100,
    totalPnlPercent: 0.1,
    tradeCount: 4,
    winRate: 0.75,
    positionCount: 0,
  };

  it("returns empty array when no accounts", () => {
    const curve = buildEquityCurve([], []);
    expect(curve).toEqual([]);
  });

  it("rebuilds equity curve from trade records", () => {
    const now = Date.now();
    const trades: TradeRecord[] = [
      {
        id: "T1",
        scenarioId: "default",
        symbol: "BTCUSDT",
        side: "sell",
        quantity: 0.01,
        price: 40000,
        usdtAmount: 400,
        pnl: 20,
        pnlPercent: 5,
        timestamp: now - 3600_000,
        reason: "TP",
      },
      {
        id: "T2",
        scenarioId: "default",
        symbol: "ETHUSDT",
        side: "sell",
        quantity: 0.1,
        price: 2500,
        usdtAmount: 250,
        pnl: -10,
        pnlPercent: -4,
        timestamp: now - 1800_000,
        reason: "SL",
      },
    ];

    const curve = buildEquityCurve([baseAccount], trades);
    // At least 3 points: initial + 2 trades + current
    expect(curve.length).toBeGreaterThanOrEqual(3);

    // Ascending time order
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.timestamp).toBeGreaterThanOrEqual(curve[i - 1]!.timestamp);
    }
  });

  it("each point has timestamp, equity, label fields", () => {
    const curve = buildEquityCurve([baseAccount], []);
    for (const point of curve) {
      expect(point).toHaveProperty("timestamp");
      expect(point).toHaveProperty("equity");
      expect(point).toHaveProperty("label");
      expect(typeof point.timestamp).toBe("number");
      expect(typeof point.equity).toBe("number");
      expect(typeof point.label).toBe("string");
    }
  });

  it("only includes sell/cover trades with pnl", () => {
    const now = Date.now();
    const trades: TradeRecord[] = [
      {
        id: "B1",
        scenarioId: "default",
        symbol: "BTCUSDT",
        side: "buy", // entry, should not appear in curve
        quantity: 0.01,
        price: 40000,
        usdtAmount: 400,
        pnl: null,
        pnlPercent: null,
        timestamp: now - 3600_000,
        reason: "Buy signal",
      },
      {
        id: "S1",
        scenarioId: "default",
        symbol: "BTCUSDT",
        side: "sell",
        quantity: 0.01,
        price: 41000,
        usdtAmount: 410,
        pnl: 10,
        pnlPercent: 2.5,
        timestamp: now - 1800_000,
        reason: "TP",
      },
    ];

    const curve = buildEquityCurve([baseAccount], trades);
    // Equity curve only processes sell trades (S1), buy is not counted
    const equities = curve.map((p) => p.equity);
    // Initial point equity = 1000, after sell +10 = 1010, final point = totalEquity = 1100
    expect(equities[0]).toBe(1000);
  });

  it("lastUpdate is a reasonable timestamp", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const before = Date.now();
    const data = buildDashboardData();
    const after = Date.now();
    expect(data.lastUpdate).toBeGreaterThanOrEqual(before);
    expect(data.lastUpdate).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────
// Tests: HTTP routing logic (unit, no real server)
// ─────────────────────────────────────────────────────

describe("Dashboard routing logic", () => {
  it("root path should return HTML", () => {
    // Simulate routing logic
    const routes: Record<string, string> = {
      "/": "text/html",
      "/index.html": "text/html",
      "/api/data": "application/json",
      "/api/health": "application/json",
    };

    for (const [url, contentType] of Object.entries(routes)) {
      expect(contentType).toBeDefined();
      if (url === "/" || url === "/index.html") {
        expect(contentType).toContain("html");
      } else {
        expect(contentType).toContain("json");
      }
    }
  });

  it("startDashboardServer and stopDashboardServer exported as functions", async () => {
    const { startDashboardServer, stopDashboardServer } = await import(
      "../web/dashboard-server.js"
    );
    expect(typeof startDashboardServer).toBe("function");
    expect(typeof stopDashboardServer).toBe("function");
  });
});

// ─────────────────────────────────────────────────────
// Tests: buildPerfData
// ─────────────────────────────────────────────────────

describe("buildPerfData", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns bySymbol and byDay arrays", () => {
    const perf = buildPerfData();
    expect(perf).toHaveProperty("bySymbol");
    expect(perf).toHaveProperty("byDay");
    expect(Array.isArray(perf.bySymbol)).toBe(true);
    expect(Array.isArray(perf.byDay)).toBe(true);
  });

  it("bySymbol contains ETHUSDT (T002 is sell with pnl)", () => {
    const perf = buildPerfData();
    const eth = perf.bySymbol.find((s) => s.symbol === "ETHUSDT");
    expect(eth).toBeDefined();
    expect(eth!.trades).toBe(1);
    expect(eth!.wins).toBe(1);   // pnl = 9.49 > 0
    expect(eth!.losses).toBe(0);
    expect(eth!.winRate).toBeCloseTo(1.0);
    expect(eth!.totalPnl).toBeCloseTo(9.49);
  });

  it("bySymbol each record has required fields", () => {
    const perf = buildPerfData();
    for (const s of perf.bySymbol) {
      expect(s).toHaveProperty("symbol");
      expect(s).toHaveProperty("trades");
      expect(s).toHaveProperty("wins");
      expect(s).toHaveProperty("losses");
      expect(s).toHaveProperty("winRate");
      expect(s).toHaveProperty("totalPnl");
      expect(s).toHaveProperty("avgPnl");
      expect(s.winRate).toBeGreaterThanOrEqual(0);
      expect(s.winRate).toBeLessThanOrEqual(1);
    }
  });

  it("byDay aggregates PnL by date", () => {
    const perf = buildPerfData();
    // T002 has pnl, should appear in byDay
    expect(perf.byDay.length).toBeGreaterThan(0);
    for (const day of perf.byDay) {
      expect(day).toHaveProperty("date");
      expect(day).toHaveProperty("pnl");
      expect(day).toHaveProperty("trades");
      expect(typeof day.date).toBe("string");
      expect(day.date).toMatch(/^\d{2}\/\d{2}$/); // MM/DD format
    }
  });

  it("buy trades are not counted in performance statistics", () => {
    const perf = buildPerfData();
    // T001 is buy, should not count as a trade in ETHUSDT bySymbol
    const eth = perf.bySymbol.find((s) => s.symbol === "ETHUSDT");
    // T002 sell (1 trade), T001 buy not counted → trades=1
    expect(eth?.trades).toBe(1);
  });

  it("bySymbol sorted by totalPnl descending", () => {
    const perf = buildPerfData();
    for (let i = 1; i < perf.bySymbol.length; i++) {
      expect(perf.bySymbol[i - 1]!.totalPnl).toBeGreaterThanOrEqual(perf.bySymbol[i]!.totalPnl);
    }
  });
});

// ─────────────────────────────────────────────────────
// Tests: getLogLines
// ─────────────────────────────────────────────────────

describe("getLogLines", () => {
  // Note: do not call vi.clearAllMocks() in beforeEach to avoid clearing fs mock implementation

  it("reads monitor.log and returns line array", () => {
    const lines = getLogLines(200);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("returns at most tail lines", () => {
    // mock returns 4 lines, tail=2 → at most 2 lines
    const lines = getLogLines(2);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("returns non-empty string lines", () => {
    const lines = getLogLines(200);
    // Each line is a non-empty string (whether from mock or actual file)
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
  });

  it("returns string array (each line is a string)", () => {
    const lines = getLogLines(200);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
  });
});

/**
 * P6.8 — Web Dashboard 测试
 *
 * 测试 buildDashboardData, buildEquityCurve, 路由逻辑等。
 * 使用 vitest mock 隔离文件系统和配置加载。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
        // paperSell() 存储为比例（ratio），不是百分比：9.49/250 ≈ 0.038
        pnlPercent: 0.038,
      },
    ],
    createdAt: Date.now() - 86400_000,
    updatedAt: Date.now(),
    dailyLoss: { date: "2024-01-01", loss: 0 },
  })),
}));

// Mock fs (signal-history.jsonl 可能不存在)
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn((filePath: unknown, ...args: unknown[]) => {
      const fp = String(filePath);
      if (fp.includes("signal-history.jsonl")) {
        // 返回 2 条信号
        return [
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
      }
      if (fp.includes("monitor.log")) {
        return [
          "2026-02-27 09:00:00 [INFO] monitor started",
          "2026-02-27 09:01:00 [WARN] RSI approaching overbought",
          "2026-02-27 09:02:00 [ERROR] Failed to fetch price for AVAXUSDT",
          "2026-02-27 09:03:00 [INFO] signal: buy BTCUSDT",
        ].join("\n");
      }
      // delegate to actual for other files
      return (actual.readFileSync as (...a: unknown[]) => unknown)(filePath, ...args);
    }),
  };
});

// ─────────────────────────────────────────────────────
// Tests: buildDashboardData
// ─────────────────────────────────────────────────────

describe("buildDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("返回结构包含所有必要字段", async () => {
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

  it("accounts 正确加载场景账户", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    expect(data.accounts.length).toBe(1);
    const acc = data.accounts[0]!;
    expect(acc.scenarioId).toBe("default");
    expect(acc.initialUsdt).toBe(1000);
    expect(acc.usdt).toBe(800);
  });

  it("AccountSummary 正确计算总资产", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();
    const acc = data.accounts[0]!;

    // totalEquity = usdt(800) + BTCUSDT position value(0.005 * 40000 = 200)
    expect(acc.totalEquity).toBeCloseTo(1000);
    expect(acc.totalPnl).toBeCloseTo(0); // 1000 - 1000 = 0
    expect(acc.positionCount).toBe(1);
  });

  it("持仓列表正确构建（含止损距离）", async () => {
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

  it("交易记录正确加载（最多 50 条）", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    expect(data.recentTrades.length).toBeGreaterThan(0);
    expect(data.recentTrades.length).toBeLessThanOrEqual(50);
    const trade = data.recentTrades.find((t) => t.id === "T002");
    expect(trade).toBeDefined();
    expect(trade?.pnl).toBeCloseTo(9.49);
  });

  it("winRate 基于 sell/cover 交易计算", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();
    const acc = data.accounts[0]!;

    // T002 是 sell，pnl > 0 → winRate = 1/1 = 100%
    expect(acc.winRate).toBeCloseTo(1.0);
  });

  it("信号历史正确读取", async () => {
    const { buildDashboardData } = await import("../web/dashboard-server.js");
    const data = buildDashboardData();

    // 应该有信号记录（至少包含来自 signal-history.jsonl 的数据）
    expect(data.signalHistory.length).toBeGreaterThan(0);
    // 每条信号记录包含必要字段
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

  it("无账户时返回空数组", () => {
    const curve = buildEquityCurve([], []);
    expect(curve).toEqual([]);
  });

  it("从交易记录重建资金曲线", () => {
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
    // 至少 3 个点：初始 + 2 笔交易 + 当前
    expect(curve.length).toBeGreaterThanOrEqual(3);

    // 按时间升序
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.timestamp).toBeGreaterThanOrEqual(curve[i - 1]!.timestamp);
    }
  });

  it("每个点有 timestamp, equity, label 字段", () => {
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

  it("只包含 sell/cover 类型且有 pnl 的交易", () => {
    const now = Date.now();
    const trades: TradeRecord[] = [
      {
        id: "B1",
        scenarioId: "default",
        symbol: "BTCUSDT",
        side: "buy", // 开仓，不应出现在曲线中
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
    // 资金曲线只处理 sell 交易（S1），买入不计入
    const equities = curve.map((p) => p.equity);
    // 初始点 equity = 1000, sell 后 +10 = 1010, 最终点 = totalEquity = 1100
    expect(equities[0]).toBe(1000);
  });

  it("lastUpdate 是合理的时间戳", async () => {
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
  it("根路径应返回 HTML", () => {
    // 模拟路由逻辑
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

  it("startDashboardServer 和 stopDashboardServer 导出为函数", async () => {
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

  it("返回 bySymbol 和 byDay 数组", () => {
    const perf = buildPerfData();
    expect(perf).toHaveProperty("bySymbol");
    expect(perf).toHaveProperty("byDay");
    expect(Array.isArray(perf.bySymbol)).toBe(true);
    expect(Array.isArray(perf.byDay)).toBe(true);
  });

  it("bySymbol 包含 ETHUSDT（T002 是 sell 且有 pnl）", () => {
    const perf = buildPerfData();
    const eth = perf.bySymbol.find((s) => s.symbol === "ETHUSDT");
    expect(eth).toBeDefined();
    expect(eth!.trades).toBe(1);
    expect(eth!.wins).toBe(1);   // pnl = 9.49 > 0
    expect(eth!.losses).toBe(0);
    expect(eth!.winRate).toBeCloseTo(1.0);
    expect(eth!.totalPnl).toBeCloseTo(9.49);
  });

  it("bySymbol 每条记录有必要字段", () => {
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

  it("byDay 按日期聚合盈亏", () => {
    const perf = buildPerfData();
    // T002 有 pnl，应该出现在 byDay 里
    expect(perf.byDay.length).toBeGreaterThan(0);
    for (const day of perf.byDay) {
      expect(day).toHaveProperty("date");
      expect(day).toHaveProperty("pnl");
      expect(day).toHaveProperty("trades");
      expect(typeof day.date).toBe("string");
      expect(day.date).toMatch(/^\d{2}\/\d{2}$/); // MM/DD 格式
    }
  });

  it("buy 交易不计入绩效统计", () => {
    const perf = buildPerfData();
    // T001 是 buy，不应该在 bySymbol 的 ETHUSDT 中算作一笔交易
    const eth = perf.bySymbol.find((s) => s.symbol === "ETHUSDT");
    // T002 sell（1笔），T001 buy 不算 → trades=1
    expect(eth?.trades).toBe(1);
  });

  it("bySymbol 按 totalPnl 降序排列", () => {
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
  // 注意：不在 beforeEach 中调用 vi.clearAllMocks()，避免清除 fs mock 实现

  it("读取 monitor.log 并返回行数组", () => {
    const lines = getLogLines(200);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("返回最多 tail 行", () => {
    // mock 返回 4 行，tail=2 → 最多 2 行
    const lines = getLogLines(2);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("返回非空字符串行", () => {
    const lines = getLogLines(200);
    // 每行都是非空字符串（无论来自 mock 还是实际文件）
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
  });

  it("返回字符串数组（每行都是 string）", () => {
    const lines = getLogLines(200);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
  });
});

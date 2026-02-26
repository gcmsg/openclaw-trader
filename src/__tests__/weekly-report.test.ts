/**
 * 每周绩效报告测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uniqueId(): string {
  return `weekly-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeAccountFile(scenarioId: string, overrides: Record<string, unknown> = {}): void {
  const accountPath = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const account = {
    initialUsdt: 1000,
    usdt: 1100,
    positions: {},
    trades: [],
    createdAt: Date.now() - 7 * 24 * 3600000,
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    ...overrides,
  };
  fs.writeFileSync(accountPath, JSON.stringify(account), "utf-8");
}

function cleanupFiles(scenarioId: string): void {
  const files = [
    path.join(LOGS_DIR, `paper-${scenarioId}.json`),
    path.join(LOGS_DIR, `equity-history-${scenarioId}.jsonl`),
    path.join(LOGS_DIR, `reports/equity-${scenarioId}-${new Date().toISOString().slice(0, 10)}.svg`),
  ];
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
}

// ─── equity-tracker ───────────────────────────────────────────────────────────

import {
  recordEquitySnapshot,
  loadEquityHistory,
  getEquityHistoryPath,
} from "../report/equity-tracker.js";

describe("recordEquitySnapshot()", () => {
  let sid: string;

  beforeEach(() => {
    sid = uniqueId();
  });

  afterEach(() => {
    try { fs.unlinkSync(getEquityHistoryPath(sid)); } catch { /* ignore */ }
  });

  it("写入 JSONL 文件", () => {
    recordEquitySnapshot(sid, 1000, 0);
    const p = getEquityHistoryPath(sid);
    expect(fs.existsSync(p)).toBe(true);
    const line = fs.readFileSync(p, "utf-8").trim();
    expect(line).not.toBe("");
    const data = JSON.parse(line) as { equity: number; positions: number };
    expect(data.equity).toBe(1000);
    expect(data.positions).toBe(0);
  });

  it("写入包含 timestamp 字段", () => {
    const before = Date.now();
    recordEquitySnapshot(sid, 2500, 3);
    const after = Date.now();
    const p = getEquityHistoryPath(sid);
    const data = JSON.parse(fs.readFileSync(p, "utf-8").trim()) as { timestamp: number };
    expect(data.timestamp).toBeGreaterThanOrEqual(before);
    expect(data.timestamp).toBeLessThanOrEqual(after);
  });

  it("1 小时内第 2 次调用不写入（限频）", () => {
    recordEquitySnapshot(sid, 1000, 0);
    const p = getEquityHistoryPath(sid);
    const contentBefore = fs.readFileSync(p, "utf-8");
    recordEquitySnapshot(sid, 1200, 1);
    const contentAfter = fs.readFileSync(p, "utf-8");
    expect(contentAfter).toBe(contentBefore); // no new line
  });

  it("超过 1 小时后允许再次写入", () => {
    // Manually write an old snapshot
    const p = getEquityHistoryPath(sid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const old = { timestamp: Date.now() - 2 * 3600 * 1000, equity: 900, positions: 0 };
    fs.writeFileSync(p, JSON.stringify(old) + "\n", "utf-8");

    recordEquitySnapshot(sid, 1000, 0);
    const lines = fs.readFileSync(p, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("第一次写入（文件不存在）正常创建", () => {
    const p = getEquityHistoryPath(sid);
    expect(fs.existsSync(p)).toBe(false);
    recordEquitySnapshot(sid, 500, 2);
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe("loadEquityHistory()", () => {
  let sid: string;

  beforeEach(() => {
    sid = uniqueId();
    const p = getEquityHistoryPath(sid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const now = Date.now();
    const lines = [
      JSON.stringify({ timestamp: now - 10 * 24 * 3600000, equity: 900, positions: 0 }),
      JSON.stringify({ timestamp: now - 5 * 24 * 3600000, equity: 950, positions: 1 }),
      JSON.stringify({ timestamp: now - 1 * 24 * 3600000, equity: 1000, positions: 2 }),
    ];
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  });

  afterEach(() => {
    try { fs.unlinkSync(getEquityHistoryPath(sid)); } catch { /* ignore */ }
  });

  it("加载全部历史（无过滤）", () => {
    const history = loadEquityHistory(sid);
    expect(history.length).toBe(3);
  });

  it("按时间过滤（sinceDaysAgo=7）", () => {
    const history = loadEquityHistory(sid, 7);
    expect(history.length).toBe(2); // only 5-day and 1-day entries
  });

  it("按时间过滤（sinceDaysAgo=2）", () => {
    const history = loadEquityHistory(sid, 2);
    expect(history.length).toBe(1);
  });

  it("返回结果按时间戳升序排列", () => {
    const history = loadEquityHistory(sid);
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.timestamp).toBeGreaterThanOrEqual(prev.timestamp);
      }
    }
  });

  it("文件不存在时返回空数组", () => {
    const history = loadEquityHistory("nonexistent-scenario-xyz");
    expect(history).toEqual([]);
  });

  it("每条记录包含 timestamp、equity、positions 字段", () => {
    const history = loadEquityHistory(sid);
    for (const entry of history) {
      expect(typeof entry.timestamp).toBe("number");
      expect(typeof entry.equity).toBe("number");
      expect(typeof entry.positions).toBe("number");
    }
  });
});

// ─── equity-chart ─────────────────────────────────────────────────────────────

import { generateEquityChart, generateAsciiChart } from "../report/equity-chart.js";

describe("generateEquityChart()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-chart-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("生成 SVG 文件（文件存在）", async () => {
    const points = [
      { timestamp: Date.now() - 3600000, equity: 1000 },
      { timestamp: Date.now(), equity: 1050 },
    ];
    const out = path.join(tmpDir, "chart.svg");
    const result = await generateEquityChart(points, "Test Chart", out);
    expect(fs.existsSync(result)).toBe(true);
  });

  it("返回值为输出文件路径", async () => {
    const out = path.join(tmpDir, "chart2.svg");
    const result = await generateEquityChart(
      [{ timestamp: Date.now(), equity: 1000 }],
      "Single Point",
      out
    );
    expect(result).toBe(out);
  });

  it("空数据点 → 生成空图表文件（不抛异常）", async () => {
    const out = path.join(tmpDir, "empty.svg");
    await expect(generateEquityChart([], "Empty", out)).resolves.toBe(out);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("SVG 文件内容包含标题", async () => {
    const out = path.join(tmpDir, "titled.svg");
    await generateEquityChart(
      [{ timestamp: Date.now() - 1000, equity: 1000 },
       { timestamp: Date.now(), equity: 1100 }],
      "My Title",
      out
    );
    const content = fs.readFileSync(out, "utf-8");
    expect(content).toContain("My Title");
  });
});

describe("generateAsciiChart()", () => {
  it("非空数据 → 输出非空字符串", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() + i * 3600000,
      equity: 1000 + i * 10,
    }));
    const result = generateAsciiChart(points);
    expect(result).not.toBe("");
    expect(result).not.toBe("(no data)");
  });

  it("空数据 → 返回 '(no data)'", () => {
    expect(generateAsciiChart([])).toBe("(no data)");
  });

  it("返回字符串包含多行", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() + i * 3600000,
      equity: 1000 + Math.sin(i) * 50,
    }));
    const result = generateAsciiChart(points, 5);
    expect(result.split("\n").length).toBe(5);
  });
});

// ─── weekly-report ────────────────────────────────────────────────────────────

import { generateWeeklyReport, formatWeeklyReport, type WeeklyReportData } from "../report/weekly-report.js";

describe("generateWeeklyReport()", () => {
  let sid: string;

  beforeEach(() => {
    sid = uniqueId();
    makeAccountFile(sid);
  });

  afterEach(() => {
    cleanupFiles(sid);
  });

  it("返回正确的 WeeklyReportData 结构", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report).toHaveProperty("period");
    expect(report).toHaveProperty("scenarioId", sid);
    expect(report).toHaveProperty("initialEquity");
    expect(report).toHaveProperty("currentEquity");
    expect(report).toHaveProperty("weekReturn");
    expect(report).toHaveProperty("totalReturn");
    expect(report).toHaveProperty("maxDrawdown");
    expect(report).toHaveProperty("tradesOpened");
    expect(report).toHaveProperty("tradesClosed");
    expect(report).toHaveProperty("winRate");
    expect(report).toHaveProperty("sharpe");
    expect(report).toHaveProperty("openPositions");
  });

  it("空交易历史 → tradesOpened=0, tradesClosed=0", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.tradesOpened).toBe(0);
    expect(report.tradesClosed).toBe(0);
  });

  it("空交易历史 → winRate=0", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.winRate).toBe(0);
  });

  it("空交易历史 → bestTrade=null, worstTrade=null", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.bestTrade).toBeNull();
    expect(report.worstTrade).toBeNull();
  });

  it("totalReturn 计算正确（usdt=1100, initial=1000 → 10%）", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.totalReturn).toBeCloseTo(10, 5);
  });

  it("period 字段格式为 'YYYY-MM-DD ~ YYYY-MM-DD'", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.period).toMatch(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
  });

  it("openPositions 为数组", async () => {
    const report = await generateWeeklyReport(sid);
    expect(Array.isArray(report.openPositions)).toBe(true);
  });

  it("生成 equityChartPath（SVG 文件）", async () => {
    const report = await generateWeeklyReport(sid);
    if (report.equityChartPath !== undefined) {
      expect(fs.existsSync(report.equityChartPath)).toBe(true);
    }
  });

  it("maxDrawdown >= 0", async () => {
    const report = await generateWeeklyReport(sid);
    expect(report.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it("days 参数影响 period 起始日期", async () => {
    const report14 = await generateWeeklyReport(sid, 14);
    const report7 = await generateWeeklyReport(sid, 7);
    const start14 = report14.period.split(" ~ ")[0];
    const start7 = report7.period.split(" ~ ")[0];
    // 14-day period should start earlier than 7-day
    expect(start14 !== undefined && start7 !== undefined && start14 <= start7).toBe(true);
  });

  it("有 equity history 时 weekReturn 反映曲线首尾差", async () => {
    // Write equity history with known start/end
    const p = getEquityHistoryPath(sid);
    const now = Date.now();
    const lines = [
      JSON.stringify({ timestamp: now - 6 * 24 * 3600000, equity: 1000, positions: 0 }),
      JSON.stringify({ timestamp: now - 1000, equity: 1100, positions: 0 }),
    ];
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");

    makeAccountFile(sid, { usdt: 1100, initialUsdt: 1000 });
    const report = await generateWeeklyReport(sid, 7);
    expect(report.weekReturn).toBeCloseTo(10, 1);
  });
});

describe("maxDrawdown 计算", () => {
  it("单调递增曲线 → maxDrawdown=0", async () => {
    const sid = uniqueId();
    makeAccountFile(sid, { usdt: 1200 });
    const p = getEquityHistoryPath(sid);
    const now = Date.now();
    const lines = [1000, 1050, 1100, 1150, 1200].map((e, i) =>
      JSON.stringify({ timestamp: now - (4 - i) * 24 * 3600000, equity: e, positions: 0 })
    );
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");

    const report = await generateWeeklyReport(sid, 7);
    expect(report.maxDrawdown).toBe(0);
    try { fs.unlinkSync(p); } catch { /* ignore */ }
    cleanupFiles(sid);
  });

  it("先涨后跌曲线 → maxDrawdown > 0", async () => {
    const sid = uniqueId();
    makeAccountFile(sid, { usdt: 900 });
    const p = getEquityHistoryPath(sid);
    const now = Date.now();
    const equities = [1000, 1200, 1100, 950, 900];
    const lines = equities.map((e, i) =>
      JSON.stringify({ timestamp: now - (4 - i) * 24 * 3600000, equity: e, positions: 0 })
    );
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");

    const report = await generateWeeklyReport(sid, 7);
    // Peak 1200, trough 900 → drawdown = (1200-900)/1200 * 100 = 25%
    expect(report.maxDrawdown).toBeGreaterThan(0);
    try { fs.unlinkSync(p); } catch { /* ignore */ }
    cleanupFiles(sid);
  });
});

// ─── formatWeeklyReport ───────────────────────────────────────────────────────

describe("formatWeeklyReport()", () => {
  function makeReport(overrides: Partial<WeeklyReportData> = {}): WeeklyReportData {
    return {
      period: "2026-02-19 ~ 2026-02-26",
      scenarioId: "test-scenario",
      initialEquity: 1000,
      currentEquity: 1100,
      weekReturn: 10,
      totalReturn: 10,
      maxDrawdown: 2.5,
      tradesOpened: 5,
      tradesClosed: 3,
      winRate: 66.7,
      sharpe: 1.5,
      bestTrade: { symbol: "BTCUSDT", pnl: 50 },
      worstTrade: { symbol: "ETHUSDT", pnl: -20 },
      openPositions: [],
      ...overrides,
    };
  }

  it("输出非空字符串", () => {
    const text = formatWeeklyReport(makeReport());
    expect(text.length).toBeGreaterThan(0);
  });

  it("包含 scenarioId", () => {
    const text = formatWeeklyReport(makeReport());
    expect(text).toContain("test-scenario");
  });

  it("包含周收益率", () => {
    const text = formatWeeklyReport(makeReport({ weekReturn: 10 }));
    expect(text).toContain("10.00");
  });

  it("包含统计周期", () => {
    const text = formatWeeklyReport(makeReport());
    expect(text).toContain("2026-02-19");
    expect(text).toContain("2026-02-26");
  });

  it("包含胜率字段", () => {
    const text = formatWeeklyReport(makeReport({ winRate: 66.7 }));
    expect(text).toContain("66.7");
  });

  it("包含最佳交易", () => {
    const text = formatWeeklyReport(makeReport());
    expect(text).toContain("BTCUSDT");
  });

  it("包含最差交易", () => {
    const text = formatWeeklyReport(makeReport());
    expect(text).toContain("ETHUSDT");
  });

  it("bestTrade=null 时不抛异常", () => {
    const text = formatWeeklyReport(makeReport({ bestTrade: null, worstTrade: null }));
    expect(text.length).toBeGreaterThan(0);
  });

  it("当前持仓显示在输出中", () => {
    const text = formatWeeklyReport(
      makeReport({
        openPositions: [{ symbol: "SOLUSDT", pnlPercent: 2.5, holdHours: 5 }],
      })
    );
    expect(text).toContain("SOLUSDT");
  });

  it("equityChartPath 显示文件名", () => {
    const text = formatWeeklyReport(
      makeReport({ equityChartPath: "/tmp/equity-test.svg" })
    );
    expect(text).toContain("equity-test.svg");
  });

  it("负周收益率 → 包含 📉", () => {
    const text = formatWeeklyReport(makeReport({ weekReturn: -5 }));
    expect(text).toContain("📉");
  });

  it("正周收益率 → 包含 📈", () => {
    const text = formatWeeklyReport(makeReport({ weekReturn: 5 }));
    expect(text).toContain("📈");
  });
});

/**
 * 每周绩效报告模块
 * 读取 paper 账户、资金历史、信号历史，生成结构化周报。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadAccount } from "../paper/account.js";
import { loadEquityHistory } from "./equity-tracker.js";
import { generateEquityChart } from "./equity-chart.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeeklyReportData {
  period: string;             // "2026-02-19 ~ 2026-02-26"
  scenarioId: string;
  initialEquity: number;
  currentEquity: number;
  weekReturn: number;         // 周收益率 %
  totalReturn: number;        // 总收益率 %
  maxDrawdown: number;        // 周内最大回撤 %
  tradesOpened: number;
  tradesClosed: number;
  winRate: number;
  sharpe: number;             // 周化夏普
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  openPositions: Array<{ symbol: string; pnlPercent: number; holdHours: number }>;
  equityChartPath?: string;   // SVG/PNG 路径
}

// ─── Signal history ───────────────────────────────────────────────────────────

interface SignalRecord {
  id: string;
  symbol: string;
  type: "buy" | "sell" | "short" | "cover";
  entryTime: number;
  exitTime?: number;
  pnl?: number;
  pnlPercent?: number;
  holdingHours?: number;
  status: "open" | "closed" | "expired";
  scenarioId?: string;
  source?: string;
}

const IS_TEST = process.env["VITEST"] === "true" || process.env["NODE_ENV"] === "test";

function getSignalHistoryPath(): string {
  return IS_TEST
    ? path.join(LOGS_DIR, "signal-history-test.jsonl")
    : path.join(LOGS_DIR, "signal-history.jsonl");
}

function loadSignalHistory(
  scenarioId: string,
  sinceMs: number
): SignalRecord[] {
  const filePath = getSignalHistoryPath();
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const results: SignalRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as SignalRecord;
      // Filter by scenarioId if provided
      if (rec.scenarioId !== undefined && rec.scenarioId !== scenarioId) continue;
      if (rec.entryTime < sinceMs) continue;
      results.push(rec);
    } catch {
      // skip
    }
  }

  return results;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcMaxDrawdown(equityHistory: Array<{ equity: number }>): number {
  if (equityHistory.length === 0) return 0;
  let peak = equityHistory[0]?.equity ?? 0;
  let maxDd = 0;
  for (const { equity } of equityHistory) {
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  // Annualise assuming weekly period → multiply by sqrt(52)
  return (mean / stdDev) * Math.sqrt(52);
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * 从账户文件 + 交易历史生成周报数据。
 * @param scenarioId 场景 ID（如 "testnet-default"）
 * @param days       统计天数，默认 7
 */
export async function generateWeeklyReport(
  scenarioId: string,
  days = 7
): Promise<WeeklyReportData> {
  const now = Date.now();
  const sinceMs = now - days * 24 * 60 * 60 * 1000;

  // 1. Load paper account
  const account = loadAccount(1000, scenarioId);
  const currentEquity = account.usdt;
  const initialEquity = account.initialUsdt;

  // 2. Period label
  const period = `${formatDate(sinceMs)} ~ ${formatDate(now)}`;

  // 3. Load signal history for trade stats
  const signals = loadSignalHistory(scenarioId, sinceMs);

  // Opened = any signal in period (buy/short entries)
  const tradesOpened = signals.filter((s) => s.type === "buy" || s.type === "short").length;

  // Closed = closed signals in period
  const closedSignals = signals.filter(
    (s) => s.status === "closed" && s.pnl !== undefined
  );
  const tradesClosed = closedSignals.length;

  // Win rate
  const wins = closedSignals.filter((s) => (s.pnl ?? 0) > 0);
  const winRate = tradesClosed > 0 ? (wins.length / tradesClosed) * 100 : 0;

  // Best / worst trade
  let bestTrade: { symbol: string; pnl: number } | null = null;
  let worstTrade: { symbol: string; pnl: number } | null = null;
  if (closedSignals.length > 0) {
    const sorted = [...closedSignals].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best !== undefined) bestTrade = { symbol: best.symbol, pnl: best.pnl ?? 0 };
    if (worst !== undefined) worstTrade = { symbol: worst.symbol, pnl: worst.pnl ?? 0 };
  }

  // 4. Equity history for chart + drawdown
  const equityHistory = loadEquityHistory(scenarioId, days);

  // Supplement: if no equity history, fall back to account trades pnl to build mini-curve
  const equityPoints: Array<{ timestamp: number; equity: number }> =
    equityHistory.length > 0
      ? equityHistory.map((e) => ({ timestamp: e.timestamp, equity: e.equity }))
      : buildEquityCurveFromTrades(account.trades, initialEquity, sinceMs);

  // Week return: compare equity at start of period vs now
  const weekStartEquity = equityPoints[0]?.equity ?? initialEquity;
  const weekReturn =
    weekStartEquity > 0 ? ((currentEquity - weekStartEquity) / weekStartEquity) * 100 : 0;

  // Total return
  const totalReturn = initialEquity > 0 ? ((currentEquity - initialEquity) / initialEquity) * 100 : 0;

  // Max drawdown from equity curve
  const maxDrawdown = calcMaxDrawdown(equityPoints);

  // Sharpe from daily equity returns
  const dailyReturns = computeDailyReturns(equityPoints);
  const sharpe = calcSharpe(dailyReturns);

  // 5. Open positions from account
  const openPositions: Array<{ symbol: string; pnlPercent: number; holdHours: number }> =
    Object.entries(account.positions).map(([symbol, pos]) => {
      const holdHours = (now - pos.entryTime) / 3600000;
      // Approximate pnl% (without live price)
      const pnlPercent = 0;
      return { symbol, pnlPercent, holdHours };
    });

  // 6. Generate equity chart SVG
  const chartDir = path.join(LOGS_DIR, "reports");
  fs.mkdirSync(chartDir, { recursive: true });
  const chartPath = path.join(chartDir, `equity-${scenarioId}-${formatDate(now)}.svg`);
  const chartTitle = `${scenarioId} — ${days} Day Equity`;

  let equityChartPath: string | undefined;
  try {
    await generateEquityChart(equityPoints, chartTitle, chartPath);
    equityChartPath = chartPath;
  } catch {
    equityChartPath = undefined;
  }

  return {
    period,
    scenarioId,
    initialEquity,
    currentEquity,
    weekReturn,
    totalReturn,
    maxDrawdown,
    tradesOpened,
    tradesClosed,
    winRate,
    sharpe,
    bestTrade,
    worstTrade,
    openPositions,
    ...(equityChartPath !== undefined ? { equityChartPath } : {}),
  };
}

/**
 * 从 PaperTrade 列表构建权益曲线（无 equity-history 时的后备方案）
 */
function buildEquityCurveFromTrades(
  trades: Array<{ side: string; timestamp: number; pnl?: number }>,
  initialEquity: number,
  sinceMs: number
): Array<{ timestamp: number; equity: number }> {
  const periodTrades = trades
    .filter((t) => t.timestamp >= sinceMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (periodTrades.length === 0) {
    return [{ timestamp: sinceMs, equity: initialEquity }];
  }

  const curve: Array<{ timestamp: number; equity: number }> = [
    { timestamp: sinceMs, equity: initialEquity },
  ];

  let equity = initialEquity;
  for (const t of periodTrades) {
    if (t.pnl !== undefined) {
      equity += t.pnl;
      curve.push({ timestamp: t.timestamp, equity });
    }
  }

  return curve;
}

/**
 * 从权益曲线计算日收益率数组。
 */
function computeDailyReturns(
  points: Array<{ timestamp: number; equity: number }>
): number[] {
  if (points.length < 2) return [];

  const DAY_MS = 24 * 60 * 60 * 1000;
  const returns: number[] = [];
  let i = 0;

  while (i < points.length - 1) {
    const curr = points[i];
    const next = points[i + 1];
    if (curr === undefined || next === undefined) break;
    const timeDiff = next.timestamp - curr.timestamp;
    if (timeDiff >= DAY_MS && curr.equity > 0) {
      returns.push((next.equity - curr.equity) / curr.equity);
    }
    i++;
  }

  return returns;
}

/**
 * 格式化周报为 Telegram 消息文本。
 */
export function formatWeeklyReport(data: WeeklyReportData): string {
  const pnlSign = data.weekReturn >= 0 ? "+" : "";
  const totalSign = data.totalReturn >= 0 ? "+" : "";
  const pnlEmoji = data.weekReturn >= 0 ? "📈" : "📉";

  const lines: string[] = [
    `📊 *每周绩效报告 — ${data.scenarioId}*`,
    `📅 统计周期: ${data.period}`,
    "",
    `${pnlEmoji} *周收益: ${pnlSign}${data.weekReturn.toFixed(2)}%*`,
    `📊 总收益: ${totalSign}${data.totalReturn.toFixed(2)}%`,
    `💰 当前资金: $${data.currentEquity.toFixed(2)} (初始: $${data.initialEquity.toFixed(2)})`,
    "",
    "── 交易统计 ──",
    `开仓: ${data.tradesOpened} | 平仓: ${data.tradesClosed}`,
    `胜率: ${data.winRate.toFixed(1)}%`,
    `最大回撤: ${data.maxDrawdown.toFixed(2)}%`,
    `夏普比率: ${data.sharpe.toFixed(2)}`,
  ];

  if (data.bestTrade !== null) {
    const sign = data.bestTrade.pnl >= 0 ? "+" : "";
    lines.push(`🏆 最佳交易: ${data.bestTrade.symbol} ${sign}$${data.bestTrade.pnl.toFixed(2)}`);
  }
  if (data.worstTrade !== null) {
    const sign = data.worstTrade.pnl >= 0 ? "+" : "";
    lines.push(`💀 最差交易: ${data.worstTrade.symbol} ${sign}$${data.worstTrade.pnl.toFixed(2)}`);
  }

  if (data.openPositions.length > 0) {
    lines.push("");
    lines.push("── 当前持仓 ──");
    for (const pos of data.openPositions) {
      const holdStr =
        pos.holdHours < 1
          ? `${(pos.holdHours * 60).toFixed(0)}min`
          : `${pos.holdHours.toFixed(1)}h`;
      lines.push(`  ${pos.symbol}: 持仓 ${holdStr}`);
    }
  }

  if (data.equityChartPath !== undefined) {
    lines.push("");
    lines.push(`📉 资金曲线: ${path.basename(data.equityChartPath)}`);
  }

  return lines.join("\n");
}

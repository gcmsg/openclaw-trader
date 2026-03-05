/**
 * Weekly performance report module
 * Reads paper account, equity history, signal history, and generates structured weekly report.
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
  weekReturn: number;         // Weekly return %
  totalReturn: number;        // Total return %
  maxDrawdown: number;        // Max drawdown within the week %
  tradesOpened: number;
  tradesClosed: number;
  winRate: number;
  sharpe: number;             // Weekly Sharpe ratio
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  openPositions: { symbol: string; pnlPercent: number; holdHours: number }[];
  equityChartPath?: string;   // SVG/PNG path
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

function calcMaxDrawdown(equityHistory: { equity: number }[]): number {
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
 * Generate weekly report data from account file + trade history.
 * @param scenarioId Scenario ID (e.g. "testnet-default")
 * @param days       Number of days to analyze, default 7
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
  const equityPoints: { timestamp: number; equity: number }[] =
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
  const openPositions: { symbol: string; pnlPercent: number; holdHours: number }[] =
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
 * Build equity curve from PaperTrade list (fallback when no equity-history available)
 */
function buildEquityCurveFromTrades(
  trades: { side: string; timestamp: number; pnl?: number }[],
  initialEquity: number,
  sinceMs: number
): { timestamp: number; equity: number }[] {
  const periodTrades = trades
    .filter((t) => t.timestamp >= sinceMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (periodTrades.length === 0) {
    return [{ timestamp: sinceMs, equity: initialEquity }];
  }

  const curve: { timestamp: number; equity: number }[] = [
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
 * Compute daily returns from equity curve.
 */
function computeDailyReturns(
  points: { timestamp: number; equity: number }[]
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
 * Format weekly report as Telegram message text.
 */
export function formatWeeklyReport(data: WeeklyReportData): string {
  const pnlSign = data.weekReturn >= 0 ? "+" : "";
  const totalSign = data.totalReturn >= 0 ? "+" : "";
  const pnlEmoji = data.weekReturn >= 0 ? "📈" : "📉";

  const lines: string[] = [
    `📊 *Weekly Performance Report — ${data.scenarioId}*`,
    `📅 Period: ${data.period}`,
    "",
    `${pnlEmoji} *Week Return: ${pnlSign}${data.weekReturn.toFixed(2)}%*`,
    `📊 Total Return: ${totalSign}${data.totalReturn.toFixed(2)}%`,
    `💰 Current Equity: $${data.currentEquity.toFixed(2)} (Initial: $${data.initialEquity.toFixed(2)})`,
    "",
    "── Trade Statistics ──",
    `Opened: ${data.tradesOpened} | Closed: ${data.tradesClosed}`,
    `Win Rate: ${data.winRate.toFixed(1)}%`,
    `Max Drawdown: ${data.maxDrawdown.toFixed(2)}%`,
    `Sharpe Ratio: ${data.sharpe.toFixed(2)}`,
  ];

  if (data.bestTrade !== null) {
    const sign = data.bestTrade.pnl >= 0 ? "+" : "";
    lines.push(`🏆 Best Trade: ${data.bestTrade.symbol} ${sign}$${data.bestTrade.pnl.toFixed(2)}`);
  }
  if (data.worstTrade !== null) {
    const sign = data.worstTrade.pnl >= 0 ? "+" : "";
    lines.push(`💀 Worst Trade: ${data.worstTrade.symbol} ${sign}$${data.worstTrade.pnl.toFixed(2)}`);
  }

  if (data.openPositions.length > 0) {
    lines.push("");
    lines.push("── Open Positions ──");
    for (const pos of data.openPositions) {
      const holdStr =
        pos.holdHours < 1
          ? `${(pos.holdHours * 60).toFixed(0)}min`
          : `${pos.holdHours.toFixed(1)}h`;
      lines.push(`  ${pos.symbol}: Held ${holdStr}`);
    }
  }

  if (data.equityChartPath !== undefined) {
    lines.push("");
    lines.push(`📉 Equity Curve: ${path.basename(data.equityChartPath)}`);
  }

  return lines.join("\n");
}

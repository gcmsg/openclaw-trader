/**
 * Signal History Database
 *
 * Design philosophy:
 *   Record "trigger conditions + entry price" when each signal fires,
 *   Write back "exit price + P&L + reason" when position closes.
 *
 *   After accumulating 50-100 records, quantitative analysis reveals which signals truly have alpha:
 *   - Actual win rate of MA bullish + RSI oversold combination
 *   - Win rate difference between shorting in bear market vs ranging market
 *   - Entry quality across different time periods (08:00-12:00 vs 20:00-24:00)
 *
 * Storage format: JSONL (one JSON per line), convenient for streaming reads and grep analysis
 * File location: logs/signal-history.jsonl
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test environment uses isolated paths to avoid polluting production data
const IS_TEST = process.env["VITEST"] === "true" || process.env["NODE_ENV"] === "test";
const LOG_FILE = IS_TEST
  ? path.resolve(__dirname, "../../logs/signal-history-test.jsonl")
  : path.resolve(__dirname, "../../logs/signal-history.jsonl");
const INDEX_FILE = IS_TEST
  ? path.resolve(__dirname, "../../logs/signal-index-test.json")
  : path.resolve(__dirname, "../../logs/signal-index.json");

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export type SignalType = "buy" | "sell" | "short" | "cover";
export type SignalStatus = "open" | "closed" | "expired";
export type ExitReason = "signal" | "stop_loss" | "take_profit" | "trailing_stop" | "time_stop" | "manual" | "end_of_data";

export interface SignalConditions {
  // Indicator snapshot (at entry)
  maShort?: number;
  maLong?: number;
  rsi?: number;
  macd?: { macd: number; signal: number; histogram: number };
  atr?: number;
  // Context information
  fundingRate?: number;
  fearGreedIndex?: number;
  regime?: string;           // "trending_bull" | "ranging_tight" etc.
  signalStrength?: number;   // MultiTF composite strength
  timeframe?: string;
  // Specific triggered rules
  triggeredRules?: string[]; // e.g. ["ma_bullish", "rsi_oversold"]
}

export interface SignalRecord {
  id: string;                    // Unique ID (timestamp + random)
  symbol: string;
  type: SignalType;
  entryPrice: number;
  entryTime: number;             // Millisecond timestamp
  entryConditions: SignalConditions;
  status: SignalStatus;
  // Exit info (filled when closed)
  exitPrice?: number;
  exitTime?: number;
  exitReason?: ExitReason;
  pnl?: number;                  // Absolute P&L (USDT)
  pnlPercent?: number;           // Percentage P&L
  holdingHours?: number;         // Holding duration (hours)
  // Metadata
  scenarioId?: string;           // paper/live scenario
  source?: "paper" | "live" | "backtest";
  notes?: string;
}

// ─────────────────────────────────────────────────────
// ID & File Utilities
// ─────────────────────────────────────────────────────

function generateId(): string {
  return `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function appendRecord(record: SignalRecord): void {
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf-8");
  updateIndex(record);
}

function readAllRecords(): SignalRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
  const records: SignalRecord[] = [];
  for (const l of lines) {
    try {
      records.push(JSON.parse(l) as SignalRecord);
    } catch { /* Skip corrupted lines, prevent single-line errors from making entire history unreadable */ }
  }
  return records;
}

function rewriteAll(records: SignalRecord[]): void {
  ensureDir();
  fs.writeFileSync(LOG_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  // Rebuild index
  const index: Record<string, number> = {};
  records.forEach((r, i) => { index[r.id] = i; });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf-8");
}

/** Index: id -> line offset (approximate position, used to accelerate closeSignal) */
function updateIndex(record: SignalRecord): void {
  let index: Record<string, number> = {};
  try { index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as Record<string, number>; }
  catch { /* First run */ }
  const lineCount = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean).length
    : 0;
  index[record.id] = lineCount - 1;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf-8");
}

// ─────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────

/**
 * Record a new signal (called at entry)
 *
 * @returns Signal ID, pass back to closeSignal() when closing position
 */
export function logSignal(params: {
  symbol: string;
  type: SignalType;
  entryPrice: number;
  conditions?: SignalConditions;
  scenarioId?: string;
  source?: SignalRecord["source"];
  notes?: string;
}): string {
  const id = generateId();
  const record: SignalRecord = {
    id,
    symbol: params.symbol,
    type: params.type,
    entryPrice: params.entryPrice,
    entryTime: Date.now(),
    entryConditions: params.conditions ?? {},
    status: "open",
    source: params.source ?? "paper",
    ...(params.scenarioId !== undefined && { scenarioId: params.scenarioId }),
    ...(params.notes !== undefined && { notes: params.notes }),
  };
  appendRecord(record);
  return id;
}

/**
 * Close a signal (called when closing position)
 * Automatically calculates P&L % and holding duration
 */
export function closeSignal(
  id: string,
  exitPrice: number,
  exitReason: ExitReason,
  pnl?: number,
  notes?: string
): SignalRecord | null {
  const records = readAllRecords();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;

  const record = records[idx];
  if (!record) return null;
  const exitTime = Date.now();
  const holdingHours = (exitTime - record.entryTime) / 3600000;

  const isShort = record.type === "short";
  const pnlPercent = isShort
    ? (record.entryPrice - exitPrice) / record.entryPrice
    : (exitPrice - record.entryPrice) / record.entryPrice;

  const merged: SignalRecord = {
    ...record,
    exitPrice,
    exitTime,
    exitReason,
    pnl: pnl ?? 0,
    pnlPercent,
    holdingHours,
    status: "closed",
  };
  const finalNotes = notes ?? record.notes;
  if (finalNotes !== undefined) merged.notes = finalNotes;
  records[idx] = merged;

  rewriteAll(records);
  return records[idx];
}

/**
 * Mark open signals as expired (e.g. when no matching position found after system restart)
 */
export function expireOpenSignals(olderThanHours = 72): number {
  const records = readAllRecords();
  const cutoff = Date.now() - olderThanHours * 3600000;
  let count = 0;
  for (const r of records) {
    if (r.status === "open" && r.entryTime < cutoff) {
      r.status = "expired";
      count++;
    }
  }
  if (count > 0) rewriteAll(records);
  return count;
}

// ─────────────────────────────────────────────────────
// Statistical Analysis
// ─────────────────────────────────────────────────────

export interface SignalStats {
  /** Overall statistics */
  total: number;
  closed: number;
  open: number;
  expired: number;
  winRate: number;                    // Win rate (among closed trades)
  avgPnlPercent: number;              // Average P&L percentage
  avgWinPercent: number;              // Average win %
  avgLossPercent: number;             // Average loss %
  profitFactor: number;               // Total wins / Total losses
  avgHoldingHours: number;
  /** Per-dimension statistics */
  byType: Record<SignalType, { count: number; winRate: number; avgPnl: number }>;
  bySymbol: Record<string, { count: number; winRate: number; avgPnl: number }>;
  byHour: Record<number, { count: number; winRate: number }>;  // By entry hour (UTC)
  /** Recent N trades */
  recentTrades: SignalRecord[];
  /** Analysis period */
  fromDate: string;
  toDate: string;
}

/**
 * Get signal history statistics
 * @param days Statistics for recent N days, default 30 days
 */
export function getSignalStats(days = 30): SignalStats {
  const all = readAllRecords();
  const cutoff = Date.now() - days * 86400000;
  const records = all.filter((r) => r.entryTime >= cutoff);

  const closed = records.filter((r) => r.status === "closed");
  const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
  const losses = closed.filter((r) => (r.pnlPercent ?? 0) <= 0);

  const totalWin = wins.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);
  const totalLoss = losses.reduce((s, r) => s + Math.abs(r.pnlPercent ?? 0), 0);

  // By signal type statistics
  const signalTypes: SignalType[] = ["buy", "sell", "short", "cover"];
  const byType = Object.fromEntries(
    signalTypes.map((type) => {
      const typeTrades = closed.filter((r) => r.type === type);
      const typeWins = typeTrades.filter((r) => (r.pnlPercent ?? 0) > 0);
      return [
        type,
        {
          count: typeTrades.length,
          winRate: typeTrades.length > 0 ? typeWins.length / typeTrades.length : 0,
          avgPnl: typeTrades.length > 0
            ? typeTrades.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / typeTrades.length
            : 0,
        },
      ];
    })
  ) as Record<SignalType, { count: number; winRate: number; avgPnl: number }>;

  // By symbol statistics
  const symbols = [...new Set(closed.map((r) => r.symbol))];
  const bySymbol = Object.fromEntries(
    symbols.map((sym) => {
      const symTrades = closed.filter((r) => r.symbol === sym);
      const symWins = symTrades.filter((r) => (r.pnlPercent ?? 0) > 0);
      return [
        sym,
        {
          count: symTrades.length,
          winRate: symTrades.length > 0 ? symWins.length / symTrades.length : 0,
          avgPnl: symTrades.length > 0
            ? symTrades.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / symTrades.length
            : 0,
        },
      ];
    })
  ) as Record<string, { count: number; winRate: number; avgPnl: number }>;

  // By entry hour statistics
  const byHour: Record<number, { count: number; wins: number }> = {};
  for (const r of closed) {
    const hour = new Date(r.entryTime).getUTCHours();
    byHour[hour] ??= { count: 0, wins: 0 };
    byHour[hour].count++;
    if ((r.pnlPercent ?? 0) > 0) byHour[hour].wins++;
  }
  const byHourStats = Object.fromEntries(
    Object.entries(byHour).map(([h, v]) => [
      h,
      { count: v.count, winRate: v.count > 0 ? v.wins / v.count : 0 },
    ])
  ) as Record<number, { count: number; winRate: number }>;

  // Recent 10 closed trades
  const recentTrades = closed.slice(-10).reverse();

  const fromMs = records.length > 0 ? Math.min(...records.map((r) => r.entryTime)) : Date.now();
  const toMs = records.length > 0 ? Math.max(...records.map((r) => r.entryTime)) : Date.now();

  return {
    total: records.length,
    closed: closed.length,
    open: records.filter((r) => r.status === "open").length,
    expired: records.filter((r) => r.status === "expired").length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    avgPnlPercent: closed.length > 0
      ? closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / closed.length
      : 0,
    avgWinPercent: wins.length > 0 ? totalWin / wins.length : 0,
    avgLossPercent: losses.length > 0 ? totalLoss / losses.length : 0,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 1),
    avgHoldingHours: closed.length > 0
      ? closed.reduce((s, r) => s + (r.holdingHours ?? 0), 0) / closed.length
      : 0,
    byType,
    bySymbol,
    byHour: byHourStats,
    recentTrades,
    fromDate: new Date(fromMs).toISOString().slice(0, 10),
    toDate: new Date(toMs).toISOString().slice(0, 10),
  };
}

/**
 * Format signal statistics report (Telegram-friendly)
 */
export function formatSignalStatsReport(stats: SignalStats): string {
  if (stats.closed === 0) {
    return "📊 **Signal History** -- No closed signal records yet (records will accumulate automatically after live/paper signals are generated)";
  }

  const lines: string[] = [
    `📊 **Signal History Stats** · ${stats.fromDate} ~ ${stats.toDate}\n`,
    `Total trades: ${stats.total} (closed: ${stats.closed} | open: ${stats.open} | expired: ${stats.expired})`,
    `Win rate: **${(stats.winRate * 100).toFixed(1)}%**  |  Avg P&L: ${(stats.avgPnlPercent * 100).toFixed(2)}%`,
    `Profit factor: ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}  |  Avg hold: ${stats.avgHoldingHours.toFixed(1)}h`,
    `Avg win: +${(stats.avgWinPercent * 100).toFixed(2)}%  |  Avg loss: -${(stats.avgLossPercent * 100).toFixed(2)}%\n`,
  ];

  // By signal type
  const typeRows = Object.entries(stats.byType)
    .filter(([, v]) => v.count > 0)
    .map(([t, v]) =>
      `  ${t.padEnd(6)} ${v.count} trades  WR ${(v.winRate * 100).toFixed(0)}%  Avg P&L ${v.avgPnl >= 0 ? "+" : ""}${(v.avgPnl * 100).toFixed(2)}%`
    );
  if (typeRows.length > 0) {
    lines.push("**By Signal Type**:");
    lines.push(...typeRows);
    lines.push("");
  }

  // By symbol (show top 5 only)
  const symRows = Object.entries(stats.bySymbol)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([s, v]) =>
      `  ${s.replace("USDT", "").padEnd(5)} ${v.count} trades  WR ${(v.winRate * 100).toFixed(0)}%  Avg P&L ${v.avgPnl >= 0 ? "+" : ""}${(v.avgPnl * 100).toFixed(2)}%`
    );
  if (symRows.length > 0) {
    lines.push("**By Symbol**:");
    lines.push(...symRows);
    lines.push("");
  }

  // Recent trades
  if (stats.recentTrades.length > 0) {
    lines.push("**Recent 5 Trades**:");
    for (const r of stats.recentTrades.slice(0, 5)) {
      const pnl = (r.pnlPercent ?? 0) * 100;
      const emoji = pnl > 0 ? "✅" : "❌";
      const date = new Date(r.entryTime).toISOString().slice(5, 10);
      lines.push(
        `  ${emoji} ${r.symbol.replace("USDT", "")} ${r.type.toUpperCase()} ${date}  ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%  (${r.exitReason ?? "?"})`
      );
    }
  }

  return lines.join("\n");
}

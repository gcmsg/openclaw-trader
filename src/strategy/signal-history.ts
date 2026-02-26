/**
 * 信号历史数据库
 *
 * 设计理念：
 *   每条信号触发时记录「触发条件 + 入场价格」，
 *   持仓关闭时回写「出场价格 + 盈亏 + 原因」。
 *
 *   积累 50-100 条记录后，可以量化分析哪些信号真正有 alpha：
 *   - MA bullish + RSI oversold 组合的实际胜率
 *   - 熊市中做空 vs 震荡市做空的成功率差异
 *   - 不同时间段（08:00-12:00 vs 20:00-24:00）入场质量
 *
 * 存储格式：JSONL（每行一条 JSON），便于流式读取和 grep 分析
 * 文件位置：logs/signal-history.jsonl
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 测试环境使用隔离路径，避免污染生产数据
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
  // 指标快照（入场时）
  maShort?: number;
  maLong?: number;
  rsi?: number;
  macd?: { macd: number; signal: number; histogram: number };
  atr?: number;
  // 情境信息
  fundingRate?: number;
  fearGreedIndex?: number;
  regime?: string;           // "trending_bull" | "ranging_tight" 等
  signalStrength?: number;   // MultiTF 综合强度
  timeframe?: string;
  // 触发的具体规则
  triggeredRules?: string[]; // e.g. ["ma_bullish", "rsi_oversold"]
}

export interface SignalRecord {
  id: string;                    // 唯一 ID（时间戳 + 随机）
  symbol: string;
  type: SignalType;
  entryPrice: number;
  entryTime: number;             // 毫秒时间戳
  entryConditions: SignalConditions;
  status: SignalStatus;
  // 出场信息（closed 时填写）
  exitPrice?: number;
  exitTime?: number;
  exitReason?: ExitReason;
  pnl?: number;                  // 绝对盈亏（USDT）
  pnlPercent?: number;           // 百分比盈亏
  holdingHours?: number;         // 持仓时长（小时）
  // 元信息
  scenarioId?: string;           // paper/live 场景
  source?: "paper" | "live" | "backtest";
  notes?: string;
}

// ─────────────────────────────────────────────────────
// ID & 文件工具
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
  return lines.map((l) => JSON.parse(l) as SignalRecord);
}

function rewriteAll(records: SignalRecord[]): void {
  ensureDir();
  fs.writeFileSync(LOG_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  // 重建索引
  const index: Record<string, number> = {};
  records.forEach((r, i) => { index[r.id] = i; });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf-8");
}

/** 索引：id → line offset（近似位置，用于加速 closeSignal） */
function updateIndex(record: SignalRecord): void {
  let index: Record<string, number> = {};
  try { index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as Record<string, number>; }
  catch { /* 首次运行 */ }
  const lineCount = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean).length
    : 0;
  index[record.id] = lineCount - 1;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf-8");
}

// ─────────────────────────────────────────────────────
// 核心 API
// ─────────────────────────────────────────────────────

/**
 * 记录新信号（入场时调用）
 *
 * @returns 信号 ID，平仓时传回 closeSignal()
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
 * 关闭信号（平仓时调用）
 * 自动计算盈亏 % 和持仓时长
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
 * 将 open 信号标记为 expired（如系统重启后找不到对应持仓）
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
// 统计分析
// ─────────────────────────────────────────────────────

export interface SignalStats {
  /** 总体统计 */
  total: number;
  closed: number;
  open: number;
  expired: number;
  winRate: number;                    // 胜率（closed 交易中）
  avgPnlPercent: number;              // 平均盈亏百分比
  avgWinPercent: number;              // 平均盈利 %
  avgLossPercent: number;             // 平均亏损 %
  profitFactor: number;               // 总盈 / 总亏
  avgHoldingHours: number;
  /** 分维度统计 */
  byType: Record<SignalType, { count: number; winRate: number; avgPnl: number }>;
  bySymbol: Record<string, { count: number; winRate: number; avgPnl: number }>;
  byHour: Record<number, { count: number; winRate: number }>;  // 按入场小时（UTC）
  /** 最近 N 笔 */
  recentTrades: SignalRecord[];
  /** 分析期间 */
  fromDate: string;
  toDate: string;
}

/**
 * 获取信号历史统计
 * @param days 统计最近 N 天，默认 30 天
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

  // 分类型统计
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

  // 分币种统计
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

  // 按入场小时统计
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

  // 最近 10 笔已关闭交易
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
 * 格式化信号统计报告（Telegram 友好）
 */
export function formatSignalStatsReport(stats: SignalStats): string {
  if (stats.closed === 0) {
    return "📊 **信号历史库** — 暂无已关闭的信号记录（记录将在实盘/paper 产生信号后自动积累）";
  }

  const lines: string[] = [
    `📊 **信号历史统计** · ${stats.fromDate} ~ ${stats.toDate}\n`,
    `交易总数: ${stats.total}（已关闭: ${stats.closed} | 持仓中: ${stats.open} | 过期: ${stats.expired}）`,
    `胜率: **${(stats.winRate * 100).toFixed(1)}%**  |  平均盈亏: ${(stats.avgPnlPercent * 100).toFixed(2)}%`,
    `盈利因子: ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}  |  平均持仓: ${stats.avgHoldingHours.toFixed(1)}h`,
    `平均盈利: +${(stats.avgWinPercent * 100).toFixed(2)}%  |  平均亏损: -${(stats.avgLossPercent * 100).toFixed(2)}%\n`,
  ];

  // 按信号类型
  const typeRows = Object.entries(stats.byType)
    .filter(([, v]) => v.count > 0)
    .map(([t, v]) =>
      `  ${t.padEnd(6)} ${v.count}笔  胜率 ${(v.winRate * 100).toFixed(0)}%  均盈亏 ${v.avgPnl >= 0 ? "+" : ""}${(v.avgPnl * 100).toFixed(2)}%`
    );
  if (typeRows.length > 0) {
    lines.push("**按信号类型**:");
    lines.push(...typeRows);
    lines.push("");
  }

  // 按币种（只显示前 5 个）
  const symRows = Object.entries(stats.bySymbol)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([s, v]) =>
      `  ${s.replace("USDT", "").padEnd(5)} ${v.count}笔  胜率 ${(v.winRate * 100).toFixed(0)}%  均盈亏 ${v.avgPnl >= 0 ? "+" : ""}${(v.avgPnl * 100).toFixed(2)}%`
    );
  if (symRows.length > 0) {
    lines.push("**按币种**:");
    lines.push(...symRows);
    lines.push("");
  }

  // 最近几笔
  if (stats.recentTrades.length > 0) {
    lines.push("**最近 5 笔**:");
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

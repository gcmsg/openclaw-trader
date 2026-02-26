/**
 * 交易记录收集器
 *
 * 从不同来源（回测结果、signal-history.jsonl）提取 TradeRecord，
 * 并提供合并/去重工具。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { TradeRecord } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────
// 默认文件路径
// ─────────────────────────────────────────────────────

const DEFAULT_SIGNAL_HISTORY = path.resolve(
  __dirname,
  "../../logs/signal-history.jsonl"
);

// ─────────────────────────────────────────────────────
// BacktestTrade（与 runner.ts 保持一致）
// ─────────────────────────────────────────────────────

interface RawBacktestTrade {
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity?: number;
  cost?: number;
  proceeds?: number;
  pnl?: number;
  pnlPercent?: number;
  exitReason?: string;
  signalConditions?: string[];
}

interface RawBacktestResult {
  trades?: RawBacktestTrade[];
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────
// SignalRecord（与 signals/history.ts 保持一致）
// ─────────────────────────────────────────────────────

interface RawSignalConditions {
  triggeredRules?: string[];
  [key: string]: unknown;
}

interface RawSignalRecord {
  symbol?: string;
  type?: string;
  entryPrice?: number;
  entryTime?: number;
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  pnl?: number;
  pnlPercent?: number;
  holdingHours?: number;
  status?: string;
  entryConditions?: RawSignalConditions;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────
// 核心 API
// ─────────────────────────────────────────────────────

/**
 * 从回测结果中提取 TradeRecord 数组。
 *
 * 只提取已完成的交易（side="sell" 或 side="cover"），
 * 忽略开仓记录（side="buy" 或 side="short"）。
 */
export function collectFromBacktest(backtestResult: unknown): TradeRecord[] {
  if (backtestResult == null || typeof backtestResult !== 'object') return [];
  const result = backtestResult as RawBacktestResult;
  const rawTrades = result.trades;
  if (!Array.isArray(rawTrades)) return [];

  const records: TradeRecord[] = [];

  for (const raw of rawTrades) {
    const t = raw;

    // 只取平仓记录
    if (t.side !== "sell" && t.side !== "cover") continue;

    const side: "long" | "short" = t.side === "cover" ? "short" : "long";
    const entryTime = t.entryTime;
    const exitTime = t.exitTime;
    const holdMs = exitTime - entryTime;

    records.push({
      symbol: t.symbol,
      side,
      signalConditions: Array.isArray(t.signalConditions) ? t.signalConditions : [],
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnlPercent: t.pnlPercent ?? 0,
      pnlUsdt: t.pnl ?? 0,
      exitReason: t.exitReason ?? "signal",
      holdMs: holdMs > 0 ? holdMs : 0,
      entryTime,
      exitTime,
    });
  }

  return records;
}

/**
 * 从 signal-history.jsonl 加载实际交易记录。
 *
 * 只加载 status="closed" 的记录（已完成的交易）。
 */
export function collectFromSignalHistory(filepath?: string): TradeRecord[] {
  const filePath = filepath ?? DEFAULT_SIGNAL_HISTORY;

  if (!fs.existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const records: TradeRecord[] = [];

  for (const line of lines) {
    let parsed: RawSignalRecord;
    try {
      parsed = JSON.parse(line) as RawSignalRecord;
    } catch {
      continue; // 跳过无效 JSON 行
    }

    // 只处理已关闭的记录
    if (parsed.status !== "closed") continue;

    const symbol = parsed.symbol ?? "UNKNOWN";
    const rawType = parsed.type ?? "buy";
    const side: "long" | "short" =
      rawType === "short" || rawType === "cover" ? "short" : "long";

    const entryPrice = parsed.entryPrice ?? 0;
    const exitPrice = parsed.exitPrice ?? 0;
    const pnlPercent = parsed.pnlPercent ?? 0;
    const pnlUsdt = parsed.pnl ?? 0;
    const exitReason = parsed.exitReason ?? "signal";
    const entryTime = parsed.entryTime ?? 0;
    const exitTime = parsed.exitTime ?? 0;

    // holdMs 优先从 holdingHours 推算，再从时间差计算
    const holdMs =
      parsed.holdingHours !== undefined && parsed.holdingHours > 0
        ? parsed.holdingHours * 3_600_000
        : exitTime > entryTime
          ? exitTime - entryTime
          : 0;

    const signalConditions: string[] =
      Array.isArray(parsed.entryConditions?.triggeredRules)
        ? (parsed.entryConditions.triggeredRules)
        : [];

    records.push({
      symbol,
      side,
      signalConditions,
      entryPrice,
      exitPrice,
      pnlPercent,
      pnlUsdt,
      exitReason,
      holdMs,
      entryTime,
      exitTime,
    });
  }

  return records;
}

/**
 * 合并多个来源的交易记录，并按 (symbol, entryTime, exitTime) 去重。
 */
export function mergeRecords(...sources: TradeRecord[][]): TradeRecord[] {
  const seen = new Set<string>();
  const merged: TradeRecord[] = [];

  for (const source of sources) {
    for (const record of source) {
      const key = `${record.symbol}|${record.side}|${record.entryTime}|${record.exitTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }

  // 按入场时间排序
  merged.sort((a, b) => a.entryTime - b.entryTime);

  return merged;
}

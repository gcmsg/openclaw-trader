/**
 * 加载近期平仓记录，供 Protection Manager 使用
 * 审计发现 A-005 修复
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseTradeRecords, type TradeRecord } from "./protection-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../logs/signal-history.jsonl");

/** 默认回溯 7 天 */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 3600_000;

/**
 * 从 signal-history.jsonl 加载近期平仓记录
 * @param lookbackMs 回溯时间窗口（默认 7 天）
 */
export function loadRecentTrades(lookbackMs = DEFAULT_LOOKBACK_MS): TradeRecord[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const lines = fs.readFileSync(HISTORY_PATH, "utf-8").split("\n").filter(Boolean);
    return parseTradeRecords(lines, Date.now() - lookbackMs);
  } catch {
    return [];
  }
}

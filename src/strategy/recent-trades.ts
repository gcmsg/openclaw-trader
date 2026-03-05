/**
 * Load recent closed trade records for Protection Manager use
 * Audit finding A-005 fix
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseTradeRecords, type TradeRecord } from "./protection-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../logs/signal-history.jsonl");

/** Default lookback 7 days */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 3600_000;

/**
 * Load recent closed trade records from signal-history.jsonl
 * @param lookbackMs Lookback time window (default 7 days)
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

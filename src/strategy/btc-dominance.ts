/**
 * BTC Dominance Trend Tracking
 *
 * ## Why It Matters
 * - BTC dominance = BTC market cap / total crypto market cap
 * - Rising dominance -> capital flows from altcoins to BTC ("risk-off") -> altcoin reduction signal
 * - Falling dominance (while BTC stable) -> altcoin season -> can increase altcoin exposure
 *
 * ## Data Source
 * - `market-analysis.ts` calls `trackBtcDominance()` after each analysis to append records
 * - File storage: `logs/btc-dominance-history.json` (retained for 30 days)
 *
 * ## Signals
 * - 7-day trend > +threshold%  -> `btc_dominance_rising`  (high altcoin risk)
 * - 7-day trend < -threshold%  -> `btc_dominance_falling` (altcoin opportunity)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../logs/btc-dominance-history.json");
const MAX_DAYS = 30;

// ─── Types ──────────────────────────────────────────────

export interface DominanceRecord {
  date: string;   // 'YYYY-MM-DD' (UTC)
  dom: number;    // Percentage, e.g. 54.3
  ts: number;     // Record timestamp (ms)
}

export interface DominanceTrend {
  latest: number;          // Latest dominance
  oldest: number;          // Dominance N days ago (may be NaN if insufficient data)
  change: number;          // Change amount (latest - oldest)
  days: number;            // Actual number of days spanned
  direction: "rising" | "falling" | "neutral";
  records: DominanceRecord[];
}

// ─── File IO ──────────────────────────────────────────

function loadHistory(): DominanceRecord[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as DominanceRecord[];
  } catch {
    return [];
  }
}

function saveHistory(records: DominanceRecord[]): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(records, null, 2));
}

// ─── Public API ─────────────────────────────────────────

/**
 * Append a dominance record (one per day; duplicate on the same day overwrites with latest)
 */
export function trackBtcDominance(dom: number): void {
  const records = loadHistory();
  const today = new Date().toISOString().slice(0, 10); // UTC date
  const now = Date.now();

  // Remove old record from the same day (overwrite with latest, keep the last analysis of the day)
  const filtered = records.filter((r) => r.date !== today);
  filtered.push({ date: today, dom, ts: now });

  // Sort by date, keep only the most recent MAX_DAYS days
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  saveHistory(filtered.slice(-MAX_DAYS));
}

/**
 * Calculate BTC dominance trend
 * @param windowDays Analysis window (default 7 days)
 * @param neutralThreshold Minimum change to classify as "rising/falling" (default 0.5%)
 */
export function getBtcDominanceTrend(
  windowDays = 7,
  neutralThreshold = 0.5
): DominanceTrend {
  const records = loadHistory();

  if (records.length === 0) {
    return { latest: NaN, oldest: NaN, change: 0, days: 0, direction: "neutral", records: [] };
  }

  const latest = records.at(-1);
  if (!latest) return { latest: NaN, oldest: NaN, change: 0, days: 0, direction: "neutral", records: [] };
  const cutoffDate = new Date(latest.date);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - windowDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Record closest to windowDays ago
  const windowRecords = records.filter((r) => r.date >= cutoff);
  const oldest = windowRecords[0] ?? latest;

  const latestDom = latest.dom;
  const oldestDom = oldest.dom;
  const change = latestDom - oldestDom;
  const daySpan = windowRecords.length;

  let direction: DominanceTrend["direction"] = "neutral";
  if (change > neutralThreshold) direction = "rising";
  else if (change < -neutralThreshold) direction = "falling";

  return {
    latest: latestDom,
    oldest: oldestDom,
    change,
    days: daySpan,
    direction,
    records: windowRecords,
  };
}

/**
 * Get the latest dominance record (returns undefined if no records)
 */
export function getLatestDominance(): DominanceRecord | undefined {
  const records = loadHistory();
  return records[records.length - 1];
}

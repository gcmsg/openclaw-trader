/**
 * Signal Attribution — Domain Module
 *
 * Groups by signal combinations (triggeredRules) and calculates
 * historical win rate, risk-reward ratio, expected return, and
 * other core metrics. Outputs an attribution leaderboard.
 *
 * Note: pnlPercent is stored in ratio format (0.038 = +3.8%),
 * consistent with signal-history.ts. Multiply by 100 for display.
 *
 * CLI entry: src/scripts/signal-attribution.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Production paths (used directly by scripts/signal-attribution.ts)
export const ATTRIBUTION_HISTORY_PATH = path.resolve(
  __dirname,
  "../../logs/signal-history.jsonl"
);
export const ATTRIBUTION_REPORT_PATH = path.resolve(
  __dirname,
  "../../reports/signal-attribution.json"
);

// ─── Types ──────────────────────────────────────────────

export interface AttributionSignalRecord {
  id: string;
  symbol: string;
  type: "buy" | "short";
  entryPrice: number;
  entryTime: number;
  entryConditions: {
    triggeredRules?: string[];
    maShort?: number;
    maLong?: number;
    rsi?: number;
  };
  status: "open" | "closed";
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  pnl?: number;
  /** PnL ratio (ratio format, 0.038 = +3.8%, consistent with signal-history.ts) */
  pnlPercent?: number;
  holdingHours?: number;
  scenarioId?: string;
}

export interface GroupStats {
  key: string;           // signal combo identifier (rules sorted and joined)
  rules: string[];       // triggered signal conditions
  signalType: string;    // "buy" | "short" | "mixed"
  total: number;         // total signal count
  closed: number;        // closed position count
  open: number;          // still holding
  wins: number;          // winning trades
  losses: number;        // losing trades
  winRate: number;       // win rate (has value when closed > 0)
  /** average PnL (ratio format, multiply by 100 for percentage) */
  avgPnlPct: number;
  /** average win (ratio format) */
  avgWinPct: number;
  /** average loss (ratio format, absolute value) */
  avgLossPct: number;
  rrRatio: number;       // risk-reward ratio = |avgWin| / |avgLoss|
  avgHoldHours: number;  // average holding hours
  /** cumulative PnL (ratio format, multiply by 100 for percentage) */
  totalPnlPct: number;
  symbols: string[];     // involved symbols
  stopLossCount: number; // stop loss trigger count
}

// ─── Load Data ──────────────────────────────────────────

/**
 * Load all signal records from signal-history.jsonl.
 * @param historyPath Optional custom path (default: logs/signal-history.jsonl)
 */
export function loadAttributionHistory(
  historyPath?: string
): AttributionSignalRecord[] {
  const filePath = historyPath ?? ATTRIBUTION_HISTORY_PATH;
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  const records: AttributionSignalRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as AttributionSignalRecord);
    } catch { /* skip corrupted lines */ }
  }
  return records;
}

// ─── Group Statistics ─────────────────────────────────────────

/**
 * Group by signal combinations (triggeredRules + type) and calculate
 * statistics for each group. Returns stats array sorted by cumulative PnL descending.
 */
export function analyzeGroups(records: AttributionSignalRecord[]): GroupStats[] {
  const groups = new Map<string, AttributionSignalRecord[]>();

  for (const rec of records) {
    const rules = (rec.entryConditions.triggeredRules ?? ["unknown"]).slice().sort();
    const key = `${rec.type}:${rules.join("+")}`;
    const existing = groups.get(key) ?? [];
    existing.push(rec);
    groups.set(key, existing);
  }

  const stats: GroupStats[] = [];

  for (const [key, recs] of groups) {
    const firstRec = recs[0];
    if (!firstRec) continue;

    const rules = (firstRec.entryConditions.triggeredRules ?? ["unknown"]).slice().sort();
    const closed = recs.filter((r) => r.status === "closed");
    const open = recs.filter((r) => r.status === "open");

    const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
    const losses = closed.filter((r) => (r.pnlPercent ?? 0) <= 0);

    const avgPnlPct = closed.length > 0
      ? closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / closed.length
      : 0;

    const avgWinPct = wins.length > 0
      ? wins.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / wins.length
      : 0;

    const avgLossPct = losses.length > 0
      ? Math.abs(losses.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / losses.length)
      : 0;

    const rrRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : 0;

    const withHours = closed.filter((r) => r.holdingHours !== undefined);
    const avgHoldHours = withHours.length > 0
      ? withHours.reduce((s, r) => s + (r.holdingHours ?? 0), 0) / withHours.length
      : 0;

    const totalPnlPct = closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);
    const symbols = [...new Set(recs.map((r) => r.symbol))];
    const stopLossCount = closed.filter((r) => r.exitReason === "stop_loss").length;

    const types = [...new Set(recs.map((r) => r.type))];
    const signalType = types.length === 1 ? (types[0] ?? "mixed") : "mixed";

    stats.push({
      key,
      rules,
      signalType,
      total: recs.length,
      closed: closed.length,
      open: open.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      avgPnlPct,
      avgWinPct,
      avgLossPct,
      rrRatio,
      avgHoldHours,
      totalPnlPct,
      symbols,
      stopLossCount,
    });
  }

  // Sort by cumulative PnL (ratio) descending
  return stats.sort((a, b) => b.totalPnlPct - a.totalPnlPct);
}

// ─── Report Formatting ───────────────────────────────────────

/**
 * Format attribution report as human-readable text.
 * pnlPercent is stored as ratio (0.038 = +3.8%), multiplied by 100 for display.
 */
export function formatAttributionReport(
  stats: GroupStats[],
  records: AttributionSignalRecord[]
): string {
  const total = records.length;
  const closed = records.filter((r) => r.status === "closed");
  const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
  const totalPnl = closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);

  const lines: string[] = [
    "═".repeat(56),
    "📊 Signal Attribution Report",
    "═".repeat(56),
    `Total signals: ${total} | Closed: ${closed.length} | Pending: ${total - closed.length}`,
    `Overall win rate: ${closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "--"}%`,
    // totalPnl is a sum of ratios, multiply by 100 for percentage display
    `Cumulative PnL: ${totalPnl >= 0 ? "+" : ""}${(totalPnl * 100).toFixed(2)}%`,
    "",
    "─".repeat(56),
    "🏆 Signal Combo Leaderboard (by cumulative PnL)",
    "─".repeat(56),
  ];

  if (stats.length === 0) {
    lines.push("  (No data yet, more trade records needed)");
  }

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (!s) continue;
    const rank = i + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
    // totalPnlPct is a ratio, multiply by 100 for percentage display
    const pnlStr = `${s.totalPnlPct >= 0 ? "+" : ""}${(s.totalPnlPct * 100).toFixed(2)}%`;
    const wrStr = s.closed > 0 ? `${(s.winRate * 100).toFixed(0)}%` : "--";
    const rrStr = s.rrRatio > 0 ? s.rrRatio.toFixed(2) : "--";

    lines.push(`${medal} [${s.signalType.toUpperCase()}] ${s.rules.join(" + ")}`);
    lines.push(
      `   Total${pnlStr} | WinRate${wrStr} | R:R ${rrStr} | ${s.closed} closed | Avg hold ${s.avgHoldHours.toFixed(1)}h`
    );
    if (s.stopLossCount > 0) {
      lines.push(`   ⚠ Stop loss ${s.stopLossCount} times / ${s.closed} trades`);
    }
    if (s.symbols.length > 0 && s.symbols.length <= 4) {
      lines.push(`   Symbols: ${s.symbols.join(", ")}`);
    }
    lines.push("");
  }

  // Suggestions
  const bestGroup = stats[0];
  const worstGroup = stats[stats.length - 1];

  if (bestGroup && worstGroup && stats.length > 1) {
    lines.push("─".repeat(56));
    lines.push("💡 AI Agent attribution suggestions");
    lines.push("─".repeat(56));
    if (bestGroup.winRate >= 0.6 && bestGroup.rrRatio >= 1.5) {
      lines.push(`✅ Reinforce: [${bestGroup.rules.join("+")}] — strong win rate + R:R`);
    } else if (bestGroup.totalPnlPct > 0) {
      lines.push(`📌 Keep monitoring: [${bestGroup.rules.join("+")}] — profitable but small sample`);
    }
    if (worstGroup.totalPnlPct < -0.05 || worstGroup.winRate < 0.4) {
      lines.push(`❌ Consider removing: [${worstGroup.rules.join("+")}] — persistent loss or low win rate`);
    }
  }

  lines.push("═".repeat(56));
  return lines.join("\n");
}

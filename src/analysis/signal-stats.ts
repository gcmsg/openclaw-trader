/**
 * Signal Statistical Analysis
 *
 * Aggregates trade records by signal condition combinations (signalCombo),
 * calculating win rate, risk-reward ratio, expected return, and other core metrics.
 */

import type { TradeRecord } from "./analysis-types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface SignalStat {
  signalCombo: string; // e.g. "ma_bullish+rsi_bullish+macd_bullish"
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1
  avgWinPercent: number; // average win %
  avgLossPercent: number; // average loss % (negative)
  avgRR: number; // average risk-reward ratio = |avgWin| / |avgLoss|
  expectancy: number; // expected return = winRate * avgWin + (1-winRate) * avgLoss
  avgHoldMinutes: number; // average holding time (minutes)
  profitFactor: number; // total profit / |total loss| (Infinity when total loss = 0)
  bestTrade: number; // best single trade %
  worstTrade: number; // worst single trade %
  exitReasons: Record<string, number>; // exit reason counts
}

// ─────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────

/**
 * Convert signalConditions array to a normalized combo string.
 * Sorted and joined with "+", so combos with same content but different order map to the same key.
 */
function toComboKey(conditions: string[]): string {
  if (conditions.length === 0) return "(no_signals)";
  return [...conditions].sort().join("+");
}

// ─────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────

/**
 * Calculate performance statistics for each signal combination from trade records.
 *
 * @param trades     trade record array
 * @param minTrades  minimum trade count to be included in statistics (default: 5)
 * @returns          statistics array sorted by expected return descending
 */
export function calcSignalStats(trades: TradeRecord[], minTrades = 5): SignalStat[] {
  if (trades.length === 0) return [];

  // Group by signalCombo
  const groups = new Map<string, TradeRecord[]>();
  for (const trade of trades) {
    const key = toComboKey(trade.signalConditions);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(trade);
    } else {
      groups.set(key, [trade]);
    }
  }

  const stats: SignalStat[] = [];

  for (const [combo, group] of groups) {
    if (group.length < minTrades) continue;

    const wins = group.filter((t) => t.pnlPercent > 0);
    const losses = group.filter((t) => t.pnlPercent <= 0);

    const winRate = wins.length / group.length;

    const avgWinPercent =
      wins.length > 0
        ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length
        : 0;

    const avgLossPercent =
      losses.length > 0
        ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length
        : 0;

    // Risk-reward ratio = |avgWin| / |avgLoss|
    const avgRR =
      avgLossPercent !== 0 ? Math.abs(avgWinPercent) / Math.abs(avgLossPercent) : Infinity;

    // Expected return
    const expectancy = winRate * avgWinPercent + (1 - winRate) * avgLossPercent;

    // Average holding time (minutes)
    const avgHoldMinutes =
      group.reduce((s, t) => s + t.holdMs, 0) / group.length / 60_000;

    // Profit factor
    const totalWin = wins.reduce((s, t) => s + t.pnlPercent, 0);
    const totalLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPercent), 0);
    const profitFactor = totalLoss === 0 ? (totalWin > 0 ? Infinity : 1) : totalWin / totalLoss;

    // Best/worst single trade
    const allPnl = group.map((t) => t.pnlPercent);
    const bestTrade = Math.max(...allPnl);
    const worstTrade = Math.min(...allPnl);

    // Exit reason counts
    const exitReasons: Record<string, number> = {};
    for (const t of group) {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    }

    stats.push({
      signalCombo: combo,
      totalTrades: group.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWinPercent,
      avgLossPercent,
      avgRR,
      expectancy,
      avgHoldMinutes,
      profitFactor,
      bestTrade,
      worstTrade,
      exitReasons,
    });
  }

  // Sort by expected return descending
  stats.sort((a, b) => b.expectancy - a.expectancy);

  return stats;
}

/**
 * Sort by expected return, output Top N and Bottom N signal combinations.
 *
 * @param stats  result of calcSignalStats() (already sorted descending)
 * @param topN   number of top/bottom entries (default: 5)
 */
export function rankSignals(
  stats: SignalStat[],
  topN = 5
): { best: SignalStat[]; worst: SignalStat[] } {
  if (stats.length === 0) return { best: [], worst: [] };

  const sorted = [...stats].sort((a, b) => b.expectancy - a.expectancy);
  const best = sorted.slice(0, topN);
  const worst = sorted.slice(-topN).reverse();

  return { best, worst };
}

/**
 * Format statistics results as human-readable text (Telegram / CLI output).
 */
export function formatSignalStats(stats: SignalStat[]): string {
  if (stats.length === 0) {
    return "📊 **Signal Stats** — No signal combo data matching criteria";
  }

  const lines: string[] = ["📊 **Signal Combo Statistics**\n"];

  for (const s of stats) {
    const wr = (s.winRate * 100).toFixed(1);
    const exp = s.expectancy >= 0 ? `+${(s.expectancy * 100).toFixed(2)}%` : `${(s.expectancy * 100).toFixed(2)}%`;
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    const rr = s.avgRR === Infinity ? "∞" : s.avgRR.toFixed(2);

    lines.push(`**${s.signalCombo}**`);
    lines.push(
      `  Trades: ${s.totalTrades} | WinRate: ${wr}% | Expectancy: ${exp}`
    );
    lines.push(
      `  AvgWin: +${(s.avgWinPercent * 100).toFixed(2)}% | AvgLoss: ${(s.avgLossPercent * 100).toFixed(2)}% | RR: ${rr}`
    );
    lines.push(
      `  ProfitFactor: ${pf} | Hold: ${s.avgHoldMinutes.toFixed(0)}min | Best: +${(s.bestTrade * 100).toFixed(2)}% | Worst: ${(s.worstTrade * 100).toFixed(2)}%`
    );

    // Exit reason summary (top 3 only)
    const reasonEntries = Object.entries(s.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r}(${c})`)
      .join(" ");
    if (reasonEntries) {
      lines.push(`  Exit: ${reasonEntries}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

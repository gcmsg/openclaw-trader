/**
 * Backtest Report Formatting
 * - Console-friendly output
 * - JSON results saved to logs/backtest/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { BacktestResult } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(__dirname, "../../logs/backtest");

// ─────────────────────────────────────────────────────
// Console Output
// ─────────────────────────────────────────────────────

function pad(str: string, len: number, right = false): string {
  const s = str;
  return right ? s.padStart(len) : s.padEnd(len);
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsdt(n: number): string {
  if (n >= 0) return `+$${n.toFixed(2)}`;
  return `-$${Math.abs(n).toFixed(2)}`;
}

function fmtRatio(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toFixed(2);
}

function line(char = "─", width = 50): string {
  return char.repeat(width);
}

/**
 * Generate human-readable console report text
 */
export function formatReport(result: BacktestResult): string {
  const { metrics: m, perSymbol, config: c } = result;
  const lines: string[] = [];

  const titleWidth = 52;
  lines.push(line("━", titleWidth));
  lines.push(`📊 Backtest Report — ${c.strategy}`);
  lines.push(line("━", titleWidth));
  lines.push("");
  lines.push(`📅 Date Range  ${c.startDate} → ${c.endDate} (${c.days} days)`);
  lines.push(`⏱️  Timeframe   ${c.timeframe}`);
  lines.push(`🪙  Symbols     ${c.symbols.join("  ")}`);
  lines.push(`💵  Initial     $${c.initialUsdt.toFixed(2)}`);
  if ((c.spreadBps ?? 0) > 0) {
    lines.push(`📏  Spread    ${c.spreadBps} bps (${((c.spreadBps ?? 0) / 100).toFixed(3)}%, simulated bid/ask spread)`);
  }
  if (c.signalToNextOpen) {
    lines.push(`⚡  Exec Mode  Next candle open (no look-ahead bias, closer to live)`);
  } else {
    lines.push(`⚠️  Exec Mode  Current candle close (has look-ahead bias) — recommend --next-open`);
  }
  lines.push("");

  // ── Returns ──
  lines.push(line("─", titleWidth));
  lines.push("📈 Returns");
  lines.push(line("─", titleWidth));
  const retEmoji = m.totalReturn >= 0 ? "🟢" : "🔴";
  lines.push(
    `${retEmoji} Total Return     ${pad(fmtUsdt(m.totalReturn), 12, true)}  (${fmtPct(m.totalReturnPercent)})`
  );
  lines.push(
    `   Max Drawdown     ${pad("-" + fmt(m.maxDrawdown) + "%", 12, true)}  ($${fmt(m.maxDrawdownUsdt)})`
  );
  lines.push(`   Sharpe Ratio     ${pad(fmtRatio(m.sharpeRatio), 12, true)}`);
  lines.push(`   Sortino Ratio    ${pad(fmtRatio(m.sortinoRatio), 12, true)}`);
  lines.push(`   Calmar Ratio     ${pad(fmtRatio(m.calmarRatio), 12, true)}  (annualized return / max drawdown)`);
  if (m.benchmarkReturn !== undefined) {
    const bSign = m.benchmarkReturn >= 0 ? "+" : "";
    lines.push(
      `🏆 BTC Hold Return  ${pad(bSign + fmt(m.benchmarkReturn) + "%", 12, true)}  (same-period benchmark)`
    );
    if (m.alpha !== undefined) {
      const aSign = m.alpha >= 0 ? "+" : "";
      const alphaEmoji = m.alpha >= 0 ? "✅" : "⚠️";
      lines.push(
        `${alphaEmoji} Alpha Excess     ${pad(aSign + fmt(m.alpha) + "%", 12, true)}  (strategy - BTC hold)`
      );
    }
  }
  lines.push("");

  // ── Trade Statistics ──
  lines.push(line("─", titleWidth));
  lines.push("🎯 Trade Statistics");
  lines.push(line("─", titleWidth));
  lines.push(`   Total Trades     ${pad(String(m.totalTrades), 12, true)}`);
  lines.push(
    `   Win Rate         ${pad(fmt(m.winRate * 100) + "%", 12, true)}  (${m.wins} wins / ${m.losses} losses)`
  );
  lines.push(`   Profit Factor    ${pad(fmtRatio(m.profitFactor), 12, true)}`);
  lines.push(
    `   Win/Loss Ratio   ${pad(fmtRatio(m.winLossRatio) + ":1", 12, true)}  (avg win ${fmtPct(m.avgWinPercent)} / avg loss -${fmt(m.avgLossPercent)}%)`
  );
  lines.push(`   Avg Hold         ${pad(fmt(m.avgHoldingHours) + " hours", 12, true)}`);
  lines.push(`   Best Trade       ${pad(fmtPct(m.bestTradePct), 12, true)}`);
  lines.push(`   Worst Trade      ${pad(fmtPct(m.worstTradePct), 12, true)}`);
  lines.push("");

  // ── Exit Reasons ──
  lines.push(line("─", titleWidth));
  lines.push("🚪 Exit Reasons");
  lines.push(line("─", titleWidth));
  if (m.totalTrades > 0) {
    const total = m.totalTrades;
    lines.push(
      `   Signal Exit      ${pad(String(m.signalExitCount), 6, true)}  (${fmt((m.signalExitCount / total) * 100)}%)`
    );
    lines.push(
      `   Take Profit      ${pad(String(m.takeProfitCount), 6, true)}  (${fmt((m.takeProfitCount / total) * 100)}%)`
    );
    lines.push(
      `   Stop Loss        ${pad(String(m.stopLossCount), 6, true)}  (${fmt((m.stopLossCount / total) * 100)}%)`
    );
    if (m.trailingStopCount > 0) {
      lines.push(
        `   Trailing Stop    ${pad(String(m.trailingStopCount), 6, true)}  (${fmt((m.trailingStopCount / total) * 100)}%)`
      );
    }
    if (m.endOfDataCount > 0) {
      lines.push(
        `   Forced Close     ${pad(String(m.endOfDataCount), 6, true)}  (${fmt((m.endOfDataCount / total) * 100)}%)`
      );
    }
  } else {
    lines.push("   No trade data yet");
  }
  lines.push("");

  // ── Per-Symbol Performance ──
  lines.push(line("─", titleWidth));
  lines.push("🪙  Per-Symbol Performance");
  lines.push(line("─", titleWidth));
  const symEntries = Object.entries(perSymbol).sort(([, a], [, b]) => b.pnl - a.pnl);
  for (const [sym, stats] of symEntries) {
    const wr = stats.trades > 0 ? `${fmt(stats.winRate * 100)}%` : "─";
    const pnlStr = stats.pnl >= 0 ? `+$${fmt(stats.pnl)}` : `-$${fmt(Math.abs(stats.pnl))}`;
    const emoji = stats.pnl > 0 ? "🟢" : stats.pnl < 0 ? "🔴" : "⚪";
    lines.push(
      `  ${emoji} ${pad(sym.replace("USDT", ""), 6)}  ${pad(`${stats.trades} trades`, 10, true)}  WR ${pad(wr, 7, true)}  ${pnlStr}`
    );
  }
  lines.push("");

  lines.push(line("━", titleWidth));

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// JSON Report Saving
// ─────────────────────────────────────────────────────

/**
 * Save backtest results as a JSON file
 * Returns the saved file path
 */
export function saveReport(result: BacktestResult, label?: string): string {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const stratSlug = result.config.strategy.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const suffix = label ? `-${label}` : "";
  const filename = `backtest-${stratSlug}-${result.config.days}d-${dateStr}${suffix}.json`;
  const filePath = path.join(REPORT_DIR, filename);

  // Downsample equity curve when saving (every 10th point, to avoid large files)
  const SAMPLE = 10;
  const sampledCurve = result.metrics.equityCurve.filter((_, i) => i % SAMPLE === 0);

  const reportData = {
    ...result,
    metrics: {
      ...result.metrics,
      equityCurve: sampledCurve,
    },
    // Only keep closing records (completed trades): sell (close long) + cover (close short)
    trades: result.trades.filter((t) => t.side === "sell" || t.side === "cover"),
  };

  fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2));
  return filePath;
}

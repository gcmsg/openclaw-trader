/**
 * Weekly review report generator
 * Analyzes trade records from all enabled scenarios over the past 7 days, generates structured report
 * Sends to AI Agent for deep analysis and pushes to Telegram
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { loadAccount, type PaperTrade } from "../paper/account.js";
import { loadPaperConfig, loadStrategyProfile } from "../config/loader.js";
import { ping } from "../health/heartbeat.js";
import { createLogger } from "../logger.js";

// ─────────────────────────────────────────────────────
// Lightweight performance metrics (calculated directly from PaperTrade, no full backtest data needed)
// ─────────────────────────────────────────────────────
interface PerformanceMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  profitFactor: number;
  winLossRatio: number; // avgWin / avgLoss
  expectancy: number;   // Expected value (average expected PnL per trade)
}

function calcPerformanceMetrics(
  trades: PaperTrade[],
  initialUsdt: number
): PerformanceMetrics | null {
  // Closed trades: sell (close long) + cover (close short) both count
  const sells = trades.filter((t) => (t.side === "sell" || t.side === "cover") && t.pnl !== undefined);
  if (sells.length < 3) return null; // Too few trades, metrics not statistically meaningful

  const pnls = sells.map((t) => t.pnl ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);

  // ── Win/Loss ratio / Profit Factor ──
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const winRate = sells.length > 0 ? wins.length / sells.length : 0;
  const expectancy = avgWin * winRate - avgLoss * (1 - winRate);

  // ── Equity curve -> per-trade return rate ──
  const pnlPcts = sells.map((t) => t.pnlPercent ?? (t.pnl ?? 0) / initialUsdt);
  const mean = pnlPcts.reduce((s, r) => s + r, 0) / pnlPcts.length;
  const variance = pnlPcts.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / pnlPcts.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(pnlPcts.length) : 0;

  const downReturns = pnlPcts.filter((r) => r < 0);
  const downDev =
    downReturns.length > 0
      ? Math.sqrt(downReturns.reduce((s, r) => s + r * r, 0) / downReturns.length)
      : 0;
  const sortinoRatio = downDev > 0 ? (mean / downDev) * Math.sqrt(pnlPcts.length) : 0;

  // ── Max drawdown (based on cumulative equity curve) ──
  let equity = initialUsdt;
  let peak = initialUsdt;
  let maxDrawdownPct = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return { sharpeRatio, sortinoRatio, maxDrawdownPct: maxDrawdownPct * 100, profitFactor, winLossRatio, expectancy };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(__dirname, "../../logs/reports");
const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
const log = createLogger("weekly", path.resolve(__dirname, "../../logs/weekly-report.log"));

// ─────────────────────────────────────────────────────
// Statistical calculations
// ─────────────────────────────────────────────────────

interface TradeStats {
  totalTrades: number;
  buys: number;
  sells: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxProfit: number;
  maxLoss: number;
  avgHoldingHours: number;
  bestSymbol: string;
  worstSymbol: string;
  symbolStats: Record<string, { trades: number; pnl: number }>;
}

function calcTradeStats(trades: PaperTrade[], since: number): TradeStats {
  const periodTrades = trades.filter((t) => t.timestamp >= since);
  // Closed trades: sell (close long) + cover (close short) both count
  const sells = periodTrades.filter((t) => (t.side === "sell" || t.side === "cover") && t.pnl !== undefined);
  // Entry trades: buy (open long) + short (open short) both count (for calculating avg holding time)
  const buys = periodTrades.filter((t) => t.side === "buy" || t.side === "short");

  if (sells.length === 0) {
    return {
      totalTrades: periodTrades.length,
      buys: buys.length,
      sells: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      maxProfit: 0,
      maxLoss: 0,
      avgHoldingHours: 0,
      bestSymbol: "-",
      worstSymbol: "-",
      symbolStats: {},
    };
  }

  const wins = sells.filter((t) => (t.pnl ?? 0) > 0);
  const losses = sells.filter((t) => (t.pnl ?? 0) <= 0);
  const totalPnl = sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const pnls = sells.map((t) => t.pnl ?? 0);

  // Average holding time
  let totalHours = 0,
    pairsCount = 0;
  for (const sell of sells) {
    const matchBuy = [...buys]
      .filter((b) => b.symbol === sell.symbol && b.timestamp < sell.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (matchBuy) {
      totalHours += (sell.timestamp - matchBuy.timestamp) / 3600000;
      pairsCount++;
    }
  }

  const symbolStats: Record<string, { trades: number; pnl: number }> = {};
  for (const t of sells) {
    const stat = symbolStats[t.symbol] ?? { trades: 0, pnl: 0 };
    symbolStats[t.symbol] = stat;
    stat.trades++;
    stat.pnl += t.pnl ?? 0;
  }

  const sortedSymbols = Object.entries(symbolStats).sort((a, b) => b[1].pnl - a[1].pnl);

  return {
    totalTrades: periodTrades.length,
    buys: buys.length,
    sells: sells.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / sells.length,
    totalPnl,
    avgPnl: totalPnl / sells.length,
    maxProfit: Math.max(...pnls),
    maxLoss: Math.min(...pnls),
    avgHoldingHours: pairsCount > 0 ? totalHours / pairsCount : 0,
    bestSymbol: sortedSymbols[0]?.[0] ?? "-",
    worstSymbol: sortedSymbols[sortedSymbols.length - 1]?.[0] ?? "-",
    symbolStats,
  };
}

// ─────────────────────────────────────────────────────
// Single scenario report structure
// ─────────────────────────────────────────────────────

interface ScenarioReport {
  scenarioId: string;
  scenarioName: string;
  strategyName: string;
  market: string;
  leverage: string;
  account: { initialUsdt: number; currentUsdt: number; totalPnl: number; totalPnlPercent: number };
  stats: TradeStats;
  metrics: PerformanceMetrics | null; // Sharpe/Sortino/max drawdown etc. (null when trades < 3)
}

// ─────────────────────────────────────────────────────
// Report generation (multi-scenario)
// ─────────────────────────────────────────────────────

export function generateWeeklyReport(): ScenarioReport[] {
  log.info("─── Starting weekly report generation ───");

  const paperCfg = loadPaperConfig();
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const reports: ScenarioReport[] = [];

  for (const scenario of paperCfg.scenarios) {
    const profile = (() => {
      try {
        return loadStrategyProfile(scenario.strategy_id);
      } catch (_e: unknown) {
        return null;
      }
    })();
    const account = loadAccount(scenario.initial_usdt, scenario.id);
    const lev = scenario.exchange.leverage;

    const stats = calcTradeStats(account.trades, weekAgo);
    const currentEquity = account.usdt; // Position market value needs real-time price, simplified
    const totalPnl = currentEquity - account.initialUsdt;

    reports.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      strategyName: profile?.name ?? scenario.strategy_id,
      market: scenario.exchange.market.toUpperCase(),
      leverage: lev?.enabled ? `${lev.default}x` : "None",
      account: {
        initialUsdt: account.initialUsdt,
        currentUsdt: currentEquity,
        totalPnl,
        totalPnlPercent: totalPnl / account.initialUsdt,
      },
      stats,
      metrics: calcPerformanceMetrics(account.trades.filter((t) => t.timestamp >= weekAgo), account.initialUsdt),
    });

    log.info(
      `Scenario [${scenario.id}]: ${stats.totalTrades} trades, PnL ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`
    );
  }

  // Save summary report
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `weekly-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(
    path.join(REPORT_DIR, filename),
    JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)
  );
  log.info(`Report saved: ${filename}`);

  return reports;
}

// ─────────────────────────────────────────────────────
// Format and send to Agent
// ─────────────────────────────────────────────────────

function formatReportForAgent(reports: ScenarioReport[]): string {
  const now = new Date().toLocaleString("en-US");
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toLocaleString("en-US");

  const scenarioBlocks = reports
    .sort((a, b) => b.account.totalPnlPercent - a.account.totalPnlPercent)
    .map((r) => {
      const pnlSign = r.account.totalPnl >= 0 ? "+" : "";
      const pnlEmoji = r.account.totalPnl >= 0 ? "📈" : "📉";
      const symbolSummary =
        Object.entries(r.stats.symbolStats)
          .sort(([, a], [, b]) => b.pnl - a.pnl)
          .map(
            ([sym, s]) => `  - ${sym}: ${s.trades} trades, ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`
          )
          .join("\n") || "  No closed trades yet";

      const mStr = r.metrics
        ? [
            `- Sharpe Ratio: ${r.metrics.sharpeRatio.toFixed(2)} | Sortino: ${r.metrics.sortinoRatio.toFixed(2)}`,
            `- Max Drawdown: ${r.metrics.maxDrawdownPct.toFixed(2)}% | Profit Factor: ${r.metrics.profitFactor.toFixed(2)}`,
            `- Win/Loss Ratio: ${r.metrics.winLossRatio.toFixed(2)} | Expectancy: ${r.metrics.expectancy >= 0 ? "+" : ""}$${r.metrics.expectancy.toFixed(2)}/trade`,
          ].join("\n")
        : "- Performance Metrics: Insufficient trades (requires >= 3)";

      return `
### ${r.scenarioName} [${r.strategyName} × ${r.market} ${r.leverage}]
${pnlEmoji} Total PnL: ${pnlSign}$${r.account.totalPnl.toFixed(2)} (${pnlSign}${(r.account.totalPnlPercent * 100).toFixed(2)}%)
- Trades: ${r.stats.totalTrades} (Buy ${r.stats.buys}/Sell ${r.stats.sells})
- Win Rate: ${r.stats.sells > 0 ? (r.stats.winRate * 100).toFixed(1) + "%" : "No completed trades"}
- Max Single Profit: +$${r.stats.maxProfit.toFixed(2)} | Max Single Loss: $${r.stats.maxLoss.toFixed(2)}
- Avg Holding: ${r.stats.avgHoldingHours.toFixed(1)} hours
${mStr}
By Symbol:\n${symbolSummary}`.trim();
    })
    .join("\n\n---\n\n");

  return `Please provide a professional review analysis of the following [Paper Trading Multi-Strategy Weekly Report] and give strategy optimization suggestions.

## 📅 Reporting Period
${weekAgo} ~ ${now}

${scenarioBlocks}

## Analysis Tasks
1. **Strategy Comparison**: Which strategy/scenario performed best? Why?
2. **Signal Quality**: How is the signal quality of each strategy under current market conditions?
3. **Risk Control**: Are stop-loss/take-profit settings reasonable? Any parameters that need tightening or loosening?
4. **Improvement Directions**: Provide 2-3 specific actionable parameter tuning suggestions
5. **Next Week Outlook**: Based on current market technicals, what are the strategy recommendations for next week?

Please reply and send to Telegram to notify the user.`.trim();
}

export function sendWeeklyReportToAgent(reports: ScenarioReport[]): void {
  const message = formatReportForAgent(reports);
  const args = ["system", "event", "--mode", "now"];
  if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
  args.push("--text", message);

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
  if (result.status !== 0) {
    log.error(`❌ Send failed: ${result.stderr}`);
  } else {
    log.info("✅ Weekly report sent to AI Agent");
  }
}

// ─────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────

const done = ping("weekly_report");
const reports = generateWeeklyReport();
sendWeeklyReportToAgent(reports);
done();
log.info("─── Weekly report generation complete ───\n");

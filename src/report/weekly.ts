/**
 * 周报复盘生成器
 * 分析所有启用场景过去 7 天的交易记录，生成结构化报告
 * 发送给 AI Agent（Mia）进行深度分析并推送 Telegram
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { loadAccount, type PaperTrade } from "../paper/account.js";
import { loadPaperConfig, loadStrategyProfile } from "../config/loader.js";
import { ping } from "../health/heartbeat.js";

// ─────────────────────────────────────────────────────
// 轻量绩效指标（从 PaperTrade 直接计算，无需完整回测数据）
// ─────────────────────────────────────────────────────
interface PerformanceMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  profitFactor: number;
  winLossRatio: number; // avgWin / avgLoss
  expectancy: number;   // 期望收益（每笔交易平均可期望的盈亏）
}

function calcPerformanceMetrics(
  trades: PaperTrade[],
  initialUsdt: number
): PerformanceMetrics | null {
  const sells = trades.filter((t) => t.side === "sell" && t.pnl !== undefined);
  if (sells.length < 3) return null; // 数据太少，指标没有统计意义

  const pnls = sells.map((t) => t.pnl ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);

  // ── 盈亏比 / 利润因子 ──
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const winRate = sells.length > 0 ? wins.length / sells.length : 0;
  const expectancy = avgWin * winRate - avgLoss * (1 - winRate);

  // ── 权益曲线 → 逐笔收益率 ──
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

  // ── 最大回撤（基于累计权益曲线）──
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
const LOG_PATH = path.resolve(__dirname, "../../logs/weekly-report.log");
const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// ─────────────────────────────────────────────────────
// 统计计算
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
  const sells = periodTrades.filter((t) => t.side === "sell" && t.pnl !== undefined);
  const buys = periodTrades.filter((t) => t.side === "buy");

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

  // 平均持仓时间
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
// 单场景报告结构
// ─────────────────────────────────────────────────────

interface ScenarioReport {
  scenarioId: string;
  scenarioName: string;
  strategyName: string;
  market: string;
  leverage: string;
  account: { initialUsdt: number; currentUsdt: number; totalPnl: number; totalPnlPercent: number };
  stats: TradeStats;
  metrics: PerformanceMetrics | null; // 夏普/索提诺/最大回撤等（交易数 < 3 时为 null）
}

// ─────────────────────────────────────────────────────
// 报告生成（多场景）
// ─────────────────────────────────────────────────────

export function generateWeeklyReport(): ScenarioReport[] {
  log("─── 开始生成周报 ───");

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
    const currentEquity = account.usdt; // 持仓市值需实时价格，简化处理
    const totalPnl = currentEquity - account.initialUsdt;

    reports.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      strategyName: profile?.name ?? scenario.strategy_id,
      market: scenario.exchange.market.toUpperCase(),
      leverage: lev?.enabled ? `${lev.default}x` : "无",
      account: {
        initialUsdt: account.initialUsdt,
        currentUsdt: currentEquity,
        totalPnl,
        totalPnlPercent: totalPnl / account.initialUsdt,
      },
      stats,
      metrics: calcPerformanceMetrics(account.trades.filter((t) => t.timestamp >= weekAgo), account.initialUsdt),
    });

    log(
      `场景 [${scenario.id}]: ${stats.totalTrades} 笔交易, 盈亏 ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`
    );
  }

  // 保存汇总报告
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `weekly-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(
    path.join(REPORT_DIR, filename),
    JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)
  );
  log(`报告已保存: ${filename}`);

  return reports;
}

// ─────────────────────────────────────────────────────
// 格式化并发送给 Agent
// ─────────────────────────────────────────────────────

function formatReportForAgent(reports: ScenarioReport[]): string {
  const now = new Date().toLocaleString("zh-CN");
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toLocaleString("zh-CN");

  const scenarioBlocks = reports
    .sort((a, b) => b.account.totalPnlPercent - a.account.totalPnlPercent)
    .map((r) => {
      const pnlSign = r.account.totalPnl >= 0 ? "+" : "";
      const pnlEmoji = r.account.totalPnl >= 0 ? "📈" : "📉";
      const symbolSummary =
        Object.entries(r.stats.symbolStats)
          .sort(([, a], [, b]) => b.pnl - a.pnl)
          .map(
            ([sym, s]) => `  - ${sym}: ${s.trades} 笔, ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`
          )
          .join("\n") || "  暂无已平仓交易";

      const mStr = r.metrics
        ? [
            `- 夏普比率: ${r.metrics.sharpeRatio.toFixed(2)} | 索提诺: ${r.metrics.sortinoRatio.toFixed(2)}`,
            `- 最大回撤: ${r.metrics.maxDrawdownPct.toFixed(2)}% | 利润因子: ${r.metrics.profitFactor.toFixed(2)}`,
            `- 盈亏比: ${r.metrics.winLossRatio.toFixed(2)} | 期望收益: ${r.metrics.expectancy >= 0 ? "+" : ""}$${r.metrics.expectancy.toFixed(2)}/笔`,
          ].join("\n")
        : "- 绩效指标: 交易数不足（需 ≥ 3 笔）";

      return `
### ${r.scenarioName} [${r.strategyName} × ${r.market} ${r.leverage}]
${pnlEmoji} 总盈亏: ${pnlSign}$${r.account.totalPnl.toFixed(2)} (${pnlSign}${(r.account.totalPnlPercent * 100).toFixed(2)}%)
- 交易: ${r.stats.totalTrades} 笔（买 ${r.stats.buys}/卖 ${r.stats.sells}）
- 胜率: ${r.stats.sells > 0 ? (r.stats.winRate * 100).toFixed(1) + "%" : "无完成交易"}
- 最大单笔盈利: +$${r.stats.maxProfit.toFixed(2)} | 最大单笔亏损: $${r.stats.maxLoss.toFixed(2)}
- 平均持仓: ${r.stats.avgHoldingHours.toFixed(1)} 小时
${mStr}
各币种:\n${symbolSummary}`.trim();
    })
    .join("\n\n---\n\n");

  return `请对以下【模拟盘多策略周报】进行专业复盘分析，并给出策略优化建议。

## 📅 统计周期
${weekAgo} ~ ${now}

${scenarioBlocks}

## 分析任务
1. **策略横向对比**：哪个策略/场景表现最好？原因是什么？
2. **信号质量**：当前市场环境下各策略信号质量如何？
3. **风险控制**：各场景的止损止盈是否合理？是否有需要收紧或放宽的参数？
4. **改进方向**：给出 2-3 条具体可执行的参数调优建议
5. **下周展望**：基于当前市场技术面，下周策略操作建议？

请用中文回复，发送到 Telegram 通知主人。`.trim();
}

export function sendWeeklyReportToAgent(reports: ScenarioReport[]): void {
  const message = formatReportForAgent(reports);
  const args = ["system", "event", "--mode", "now"];
  if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
  args.push("--text", message);

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
  if (result.status !== 0) {
    log(`❌ 发送失败: ${result.stderr}`);
  } else {
    log("✅ 周报已发送给 AI Agent");
  }
}

// ─────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────

const done = ping("weekly_report");
const reports = generateWeeklyReport();
sendWeeklyReportToAgent(reports);
done();
log("─── 周报生成完成 ───\n");

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

      return `
### ${r.scenarioName} [${r.strategyName} × ${r.market} ${r.leverage}]
${pnlEmoji} 总盈亏: ${pnlSign}$${r.account.totalPnl.toFixed(2)} (${pnlSign}${(r.account.totalPnlPercent * 100).toFixed(2)}%)
- 交易: ${r.stats.totalTrades} 笔（买 ${r.stats.buys}/卖 ${r.stats.sells}）
- 胜率: ${r.stats.sells > 0 ? (r.stats.winRate * 100).toFixed(1) + "%" : "无完成交易"}
- 最大单笔盈利: +$${r.stats.maxProfit.toFixed(2)} | 最大单笔亏损: $${r.stats.maxLoss.toFixed(2)}
- 平均持仓: ${r.stats.avgHoldingHours.toFixed(1)} 小时
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

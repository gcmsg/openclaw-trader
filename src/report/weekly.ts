/**
 * 周报复盘生成器
 * 分析过去 7 天的交易记录，生成结构化报告
 * 发送给 AI Agent（Mia）进行深度分析并推送 Telegram
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { parse } from "yaml";
import { loadAccount, type PaperTrade } from "../paper/account.js";
import type { StrategyConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/strategy.yaml");
const REPORT_DIR = path.resolve(__dirname, "../../logs/reports");
const LOG_PATH = path.resolve(__dirname, "../../logs/weekly-report.log");

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
      wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgPnl: 0, maxProfit: 0, maxLoss: 0,
      avgHoldingHours: 0,
      bestSymbol: "-", worstSymbol: "-",
      symbolStats: {},
    };
  }

  const wins = sells.filter((t) => (t.pnl ?? 0) > 0);
  const losses = sells.filter((t) => (t.pnl ?? 0) <= 0);
  const totalPnl = sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const pnls = sells.map((t) => t.pnl ?? 0);
  const maxProfit = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  // 计算平均持仓时间（配对 buy/sell）
  let totalHours = 0;
  let pairsCount = 0;
  for (const sell of sells) {
    const matchBuy = [...buys]
      .filter((b) => b.symbol === sell.symbol && b.timestamp < sell.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (matchBuy) {
      totalHours += (sell.timestamp - matchBuy.timestamp) / 3600000;
      pairsCount++;
    }
  }

  // 按币种统计
  const symbolStats: Record<string, { trades: number; pnl: number }> = {};
  for (const t of sells) {
    if (!symbolStats[t.symbol]) symbolStats[t.symbol] = { trades: 0, pnl: 0 };
    symbolStats[t.symbol].trades++;
    symbolStats[t.symbol].pnl += t.pnl ?? 0;
  }

  const sortedSymbols = Object.entries(symbolStats).sort((a, b) => b[1].pnl - a[1].pnl);
  const bestSymbol = sortedSymbols[0]?.[0] ?? "-";
  const worstSymbol = sortedSymbols[sortedSymbols.length - 1]?.[0] ?? "-";

  return {
    totalTrades: periodTrades.length,
    buys: buys.length,
    sells: sells.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / sells.length,
    totalPnl,
    avgPnl: totalPnl / sells.length,
    maxProfit,
    maxLoss,
    avgHoldingHours: pairsCount > 0 ? totalHours / pairsCount : 0,
    bestSymbol,
    worstSymbol,
    symbolStats,
  };
}

// ─────────────────────────────────────────────────────
// 报告生成
// ─────────────────────────────────────────────────────

interface WeeklyReport {
  period: { start: string; end: string };
  account: { initialUsdt: number; currentUsdt: number; totalPnl: number; totalPnlPercent: number };
  stats: TradeStats;
  signalLog: { total: number; triggered: number; skipped: number; reduced: number };
  mode: string;
}

export async function generateWeeklyReport(): Promise<WeeklyReport> {
  log("─── 开始生成周报 ───");

  const cfg = parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as StrategyConfig;
  const account = loadAccount();

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const stats = calcTradeStats(account.trades, weekAgo);
  const currentEquity = account.usdt; // 简化：只算 USDT（持仓市值需实时价格）
  const totalPnl = currentEquity - account.initialUsdt;

  const report: WeeklyReport = {
    period: {
      start: new Date(weekAgo).toLocaleString("zh-CN"),
      end: new Date(now).toLocaleString("zh-CN"),
    },
    account: {
      initialUsdt: account.initialUsdt,
      currentUsdt: currentEquity,
      totalPnl,
      totalPnlPercent: totalPnl / account.initialUsdt,
    },
    stats,
    signalLog: { total: 0, triggered: 0, skipped: 0, reduced: 0 }, // TODO: 后续从日志文件解析
    mode: cfg.mode,
  };

  // 保存报告文件
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `weekly-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(path.join(REPORT_DIR, filename), JSON.stringify(report, null, 2));
  log(`报告已保存: ${filename}`);

  return report;
}

// ─────────────────────────────────────────────────────
// 发送给 AI Agent 进行深度分析
// ─────────────────────────────────────────────────────

function formatReportForAgent(report: WeeklyReport): string {
  const { stats, account } = report;
  const pnlSign = account.totalPnl >= 0 ? "+" : "";
  const pnlEmoji = account.totalPnl >= 0 ? "📈" : "📉";

  const symbolSummary = Object.entries(stats.symbolStats)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([sym, s]) => `  - ${sym}: ${s.trades} 笔, 盈亏 ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`)
    .join("\n");

  return `
请对以下【模拟盘周报数据】进行专业的复盘分析，并给出策略优化建议。

## 📅 统计周期
${report.period.start} ~ ${report.period.end}

## 💰 账户状态（模式: ${report.mode}）
- 初始资金: $${account.initialUsdt}
- 当前余额: $${account.currentUsdt.toFixed(2)}
- ${pnlEmoji} 本周净盈亏: ${pnlSign}$${account.totalPnl.toFixed(2)} (${pnlSign}${(account.totalPnlPercent * 100).toFixed(2)}%)

## 📊 交易统计
- 总交易次数: ${stats.totalTrades}（买 ${stats.buys} / 卖 ${stats.sells}）
- 胜率: ${stats.sells > 0 ? (stats.winRate * 100).toFixed(1) + "%" : "无完成交易"}
- 盈利笔数: ${stats.wins} | 亏损笔数: ${stats.losses}
- 单笔最大盈利: +$${stats.maxProfit.toFixed(2)}
- 单笔最大亏损: $${stats.maxLoss.toFixed(2)}
- 平均每笔盈亏: ${stats.avgPnl >= 0 ? "+" : ""}$${stats.avgPnl.toFixed(2)}
- 平均持仓时长: ${stats.avgHoldingHours.toFixed(1)} 小时

## 🪙 各币种表现
${symbolSummary || "  暂无已平仓交易"}
- 最佳: ${stats.bestSymbol}
- 最差: ${stats.worstSymbol}

## 分析任务
请从以下维度进行复盘并给出具体建议：
1. **策略表现**：当前 MA+RSI+MACD 组合的信号质量如何？胜率是否符合预期？
2. **风险控制**：止损是否合理？有没有需要调整的参数？
3. **市场适应性**：当前市场环境（趋势/震荡）适合什么策略？
4. **改进方向**：具体建议调整哪些参数？是否要增减监控币种？
5. **下周展望**：基于当前技术指标和市场情绪，下周操作建议？

请用中文回复，发送到 Telegram 通知主人。
`.trim();
}

export async function sendWeeklyReportToAgent(report: WeeklyReport): Promise<void> {
  const message = formatReportForAgent(report);
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
  const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const tokenFlag = GATEWAY_TOKEN ? `--token ${GATEWAY_TOKEN}` : "";

  try {
    execSync(
      `${OPENCLAW_BIN} system event --mode now ${tokenFlag} --text ${JSON.stringify(message)}`,
      { stdio: "pipe", timeout: 15000 }
    );
    log("✅ 周报已发送给 AI Agent");
  } catch (err) {
    log(`❌ 发送失败: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────

const report = await generateWeeklyReport();
await sendWeeklyReportToAgent(report);
log("─── 周报生成完成 ───\n");

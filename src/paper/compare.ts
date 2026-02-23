/**
 * 多策略横向对比报告
 * 用法: npm run paper:compare
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPaperConfig, loadStrategyConfig, buildPaperRuntime, loadStrategyProfile } from "../config/loader.js";
import { loadAccount, calcTotalEquity, getAccountPath } from "./account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─────────────────────────────────────────────────────
// 数据收集
// ─────────────────────────────────────────────────────

interface ScenarioStats {
  id: string;
  name: string;
  strategyName: string;
  market: string;
  leverage: string;
  initialUsdt: number;
  currentUsdt: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPct: number;
  openPositions: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  maxSingleWinPct: number;
  maxSingleLossPct: number;
  dailyLoss: number;
  hasData: boolean;       // false = 账户文件不存在（尚未触发任何信号）
}

function collectStats(base: ReturnType<typeof loadStrategyConfig>, paperCfg: ReturnType<typeof loadPaperConfig>): ScenarioStats[] {
  return paperCfg.scenarios.map((scenario) => {
    const profile = (() => { try { return loadStrategyProfile(scenario.strategy_id); } catch { return null; } })();
    const strategyName = profile?.name ?? scenario.strategy_id;
    const exc = scenario.exchange;
    const lev = exc.leverage;
    const leverageLabel = lev?.enabled ? `${lev.default}x` : "无";
    const marketLabel = exc.market.toUpperCase();

    const accountPath = getAccountPath(scenario.id);
    if (!fs.existsSync(accountPath)) {
      return {
        id: scenario.id,
        name: scenario.name,
        strategyName,
        market: marketLabel,
        leverage: leverageLabel,
        initialUsdt: scenario.initial_usdt,
        currentUsdt: scenario.initial_usdt,
        totalEquity: scenario.initial_usdt,
        totalPnl: 0,
        totalPnlPct: 0,
        openPositions: 0,
        totalTrades: 0,
        winTrades: 0,
        lossTrades: 0,
        winRate: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        maxSingleWinPct: 0,
        maxSingleLossPct: 0,
        dailyLoss: 0,
        hasData: false,
      };
    }

    const account = loadAccount(scenario.initial_usdt, scenario.id);
    const equity = calcTotalEquity(account, {}); // 不含持仓浮动

    const closedSells = account.trades.filter((t) => t.side === "sell" && t.pnl !== undefined);
    const winners = closedSells.filter((t) => (t.pnl ?? 0) > 0);
    const losers = closedSells.filter((t) => (t.pnl ?? 0) <= 0);
    const winRate = closedSells.length > 0 ? winners.length / closedSells.length : 0;
    const avgWinPct = winners.length > 0
      ? winners.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / winners.length * 100 : 0;
    const avgLossPct = losers.length > 0
      ? losers.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / losers.length * 100 : 0;
    const maxWin = winners.length > 0 ? Math.max(...winners.map((t) => (t.pnlPercent ?? 0) * 100)) : 0;
    const maxLoss = losers.length > 0 ? Math.min(...losers.map((t) => (t.pnlPercent ?? 0) * 100)) : 0;

    return {
      id: scenario.id,
      name: scenario.name,
      strategyName,
      market: marketLabel,
      leverage: leverageLabel,
      initialUsdt: account.initialUsdt,
      currentUsdt: account.usdt,
      totalEquity: equity,
      totalPnl: equity - account.initialUsdt,
      totalPnlPct: (equity - account.initialUsdt) / account.initialUsdt * 100,
      openPositions: Object.keys(account.positions).length,
      totalTrades: account.trades.length,
      winTrades: winners.length,
      lossTrades: losers.length,
      winRate,
      avgWinPct,
      avgLossPct,
      maxSingleWinPct: maxWin,
      maxSingleLossPct: maxLoss,
      dailyLoss: account.dailyLoss?.loss ?? 0,
      hasData: true,
    };
  });
}

// ─────────────────────────────────────────────────────
// 格式化输出
// ─────────────────────────────────────────────────────

function bar(pct: number, width = 20): string {
  const filled = Math.round(Math.abs(pct) / 5 * (width / 4)); // 每 5% 一格，最多 width 格
  const clamped = Math.min(filled, width);
  return pct >= 0
    ? "▓".repeat(clamped) + "░".repeat(width - clamped)
    : "▒".repeat(clamped) + "░".repeat(width - clamped);
}

function fmt(n: number, decimals = 2, sign = false): string {
  const s = n.toFixed(decimals);
  return sign && n > 0 ? `+${s}` : s;
}

function printCompareReport(stats: ScenarioStats[]): void {
  const now = new Date().toLocaleString("zh-CN");
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  📊 多策略对比报告  ${now}`);
  console.log(`${"═".repeat(72)}\n`);

  // 按总盈亏排名
  const sorted = [...stats].sort((a, b) => b.totalPnlPct - a.totalPnlPct);

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const rank = i + 1;
    const rankEmoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `  #${rank}`;
    const pnlEmoji = s.totalPnl >= 0 ? "📈" : "📉";
    const pnlSign = s.totalPnl >= 0 ? "+" : "";
    const statusTag = !s.hasData ? " [无数据]" : "";

    console.log(`${rankEmoji}  ${s.name}${statusTag}`);
    console.log(`    策略: ${s.strategyName}  |  市场: ${s.market}  |  杠杆: ${s.leverage}`);
    console.log(`    ${pnlEmoji} 总盈亏: ${pnlSign}$${fmt(s.totalPnl)}  (${pnlSign}${fmt(s.totalPnlPct)}%)`);
    console.log(`    ${bar(s.totalPnlPct)} ${fmt(s.totalPnlPct, 1, true)}%`);

    if (s.hasData && s.totalTrades > 0) {
      console.log(`    💼 总资产: $${fmt(s.totalEquity)} | 持仓: ${s.openPositions} 个`);
      console.log(`    📈 交易: ${s.totalTrades} 笔 | 盈: ${s.winTrades} | 亏: ${s.lossTrades} | 胜率: ${fmt(s.winRate * 100, 1)}%`);
      if (s.winTrades > 0 || s.lossTrades > 0) {
        console.log(`    🎯 均盈: ${fmt(s.avgWinPct, 1, true)}%  均亏: ${fmt(s.avgLossPct, 1)}%  最大盈: ${fmt(s.maxSingleWinPct, 1, true)}%  最大亏: ${fmt(s.maxSingleLossPct, 1)}%`);
      }
    } else if (!s.hasData) {
      console.log(`    ℹ️  账户尚未建立（等待第一个交易信号）`);
    }
    console.log();
  }

  // 快速汇总表格
  console.log(`${"─".repeat(72)}`);
  console.log(`  场景                      收益率     胜率    总交易  持仓`);
  console.log(`${"─".repeat(72)}`);
  for (const s of sorted) {
    const nameCol = s.name.padEnd(26).slice(0, 26);
    const pnl = `${fmt(s.totalPnlPct, 1, true)}%`.padStart(8);
    const wr = s.totalTrades > 0 ? `${fmt(s.winRate * 100, 0)}%`.padStart(6) : " -- ".padStart(6);
    const trades = String(s.totalTrades).padStart(6);
    const pos = String(s.openPositions).padStart(4);
    console.log(`  ${nameCol}  ${pnl}  ${wr}  ${trades}  ${pos}`);
  }
  console.log(`${"═".repeat(72)}\n`);
}

// ─────────────────────────────────────────────────────
// 导出（供 report/weekly.ts 使用）
// ─────────────────────────────────────────────────────

export function generateCompareReport(): ScenarioStats[] {
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();
  return collectStats(base, paperCfg);
}

export function formatCompareReport(stats: ScenarioStats[]): string {
  const now = new Date().toLocaleString("zh-CN");
  const sorted = [...stats].sort((a, b) => b.totalPnlPct - a.totalPnlPct);
  const lines: string[] = [`📊 **多策略对比报告** ${now}`, ``];

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const rankEmoji = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const pnlSign = s.totalPnl >= 0 ? "+" : "";
    lines.push(`${rankEmoji} **${s.name}** (${s.strategyName})`);
    lines.push(`  收益: ${pnlSign}${fmt(s.totalPnlPct, 2)}%  胜率: ${s.totalTrades > 0 ? fmt(s.winRate * 100, 0) + "%" : "--"}  交易: ${s.totalTrades} 笔`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// CLI 入口
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();
  const stats = collectStats(base, paperCfg);
  printCompareReport(stats);

  // 同时保存 JSON 快照
  const outPath = path.join(LOGS_DIR, "compare-latest.json");
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), stats }, null, 2));
  console.log(`💾 JSON 已保存: ${outPath}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });

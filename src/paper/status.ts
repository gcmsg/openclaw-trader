/**
 * 查看所有模拟盘场景状态
 * 用法: npm run paper:status [scenarioId]
 *   不带参数 → 显示所有启用场景的摘要
 *   带参数   → 显示指定场景的详细信息
 */

import { getPriceChanges } from "../news/fetcher.js";
import { loadAccount, getAccountSummary, getAccountPath } from "./account.js";
import { loadPaperConfig, loadStrategyProfile } from "../config/loader.js";
import type { PaperTrade } from "./account.js";
import fs from "fs";

const args = process.argv.slice(2);
const filterScenario = args[0]; // 可选：指定场景 ID

const paperCfg = loadPaperConfig();
const allScenarios = filterScenario
  ? paperCfg.scenarios.filter((s) => s.id === filterScenario)
  : paperCfg.scenarios.filter((s) => s.enabled);

if (allScenarios.length === 0) {
  console.log(filterScenario ? `场景 "${filterScenario}" 不存在` : "没有启用的场景");
  process.exit(1);
}

// 收集所有场景持仓的 symbol，统一拉取价格（减少 API 请求）
const allSymbols = new Set<string>(["BTCUSDT", "ETHUSDT"]);
for (const s of allScenarios) {
  if (!fs.existsSync(getAccountPath(s.id))) continue;
  const account = loadAccount(s.initial_usdt, s.id);
  for (const sym of Object.keys(account.positions)) allSymbols.add(sym);
}

const priceChanges = await getPriceChanges([...allSymbols]);
const prices: Record<string, number> = {};
for (const p of priceChanges) prices[p.symbol] = p.price;

// ─────────────────────────────────────────────────────
// 详细视图（单个场景）
// ─────────────────────────────────────────────────────

function printDetail(scenarioId: string, scenarioName: string, strategyId: string, initialUsdt: number): void {
  const profile = (() => { try { return loadStrategyProfile(strategyId); } catch { return null; } })();
  const account = fs.existsSync(getAccountPath(scenarioId))
    ? loadAccount(initialUsdt, scenarioId)
    : null;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊 ${scenarioName}  [${strategyId}]`);
  if (profile?.description) console.log(`  ℹ️  ${profile.description}`);
  console.log(`${"═".repeat(60)}`);

  if (!account) {
    console.log(`  ⏳ 账户未建立（等待第一个交易信号）`);
    console.log(`${"═".repeat(60)}\n`);
    return;
  }

  const summary = getAccountSummary(account, prices);
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";

  console.log(`  💰 USDT 余额    : $${summary.usdt.toFixed(2)}`);
  console.log(`  💼 总资产       : $${summary.totalEquity.toFixed(2)}`);
  console.log(`  ${pnlEmoji} 总盈亏         : ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`);
  console.log(`  🔴 今日亏损     : $${summary.dailyLoss.toFixed(2)}`);
  console.log(`${"─".repeat(60)}`);

  if (summary.positions.length === 0) {
    console.log(`  📭 当前无持仓`);
  } else {
    console.log(`  📋 持仓 (${summary.positions.length} 个):`);
    for (const pos of summary.positions) {
      const sign = pos.unrealizedPnl >= 0 ? "+" : "";
      const emoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      console.log(`     ${emoji} ${pos.symbol.padEnd(10)} 买入: $${pos.entryPrice.toFixed(4)}  现价: $${pos.currentPrice.toFixed(4)}  盈亏: ${sign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`);
      console.log(`        止损: $${pos.stopLoss.toFixed(4)}  止盈: $${pos.takeProfit.toFixed(4)}`);
    }
  }

  console.log(`${"─".repeat(60)}`);
  console.log(`  📈 总交易次数   : ${summary.tradeCount}   胜率: ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "暂无"}`);

  const recentTrades: PaperTrade[] = account.trades.slice(-8).reverse();
  if (recentTrades.length > 0) {
    console.log(`${"─".repeat(60)}`);
    console.log(`  🕐 最近交易:`);
    for (const t of recentTrades) {
      const emoji = t.side === "buy" ? "🟢" : "🔴";
      const pnl = t.pnl !== undefined ? `  ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
      const time = new Date(t.timestamp).toLocaleString("zh-CN");
      console.log(`     ${emoji} [${time}] ${t.side === "buy" ? "买" : "卖"} ${t.symbol} @$${t.price.toFixed(4)}${pnl}`);
    }
  }
  console.log(`${"═".repeat(60)}\n`);
}

// ─────────────────────────────────────────────────────
// 摘要视图（所有场景）
// ─────────────────────────────────────────────────────

function printSummary(): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  📊 模拟盘快览  ${new Date().toLocaleString("zh-CN")}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ${"场景".padEnd(24)} ${"策略".padEnd(14)} ${"市场".padEnd(12)} ${"总盈亏".padStart(10)}  胜率`);
  console.log(`${"─".repeat(70)}`);

  for (const s of allScenarios) {
    if (!fs.existsSync(getAccountPath(s.id))) {
      console.log(`  ${s.name.padEnd(24)} ${s.strategy_id.padEnd(14)} ${s.exchange.market.toUpperCase().padEnd(12)} ${"[无数据]".padStart(10)}`);
      continue;
    }
    const account = loadAccount(s.initial_usdt, s.id);
    const equity = account.usdt + Object.values(account.positions).reduce((sum, pos) => {
      const px = prices[pos.symbol]; return px ? sum + pos.quantity * px : sum;
    }, 0);
    const pnlPct = (equity - account.initialUsdt) / account.initialUsdt * 100;
    const sells = account.trades.filter((t) => t.side === "sell" && t.pnl !== undefined);
    const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
    const wr = sells.length > 0 ? `${(wins / sells.length * 100).toFixed(0)}%` : "--";
    const pnlStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;

    const profile = (() => { try { return loadStrategyProfile(s.strategy_id); } catch { return null; } })();
    const stratName = (profile?.name ?? s.strategy_id).padEnd(14).slice(0, 14);

    console.log(`  ${s.name.padEnd(24)} ${stratName} ${s.exchange.market.toUpperCase().padEnd(12)} ${pnlStr.padStart(10)}  ${wr}`);
  }
  console.log(`${"═".repeat(70)}`);
  console.log(`\n  💡 详情: npm run paper:status <scenarioId>`);
  console.log(`  📊 对比: npm run paper:compare\n`);
}

// ─────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────

if (filterScenario) {
  const s = allScenarios[0];
  printDetail(s.id, s.name, s.strategy_id, s.initial_usdt);
} else {
  printSummary();
  // 如果有持仓，额外打印持仓详情
  for (const s of allScenarios) {
    if (!fs.existsSync(getAccountPath(s.id))) continue;
    const account = loadAccount(s.initial_usdt, s.id);
    if (Object.keys(account.positions).length > 0) {
      printDetail(s.id, s.name, s.strategy_id, s.initial_usdt);
    }
  }
}

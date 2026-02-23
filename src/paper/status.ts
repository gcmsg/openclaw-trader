/**
 * 查看模拟盘账户状态
 * 用法: npm run paper:status
 */

import { getPriceChanges } from "../news/fetcher.js";
import { loadAccount, getAccountSummary } from "./account.js";
import type { PaperTrade } from "./account.js";

const account = loadAccount();

// 拉取当前价格
const symbols = [
  ...Object.keys(account.positions),
  "BTCUSDT", "ETHUSDT",
].filter((v, i, a) => a.indexOf(v) === i);

const priceChanges = await getPriceChanges(symbols);
const prices: Record<string, number> = {};
for (const p of priceChanges) prices[p.symbol] = p.price;

const summary = getAccountSummary(account, prices);

// ─────────────────────────────────────────────────────
// 输出格式化报告
// ─────────────────────────────────────────────────────

const pnlSign = summary.totalPnl >= 0 ? "+" : "";
const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";

console.log(`\n${"═".repeat(55)}`);
console.log(`  📊  模拟盘账户状态  ${new Date().toLocaleString("zh-CN")}`);
console.log(`${"═".repeat(55)}`);
console.log(`  💰 USDT 余额    : $${summary.usdt.toFixed(2)}`);
console.log(`  💼 总资产       : $${summary.totalEquity.toFixed(2)}`);
console.log(`  ${pnlEmoji} 总盈亏         : ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`);
console.log(`${"─".repeat(55)}`);

if (summary.positions.length === 0) {
  console.log(`  📭 当前无持仓`);
} else {
  console.log(`  📋 持仓 (${summary.positions.length} 个):`);
  for (const pos of summary.positions) {
    const sign = pos.unrealizedPnl >= 0 ? "+" : "";
    const emoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
    console.log(`     ${emoji} ${pos.symbol.padEnd(10)} 买入: $${pos.entryPrice.toFixed(4)}  现价: $${pos.currentPrice.toFixed(4)}  盈亏: ${sign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`);
  }
}

console.log(`${"─".repeat(55)}`);
console.log(`  📈 总交易次数   : ${summary.tradeCount}`);
console.log(`  🎯 胜率         : ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "暂无数据"}`);

// 最近 10 笔交易
const recentTrades: PaperTrade[] = account.trades.slice(-10).reverse();
if (recentTrades.length > 0) {
  console.log(`${"─".repeat(55)}`);
  console.log(`  🕐 最近交易记录:`);
  for (const t of recentTrades) {
    const side = t.side === "buy" ? "买" : "卖";
    const emoji = t.side === "buy" ? "🟢" : "🔴";
    const pnl = t.pnl !== undefined ? `  盈亏: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
    const time = new Date(t.timestamp).toLocaleString("zh-CN");
    console.log(`     ${emoji} [${time}] ${side} ${t.symbol} @$${t.price.toFixed(4)}${pnl}`);
  }
}

console.log(`${"═".repeat(55)}\n`);

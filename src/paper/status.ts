/**
 * View all paper trading scenario statuses
 * Usage: npm run paper:status [scenarioId]
 *   Without arguments -> show summary of all enabled scenarios
 *   With argument     -> show detailed info for specified scenario
 */

import { getPriceChanges } from "../news/fetcher.js";
import { loadAccount, getAccountSummary, getAccountPath, calcTotalEquity } from "./account.js";
import { loadPaperConfig, loadStrategyProfile } from "../config/loader.js";
import type { PaperTrade } from "./account.js";
import fs from "fs";

const args = process.argv.slice(2);
const filterScenario = args[0]; // Optional: specify scenario ID

const paperCfg = loadPaperConfig();
const allScenarios = filterScenario
  ? paperCfg.scenarios.filter((s) => s.id === filterScenario)
  : paperCfg.scenarios.filter((s) => s.enabled);

if (allScenarios.length === 0) {
  console.log(filterScenario ? `Scenario "${filterScenario}" not found` : "No enabled scenarios");
  process.exit(1);
}

// Collect all symbols with positions across scenarios, fetch prices in batch (reduce API calls)
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
// Detail view (single scenario)
// ─────────────────────────────────────────────────────

function printDetail(
  scenarioId: string,
  scenarioName: string,
  strategyId: string,
  initialUsdt: number
): void {
  const profile = (() => {
    try {
      return loadStrategyProfile(strategyId);
    } catch (_e: unknown) {
      return null;
    }
  })();
  const account = fs.existsSync(getAccountPath(scenarioId))
    ? loadAccount(initialUsdt, scenarioId)
    : null;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊 ${scenarioName}  [${strategyId}]`);
  if (profile?.description) console.log(`  ℹ️  ${profile.description}`);
  console.log("═".repeat(60));

  if (!account) {
    console.log(`  ⏳ Account not yet created (waiting for first trade signal)`);
    console.log(`${"═".repeat(60)}\n`);
    return;
  }

  const summary = getAccountSummary(account, prices);
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";

  console.log(`  💰 USDT Balance   : $${summary.usdt.toFixed(2)}`);
  console.log(`  💼 Total Equity   : $${summary.totalEquity.toFixed(2)}`);
  console.log(
    `  ${pnlEmoji} Total PnL        : ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`
  );
  console.log(`  🔴 Daily Loss     : $${summary.dailyLoss.toFixed(2)}`);
  console.log("─".repeat(60));

  if (summary.positions.length === 0) {
    console.log(`  📭 No open positions`);
  } else {
    console.log(`  📋 Positions (${summary.positions.length}):`);
    for (const pos of summary.positions) {
      const sign = pos.unrealizedPnl >= 0 ? "+" : "";
      const emoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      console.log(
        `     ${emoji} ${pos.symbol.padEnd(10)} Entry: $${pos.entryPrice.toFixed(4)}  Current: $${pos.currentPrice.toFixed(4)}  PnL: ${sign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`
      );
      console.log(`        SL: $${pos.stopLoss.toFixed(4)}  TP: $${pos.takeProfit.toFixed(4)}`);
    }
  }

  console.log("─".repeat(60));
  console.log(
    `  📈 Total Trades   : ${summary.tradeCount}   Win Rate: ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "N/A"}`
  );

  const recentTrades: PaperTrade[] = account.trades.slice(-8).reverse();
  if (recentTrades.length > 0) {
    console.log("─".repeat(60));
    console.log(`  🕐 Recent Trades:`);
    for (const t of recentTrades) {
      const emoji = t.side === "buy" ? "🟢" : t.side === "short" ? "🔵" : t.side === "cover" ? "🟣" : "🔴";
      const label = t.side === "buy" ? "LONG" : t.side === "short" ? "SHORT" : t.side === "cover" ? "COVER" : "SELL";
      const pnl = t.pnl !== undefined ? `  ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
      const time = new Date(t.timestamp).toLocaleString("en-US");
      console.log(
        `     ${emoji} [${time}] ${label} ${t.symbol} @$${t.price.toFixed(4)}${pnl}`
      );
    }
  }
  console.log(`${"═".repeat(60)}\n`);
}

// ─────────────────────────────────────────────────────
// Summary view (all scenarios)
// ─────────────────────────────────────────────────────

function printSummary(): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  📊 Paper Trading Overview  ${new Date().toLocaleString("en-US")}`);
  console.log("═".repeat(70));
  console.log(
    `  ${"Scenario".padEnd(24)} ${"Strategy".padEnd(14)} ${"Market".padEnd(12)} ${"Total PnL".padStart(10)}  Win%`
  );
  console.log("─".repeat(70));

  for (const s of allScenarios) {
    if (!fs.existsSync(getAccountPath(s.id))) {
      console.log(
        `  ${s.name.padEnd(24)} ${s.strategy_id.padEnd(14)} ${s.exchange.market.toUpperCase().padEnd(12)} ${"[no data]".padStart(10)}`
      );
      continue;
    }
    const account = loadAccount(s.initial_usdt, s.id);
    // Use calcTotalEquity to correctly handle both long and short positions (short: margin + unrealized PnL)
    const equity = calcTotalEquity(account, prices);
    const pnlPct = ((equity - account.initialUsdt) / account.initialUsdt) * 100;
    // Closed trades: sell (close long) + cover (close short) are both counted in statistics
    const sells = account.trades.filter((t) => (t.side === "sell" || t.side === "cover") && t.pnl !== undefined);
    const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
    const wr = sells.length > 0 ? `${((wins / sells.length) * 100).toFixed(0)}%` : "--";
    const pnlStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;

    const profile = (() => {
      try {
        return loadStrategyProfile(s.strategy_id);
      } catch (_e: unknown) {
        return null;
      }
    })();
    const stratName = (profile?.name ?? s.strategy_id).padEnd(14).slice(0, 14);

    console.log(
      `  ${s.name.padEnd(24)} ${stratName} ${s.exchange.market.toUpperCase().padEnd(12)} ${pnlStr.padStart(10)}  ${wr}`
    );
  }
  console.log("═".repeat(70));
  console.log(`\n  💡 Details: npm run paper:status <scenarioId>`);
  console.log(`  📊 Compare: npm run paper:compare\n`);
}

// ─────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────

if (filterScenario) {
  const s = allScenarios[0];
  if (!s) {
    console.log("No matching scenario found");
    process.exit(1);
  }
  printDetail(s.id, s.name, s.strategy_id, s.initial_usdt);
} else {
  printSummary();
  // If there are open positions, print position details
  for (const s of allScenarios) {
    if (!fs.existsSync(getAccountPath(s.id))) continue;
    const account = loadAccount(s.initial_usdt, s.id);
    if (Object.keys(account.positions).length > 0) {
      printDetail(s.id, s.name, s.strategy_id, s.initial_usdt);
    }
  }
}

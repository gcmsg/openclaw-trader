/**
 * manual-trade.ts — Manual trade execution script (Testnet)
 *
 * Usage:
 *   npx tsx src/scripts/manual-trade.ts close DOGEUSDT testnet-default
 *   npx tsx src/scripts/manual-trade.ts buy AVAXUSDT testnet-default
 *   npx tsx src/scripts/manual-trade.ts status testnet-default
 */

import { logSignal, closeSignal } from "../strategy/signal-history.js";
import { getPrice } from "../exchange/binance.js";
import {
  loadAccount as _loadAccount,
  saveAccount as _saveAccount,
  type PaperAccount,
  type PaperPosition as Position,
} from "../paper/account.js";

// ── Account ───────────────────────────────────────────────
// manual-trade's Trade retains entryPrice/holdMs for readability display,
// not forced to align with PaperTrade (which requires slippage field, not applicable here)
interface Trade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  usdtAmount: number;
  fee: number;
  pnl?: number;
  pnlPercent?: number;
  entryPrice?: number;
  holdMs?: number;
  reason: string;
  timestamp: number;
}

interface ManualAccount {
  initialUsdt: number;
  usdt: number;
  positions: Record<string, Position>;
  trades: Trade[];
}

// Delegates to account.ts, uses atomic write (.tmp -> rename), prevents account file corruption on unexpected process exit
function loadAccount(scenarioId: string): ManualAccount {
  // ManualAccount is a relaxed superset of PaperAccount (extra holdMs display fields), structurally compatible
  return _loadAccount(10000, scenarioId) as unknown as ManualAccount;
}

function saveAccount(scenarioId: string, account: ManualAccount): void {
  // ManualAccount.trades has a few extra display fields compared to PaperTrade, JSON structurally compatible
  _saveAccount(account as unknown as PaperAccount, scenarioId);
}

// ── Price fetching (reuses getPrice from exchange/binance.ts) ──
const fetchPrice = getPrice;

// ── Close Position ───────────────────────────────────────
async function closePosition(symbol: string, scenarioId: string, reason = "manual_close"): Promise<void> {
  const account = loadAccount(scenarioId);
  const pos = account.positions[symbol];
  if (!pos) {
    console.log(`❌ No ${symbol} position found`);
    return;
  }

  const price = await fetchPrice(symbol);
  const usdtReturn = pos.quantity * price;
  const fee = usdtReturn * 0.001;
  const pnl = usdtReturn - fee - pos.quantity * pos.entryPrice;
  const pnlPct = (pnl / (pos.quantity * pos.entryPrice)) * 100;

  const now = Date.now();
  const holdMs = now - pos.entryTime;

  const trade: Trade = {
    id: `manual_${now}_${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side: "sell",
    price,
    quantity: pos.quantity,
    usdtAmount: usdtReturn - fee,
    fee,
    pnl,
    pnlPercent: pnlPct / 100,
    entryPrice: pos.entryPrice,
    holdMs,
    reason,
    timestamp: now,
  };

  account.usdt += usdtReturn - fee;
  delete account.positions[symbol];
  account.trades.push(trade);
  saveAccount(scenarioId, account);

  // Update signal-history.jsonl
  if (pos.signalHistoryId) {
    closeSignal(pos.signalHistoryId, price, "manual", pnl);
  }

  const sign = pnl >= 0 ? "+" : "";
  console.log(`✅ Closed ${symbol} @$${price.toFixed(4)} | PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`);
  console.log(`💵 Account balance: $${account.usdt.toFixed(2)}`);
}

// ── Open Position ───────────────────────────────────────
async function openPosition(
  symbol: string,
  scenarioId: string,
  usdtAmount: number,
  reason = "manual_buy",
  stopLossPct = 5,
  takeProfitPct = 15
): Promise<void> {
  const account = loadAccount(scenarioId);

  if (account.positions[symbol]) {
    console.log(`⚠️  ${symbol} already has a position, skipping`);
    return;
  }
  if (account.usdt < usdtAmount) {
    console.log(`❌ Insufficient balance: $${account.usdt.toFixed(2)} < $${usdtAmount}`);
    return;
  }

  const price = await fetchPrice(symbol);
  const fee = usdtAmount * 0.001;
  const netUsdt = usdtAmount - fee;
  const slippage = price * 0.0005;
  const entryPrice = price + slippage;
  const quantity = netUsdt / entryPrice;
  const stopLoss = entryPrice * (1 - stopLossPct / 100);
  const takeProfit = entryPrice * (1 + takeProfitPct / 100);

  const signalHistoryId = logSignal({
    symbol,
    type: "buy",
    entryPrice,
    scenarioId,
    source: "paper",
    notes: reason,
  });

  const pos: Position = {
    symbol,
    side: "long",
    quantity,
    entryPrice,
    entryTime: Date.now(),
    stopLoss,
    takeProfit,
    signalHistoryId,
  };

  const trade: Trade = {
    id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side: "buy",
    price: entryPrice,
    quantity,
    usdtAmount,
    fee,
    reason,
    timestamp: Date.now(),
  };

  account.usdt -= usdtAmount;
  account.positions[symbol] = pos;
  account.trades.push(trade);
  saveAccount(scenarioId, account);

  console.log(`✅ Bought ${symbol} @$${entryPrice.toFixed(4)} x ${quantity.toFixed(4)}`);
  console.log(`   Amount: $${usdtAmount} | SL: $${stopLoss.toFixed(4)} (-${stopLossPct}%) | TP: $${takeProfit.toFixed(4)} (+${takeProfitPct}%)`);
  console.log(`💵 Account balance: $${account.usdt.toFixed(2)}`);
}

// ── Status ───────────────────────────────────────────────
async function showStatus(scenarioId: string): Promise<void> {
  const account = loadAccount(scenarioId);
  console.log(`\n📊 Testnet [${scenarioId}] Account Status`);
  console.log(`💵 USDT: $${account.usdt.toFixed(2)}`);
  console.log(`📋 Positions (${Object.keys(account.positions).length}):`);

  for (const [sym, pos] of Object.entries(account.positions)) {
    const price = await fetchPrice(sym);
    const pnl = (price - pos.entryPrice) * pos.quantity;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const sign = pnl >= 0 ? "+" : "";
    console.log(
      `  ${sym}: ${pos.quantity.toFixed(4)} | entry=$${pos.entryPrice.toFixed(4)} | now=$${price.toFixed(4)} | PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`
    );
  }
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

// ── Main Entry ─────────────────────────────────────────────
const [, , action, symbol, scenarioId = "testnet-default", ...rest] = process.argv;

if (action === "close") {
  await closePosition(symbol!, scenarioId);
} else if (action === "buy") {
  const usdt = rest[0] ? parseFloat(rest[0]) : 800;
  await openPosition(symbol!, scenarioId, usdt, "manual_analysis_buy");
} else if (action === "status") {
  await showStatus(symbol ?? scenarioId);
} else {
  console.log("Usage: manual-trade.ts <close|buy|status> <SYMBOL> [scenarioId] [usdtAmount]");
}

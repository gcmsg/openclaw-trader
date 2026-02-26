/**
 * mia-trade.ts — Mia 自主交易执行脚本（Testnet）
 *
 * 用法：
 *   npx tsx src/scripts/mia-trade.ts close DOGEUSDT testnet-default
 *   npx tsx src/scripts/mia-trade.ts buy AVAXUSDT testnet-default
 *   npx tsx src/scripts/mia-trade.ts status testnet-default
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ── 账户 ───────────────────────────────────────────────
interface Position {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
}

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
  reason: string;
  timestamp: number;
}

interface PaperAccount {
  initialUsdt: number;
  usdt: number;
  positions: Record<string, Position>;
  trades: Trade[];
}

function loadAccount(scenarioId: string): PaperAccount {
  const p = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PaperAccount;
  } catch {
    return { initialUsdt: 10000, usdt: 10000, positions: {}, trades: [] };
  }
}

function saveAccount(scenarioId: string, account: PaperAccount): void {
  const p = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  fs.writeFileSync(p, JSON.stringify(account, null, 2));
}

// ── 价格获取 ───────────────────────────────────────────
function fetchPrice(symbol: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.binance.com",
      path: `/api/v3/ticker/price?symbol=${symbol}`,
      method: "GET",
      agent: new https.Agent({ family: 4 }),
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(parseFloat((JSON.parse(data) as { price: string }).price)); }
        catch { reject(new Error(`Price parse failed: ${data.slice(0, 100)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── 关仓 ───────────────────────────────────────────────
async function closePosition(symbol: string, scenarioId: string, reason = "mia_manual_close"): Promise<void> {
  const account = loadAccount(scenarioId);
  const pos = account.positions[symbol];
  if (!pos) {
    console.log(`❌ 没有 ${symbol} 持仓`);
    return;
  }

  const price = await fetchPrice(symbol);
  const usdtReturn = pos.quantity * price;
  const fee = usdtReturn * 0.001;
  const pnl = usdtReturn - fee - pos.quantity * pos.entryPrice;
  const pnlPct = (pnl / (pos.quantity * pos.entryPrice)) * 100;

  const trade: Trade = {
    id: `mia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side: "sell",
    price,
    quantity: pos.quantity,
    usdtAmount: usdtReturn - fee,
    fee,
    pnl,
    pnlPercent: pnlPct / 100,
    reason,
    timestamp: Date.now(),
  };

  account.usdt += usdtReturn - fee;
  delete account.positions[symbol];
  account.trades.push(trade);
  saveAccount(scenarioId, account);

  const sign = pnl >= 0 ? "+" : "";
  console.log(`✅ 平仓 ${symbol} @$${price.toFixed(4)} | PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`);
  console.log(`💵 账户余额: $${account.usdt.toFixed(2)}`);
}

// ── 开仓 ───────────────────────────────────────────────
async function openPosition(
  symbol: string,
  scenarioId: string,
  usdtAmount: number,
  reason = "mia_manual_buy",
  stopLossPct = 5,
  takeProfitPct = 15
): Promise<void> {
  const account = loadAccount(scenarioId);

  if (account.positions[symbol]) {
    console.log(`⚠️  ${symbol} 已有持仓，跳过`);
    return;
  }
  if (account.usdt < usdtAmount) {
    console.log(`❌ 余额不足：$${account.usdt.toFixed(2)} < $${usdtAmount}`);
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

  const pos: Position = {
    symbol,
    side: "long",
    quantity,
    entryPrice,
    entryTime: Date.now(),
    stopLoss,
    takeProfit,
  };

  const trade: Trade = {
    id: `mia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

  console.log(`✅ 买入 ${symbol} @$${entryPrice.toFixed(4)} × ${quantity.toFixed(4)}`);
  console.log(`   金额: $${usdtAmount} | SL: $${stopLoss.toFixed(4)} (-${stopLossPct}%) | TP: $${takeProfit.toFixed(4)} (+${takeProfitPct}%)`);
  console.log(`💵 账户余额: $${account.usdt.toFixed(2)}`);
}

// ── 状态 ───────────────────────────────────────────────
async function showStatus(scenarioId: string): Promise<void> {
  const account = loadAccount(scenarioId);
  console.log(`\n📊 Testnet [${scenarioId}] 账户状态`);
  console.log(`💵 USDT: $${account.usdt.toFixed(2)}`);
  console.log(`📋 持仓 (${Object.keys(account.positions).length}):`);

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

// ── 主入口 ─────────────────────────────────────────────
const [, , action, symbol, scenarioId = "testnet-default", ...rest] = process.argv;

if (action === "close") {
  await closePosition(symbol!, scenarioId);
} else if (action === "buy") {
  const usdt = rest[0] ? parseFloat(rest[0]) : 800;
  await openPosition(symbol!, scenarioId, usdt, "mia_analysis_buy");
} else if (action === "status") {
  await showStatus(symbol ?? scenarioId);
} else {
  console.log("用法: mia-trade.ts <close|buy|status> <SYMBOL> [scenarioId] [usdtAmount]");
}

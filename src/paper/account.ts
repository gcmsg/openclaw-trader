/**
 * Paper Trading 虚拟账户管理
 * 使用真实市场价格，本地模拟买卖
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../logs/paper-account.json");

export interface PaperPosition {
  symbol: string;
  quantity: number;       // 持仓数量
  entryPrice: number;     // 买入均价
  entryTime: number;      // 买入时间戳
}

export interface PaperTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  usdtAmount: number;     // 成交金额（含手续费）
  fee: number;            // 手续费
  timestamp: number;
  reason: string;         // 触发原因（信号描述）
  pnl?: number;           // 卖出时的盈亏（USDT）
  pnlPercent?: number;    // 盈亏百分比
}

export interface PaperAccount {
  initialUsdt: number;    // 初始资金
  usdt: number;           // 当前 USDT 余额
  positions: Record<string, PaperPosition>;  // 当前持仓
  trades: PaperTrade[];   // 全部历史交易
  createdAt: number;
  updatedAt: number;
}

const FEE_RATE = 0.001; // 0.1% 手续费（模拟 VIP0）

function generateId(): string {
  return `P${Date.now().toString(36).toUpperCase()}`;
}

export function loadAccount(): PaperAccount {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as PaperAccount;
  } catch {
    // 初始化账户：默认 1000 USDT
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveAccount(account);
    return account;
  }
}

export function saveAccount(account: PaperAccount): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  account.updatedAt = Date.now();
  fs.writeFileSync(STATE_PATH, JSON.stringify(account, null, 2));
}

/**
 * 模拟买入
 * @param symbol 交易对（如 ETHUSDT）
 * @param price  当前价格
 * @param usdtAmount 投入 USDT 数量（undefined = 使用单笔仓位比例）
 * @param reason 买入原因
 * @param positionRatio 仓位比例（默认 0.2，即总资金 20%）
 */
export function paperBuy(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  positionRatio = 0.2
): PaperTrade | null {
  // 已有持仓则不重复买入
  if (account.positions[symbol]) {
    return null;
  }

  const totalEquity = calcTotalEquity(account, { [symbol]: price });
  const usdtToSpend = totalEquity * positionRatio;

  if (usdtToSpend < 1 || usdtToSpend > account.usdt) {
    return null; // 余额不足或投入金额过小
  }

  const fee = usdtToSpend * FEE_RATE;
  const actualUsdt = usdtToSpend - fee;
  const quantity = actualUsdt / price;

  // 更新账户
  account.usdt -= usdtToSpend;
  account.positions[symbol] = {
    symbol,
    quantity,
    entryPrice: price,
    entryTime: Date.now(),
  };

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "buy",
    quantity,
    price,
    usdtAmount: usdtToSpend,
    fee,
    timestamp: Date.now(),
    reason,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * 模拟卖出（全仓）
 */
export function paperSell(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string
): PaperTrade | null {
  const position = account.positions[symbol];
  if (!position) return null;

  const grossUsdt = position.quantity * price;
  const fee = grossUsdt * FEE_RATE;
  const netUsdt = grossUsdt - fee;

  // 计算盈亏
  const costBasis = position.quantity * position.entryPrice;
  const pnl = netUsdt - costBasis;
  const pnlPercent = pnl / costBasis;

  // 更新账户
  account.usdt += netUsdt;
  delete account.positions[symbol];

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "sell",
    quantity: position.quantity,
    price,
    usdtAmount: netUsdt,
    fee,
    timestamp: Date.now(),
    reason,
    pnl,
    pnlPercent,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * 计算总资产（USDT + 持仓市值）
 */
export function calcTotalEquity(
  account: PaperAccount,
  prices: Record<string, number>
): number {
  let equity = account.usdt;
  for (const [symbol, pos] of Object.entries(account.positions)) {
    const price = prices[symbol];
    if (price) equity += pos.quantity * price;
  }
  return equity;
}

/**
 * 账户摘要（用于展示）
 */
export function getAccountSummary(
  account: PaperAccount,
  prices: Record<string, number>
): {
  usdt: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPercent: number;
  positions: Array<{
    symbol: string;
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
  }>;
  tradeCount: number;
  winRate: number;
} {
  const totalEquity = calcTotalEquity(account, prices);
  const totalPnl = totalEquity - account.initialUsdt;
  const totalPnlPercent = totalPnl / account.initialUsdt;

  const positions = Object.values(account.positions).map((pos) => {
    const currentPrice = prices[pos.symbol] ?? pos.entryPrice;
    const currentValue = pos.quantity * currentPrice;
    const costBasis = pos.quantity * pos.entryPrice;
    const unrealizedPnl = currentValue - costBasis;
    return {
      symbol: pos.symbol,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPercent: unrealizedPnl / costBasis,
    };
  });

  // 胜率：已完成交易中盈利笔数
  const closedTrades = account.trades.filter((t) => t.side === "sell" && t.pnl !== undefined);
  const winners = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length > 0 ? winners / closedTrades.length : 0;

  return {
    usdt: account.usdt,
    totalEquity,
    totalPnl,
    totalPnlPercent,
    positions,
    tradeCount: account.trades.length,
    winRate,
  };
}

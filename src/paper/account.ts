/**
 * Paper Trading 虚拟账户管理
 * 使用真实市场价格，本地模拟买卖
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** 根据场景 ID 返回账户状态文件路径 */
export function getAccountPath(scenarioId = "default"): string {
  return path.join(LOGS_DIR, `paper-${scenarioId}.json`);
}

export interface PaperPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;          // 止损价格
  takeProfit: number;        // 止盈价格
  trailingStop?: {
    active: boolean;
    highestPrice: number;    // 持仓期间最高价
    stopPrice: number;       // 当前追踪止损价
  };
}

export interface PaperTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;             // 成交价（含滑点）
  usdtAmount: number;
  fee: number;
  slippage: number;          // 滑点金额（USDT）
  timestamp: number;
  reason: string;
  pnl?: number;
  pnlPercent?: number;
}

export interface PaperAccount {
  initialUsdt: number;
  usdt: number;
  positions: Record<string, PaperPosition>;
  trades: PaperTrade[];
  createdAt: number;
  updatedAt: number;
  // 每日亏损追踪
  dailyLoss: {
    date: string;            // YYYY-MM-DD
    loss: number;            // 当日亏损 USDT（累计）
  };
}

function generateId(): string {
  return `P${Date.now().toString(36).toUpperCase()}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadAccount(initialUsdt = 1000, scenarioId = "default"): PaperAccount {
  const statePath = getAccountPath(scenarioId);
  try {
    const account = JSON.parse(fs.readFileSync(statePath, "utf-8")) as PaperAccount;
    if (!account.dailyLoss) {
      account.dailyLoss = { date: todayStr(), loss: 0 };
    }
    return account;
  } catch {
    const account: PaperAccount = {
      initialUsdt,
      usdt: initialUsdt,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: todayStr(), loss: 0 },
    };
    saveAccount(account, scenarioId);
    return account;
  }
}

export function saveAccount(account: PaperAccount, scenarioId = "default"): void {
  const statePath = getAccountPath(scenarioId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  account.updatedAt = Date.now();
  fs.writeFileSync(statePath, JSON.stringify(account, null, 2));
}

/** 重置每日亏损计数（每日首次调用时自动触发） */
export function resetDailyLossIfNeeded(account: PaperAccount): void {
  const today = todayStr();
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }
}

/**
 * 模拟买入
 */
export function paperBuy(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    positionRatio?: number;
    feeRate?: number;
    slippagePercent?: number;
    minOrderUsdt?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
  } = {}
): PaperTrade | null {
  const {
    positionRatio = 0.2,
    feeRate = 0.001,
    slippagePercent = 0.05,
    minOrderUsdt = 10,
    stopLossPercent = 5,
    takeProfitPercent = 15,
  } = opts;

  if (account.positions[symbol]) return null;

  const totalEquity = calcTotalEquity(account, { [symbol]: price });
  const usdtToSpend = totalEquity * positionRatio;

  if (usdtToSpend < minOrderUsdt || usdtToSpend > account.usdt) return null;

  // 滑点：买入时成交价略高于当前价
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;
  const slippageUsdt = (usdtToSpend * slippagePercent) / 100;

  const fee = usdtToSpend * feeRate;
  const actualUsdt = usdtToSpend - fee - slippageUsdt;
  const quantity = actualUsdt / execPrice;

  // 计算止损/止盈价格
  const stopLossPrice = execPrice * (1 - stopLossPercent / 100);
  const takeProfitPrice = execPrice * (1 + takeProfitPercent / 100);

  account.usdt -= usdtToSpend;
  account.positions[symbol] = {
    symbol,
    quantity,
    entryPrice: execPrice,
    entryTime: Date.now(),
    stopLoss: stopLossPrice,
    takeProfit: takeProfitPrice,
  };

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "buy",
    quantity,
    price: execPrice,
    usdtAmount: usdtToSpend,
    fee,
    slippage: slippageUsdt,
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
  reason: string,
  opts: {
    feeRate?: number;
    slippagePercent?: number;
  } = {}
): PaperTrade | null {
  const { feeRate = 0.001, slippagePercent = 0.05 } = opts;

  const position = account.positions[symbol];
  if (!position) return null;

  // 滑点：卖出时成交价略低于当前价
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price - slippageAmount;

  const grossUsdt = position.quantity * execPrice;
  const fee = grossUsdt * feeRate;
  const slippageUsdt = position.quantity * slippageAmount;
  const netUsdt = grossUsdt - fee;

  const costBasis = position.quantity * position.entryPrice;
  const pnl = netUsdt - costBasis;
  const pnlPercent = pnl / costBasis;

  // 更新每日亏损
  if (pnl < 0) {
    account.dailyLoss.loss += Math.abs(pnl);
  }

  account.usdt += netUsdt;
  delete account.positions[symbol];

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "sell",
    quantity: position.quantity,
    price: execPrice,
    usdtAmount: netUsdt,
    fee,
    slippage: slippageUsdt,
    timestamp: Date.now(),
    reason,
    pnl,
    pnlPercent,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * 更新追踪止损价格（每次价格更新时调用）
 * @returns 是否需要触发止损平仓
 */
export function updateTrailingStop(
  position: PaperPosition,
  currentPrice: number,
  opts: { activationPercent: number; callbackPercent: number }
): boolean {
  const { activationPercent, callbackPercent } = opts;

  if (!position.trailingStop) {
    position.trailingStop = {
      active: false,
      highestPrice: position.entryPrice,
      stopPrice: 0,
    };
  }

  const ts = position.trailingStop;

  // 更新最高价
  if (currentPrice > ts.highestPrice) {
    ts.highestPrice = currentPrice;
  }

  // 检查是否达到启动阈值
  const gainPercent = ((ts.highestPrice - position.entryPrice) / position.entryPrice) * 100;
  if (!ts.active && gainPercent >= activationPercent) {
    ts.active = true;
  }

  // 追踪止损激活后更新止损价
  if (ts.active) {
    ts.stopPrice = ts.highestPrice * (1 - callbackPercent / 100);
    // 当前价跌破止损价，触发平仓
    if (currentPrice <= ts.stopPrice) {
      return true;
    }
  }

  return false;
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
 * 账户摘要
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
    stopLoss: number;
    takeProfit: number;
  }>;
  tradeCount: number;
  winRate: number;
  dailyLoss: number;
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
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
    };
  });

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
    dailyLoss: account.dailyLoss.loss,
  };
}

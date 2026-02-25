/**
 * Paper Trading 虚拟账户管理
 * 使用真实市场价格，本地模拟买卖
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PositionSide } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** 根据场景 ID 返回账户状态文件路径 */
export function getAccountPath(scenarioId = "default"): string {
  return path.join(LOGS_DIR, `paper-${scenarioId}.json`);
}

export interface PaperPosition {
  symbol: string;
  /** 持仓方向：long=多头，short=空头（undefined 视为 long，兼容旧数据）*/
  side?: PositionSide;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;   // 止损价格（多头：低于入场；空头：高于入场）
  takeProfit: number; // 止盈价格（多头：高于入场；空头：低于入场）
  /** 空头仓位锁定的保证金（扣除手续费后的净值），用于平仓时还原资金 */
  marginUsdt?: number;
  trailingStop?: {
    active: boolean;
    highestPrice: number; // 多头：持仓期间最高价；空头：入场价（历史意义）
    lowestPrice?: number; // 空头：持仓期间最低价（追踪止损参考）
    stopPrice: number;    // 当前追踪止损触发价
  };
  // 分批止盈进度（与 risk.take_profit_stages 对应）
  tpStages?: {
    stagePct: number;    // 该档触发盈利比例
    closeRatio: number;  // 该档平仓比例
    triggered: boolean;  // 是否已触发
  }[];
  // ATR 入场时值（用于止损距离参考）
  entryAtr?: number;
  // 信号历史数据库 ID（用于平仓时回写结果）
  signalHistoryId?: string;
  /**
   * Positive Trailing Stop 是否已激活（G4：仿 Freqtrade trailing_stop_positive_offset）
   * 当持仓盈利超过 trailing_stop_positive_offset 后设为 true，
   * 此后使用 trailing_stop_positive 作为 trailing 幅度（更紧）
   */
  trailingStopActivated?: boolean;
  // 实盘订单 ID 追踪（F5 订单状态机）
  /** 入场订单 ID（用于启动时孤儿检测）*/
  entryOrderId?: number;
  /** 止损挂单 ID */
  stopLossOrderId?: number;
  /** 止盈挂单 ID */
  takeProfitOrderId?: number;
  // 分批建仓（DCA）状态
  dcaState?: {
    /** 目标分批数（含第一批） */
    totalTranches: number;
    /** 已完成批次数（含第一批）*/
    completedTranches: number;
    /** 最近一批的成交价，用于计算下跌触发点 */
    lastTranchePrice: number;
    /** 每批追加 % 跌幅（如 3.0 = 跌 3% 时追加） */
    dropPct: number;
    /** DCA 开始时间（超时后停止追加）*/
    startedAt: number;
    /** 最大持续时长（毫秒）*/
    maxMs: number;
  };
}

export interface PaperTrade {
  id: string;
  symbol: string;
  /** buy=开多, sell=平多, short=开空, cover=平空 */
  side: "buy" | "sell" | "short" | "cover";
  quantity: number;
  price: number; // 成交价（含滑点）
  usdtAmount: number;
  fee: number;
  slippage: number; // 滑点金额（USDT）
  timestamp: number;
  reason: string;
  pnl?: number;
  pnlPercent?: number;
}

/**
 * 挂单状态（F5 订单状态机）
 * 追踪系统发出的所有入场/出场订单生命周期，用于：
 * - 重启后识别并处理孤儿订单（进程崩溃时未清理）
 * - 部分成交检测与持仓修正
 */
export interface PendingOrder {
  orderId: number;
  symbol: string;
  /** buy=多头入场, sell=多头出场, short=空头入场, cover=空头平仓 */
  side: "buy" | "sell" | "short" | "cover";
  placedAt: number;      // Date.now()
  requestedQty: number;  // 请求成交量
  filledQty: number;     // 实际成交量（可能部分成交）
  /** pending=等待确认, filled=完全成交, partial=部分成交, cancelled=已取消 */
  status: "pending" | "filled" | "partial" | "cancelled";
  /** 超时阈值（ms），超过后若仍 pending 则视为孤儿 */
  timeoutMs: number;
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
    date: string; // YYYY-MM-DD
    loss: number; // 当日亏损 USDT（累计）
  };
  /** 挂单状态表（F5 订单状态机）——key: orderId */
  openOrders?: Record<number, PendingOrder>;
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!account.dailyLoss) {
      // 兼容旧版账户文件（缺少 dailyLoss 字段）
      account.dailyLoss = { date: todayStr(), loss: 0 };
    }
    return account;
  } catch (_e: unknown) {
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
    overridePositionUsdt?: number; // 若设置，忽略 positionRatio，直接使用此金额（ATR 仓位）
    feeRate?: number;
    slippagePercent?: number;
    minOrderUsdt?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
  } = {}
): PaperTrade | null {
  const {
    positionRatio = 0.2,
    overridePositionUsdt,
    feeRate = 0.001,
    slippagePercent = 0.05,
    minOrderUsdt = 10,
    stopLossPercent = 5,
    takeProfitPercent = 15,
  } = opts;

  if (account.positions[symbol]) return null;

  const totalEquity = calcTotalEquity(account, { [symbol]: price });
  const usdtToSpend = overridePositionUsdt ?? totalEquity * positionRatio;

  if (usdtToSpend < minOrderUsdt || usdtToSpend > account.usdt) return null;

  // 滑点：买入时成交价略高于当前价（正向滑点）
  // 仅通过提高 execPrice 模拟，不另行扣除 slippageUsdt（避免双重计算）
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;
  const slippageUsdt = usdtToSpend * (slippagePercent / 100); // 仅用于 trade 记录，不重复扣除

  const fee = usdtToSpend * feeRate;
  const actualUsdt = usdtToSpend - fee; // execPrice 已含滑点，无需额外扣除
  const quantity = actualUsdt / execPrice;

  // 计算止损/止盈价格
  const stopLossPrice = execPrice * (1 - stopLossPercent / 100);
  const takeProfitPrice = execPrice * (1 + takeProfitPercent / 100);

  account.usdt -= usdtToSpend;
  account.positions[symbol] = {
    symbol,
    side: "long",
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
 * DCA 追加买入：在已有多头持仓基础上加仓
 *
 * 与 paperBuy() 不同：
 * - 允许已有持仓存在（专为 DCA 追加设计）
 * - 新仓量加到持仓，entryPrice 重新计算加权均价
 * - 止损保持原始档位（不随追加下移，避免越套越深）
 */
export function paperDcaAdd(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    addUsdt: number;         // 本次追加金额（USDT）
    feeRate?: number;
    slippagePercent?: number;
  } = { addUsdt: 0 }
): PaperTrade | null {
  const pos = account.positions[symbol];
  if (!pos || pos.side === "short") return null;  // 仅对多头仓位追加

  const { addUsdt, feeRate = 0.001, slippagePercent = 0.05 } = opts;
  if (addUsdt < 1 || addUsdt > account.usdt) return null;

  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;
  const slippageUsdt = addUsdt * (slippagePercent / 100);
  const fee = addUsdt * feeRate;
  const netUsdt = addUsdt - fee;
  const addQty = netUsdt / execPrice;

  // 加权均价：原仓值 + 新仓值 / 总量
  const totalQty = pos.quantity + addQty;
  const weightedAvgPrice =
    (pos.quantity * pos.entryPrice + addQty * execPrice) / totalQty;

  account.usdt -= addUsdt;

  // 计算更新后的 DCA 状态（在 spread 前计算，一并写入新对象）
  const updatedDcaState = pos.dcaState
    ? {
        ...pos.dcaState,
        completedTranches: pos.dcaState.completedTranches + 1,
        lastTranchePrice: execPrice,
      }
    : undefined;

  // 更新持仓：量增加，均价重算，止损不动，DCA 状态同步
  account.positions[symbol] = {
    ...pos,
    quantity: totalQty,
    entryPrice: weightedAvgPrice,
    ...(updatedDcaState !== undefined && { dcaState: updatedDcaState }),
  };

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "buy",
    quantity: addQty,
    price: execPrice,
    usdtAmount: addUsdt,
    fee,
    slippage: slippageUsdt,
    timestamp: Date.now(),
    reason,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * 模拟卖出（支持全仓或部分平仓）
 * @param opts.overrideQty 若设置，只平掉这个数量（用于分批止盈）；不设置则全仓平
 */
export function paperSell(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    feeRate?: number;
    slippagePercent?: number;
    overrideQty?: number; // 部分平仓数量（分批止盈使用）
  } = {}
): PaperTrade | null {
  const { feeRate = 0.001, slippagePercent = 0.05, overrideQty } = opts;

  const position = account.positions[symbol];
  if (!position) return null;

  // 部分平仓数量（不超过实际持仓）
  const sellQty = overrideQty ? Math.min(overrideQty, position.quantity) : position.quantity;
  const isPartial = sellQty < position.quantity;

  // 滑点：卖出时成交价略低于当前价
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price - slippageAmount;

  const grossUsdt = sellQty * execPrice;
  const fee = grossUsdt * feeRate;
  const slippageUsdt = sellQty * slippageAmount;
  const netUsdt = grossUsdt - fee;

  const costBasis = sellQty * position.entryPrice;
  const pnl = netUsdt - costBasis;
  const pnlPercent = pnl / costBasis;

  // 更新每日亏损
  if (pnl < 0) {
    account.dailyLoss.loss += Math.abs(pnl);
  }

  account.usdt += netUsdt;

  if (isPartial) {
    // 部分平仓：更新剩余持仓量
    position.quantity -= sellQty;
  } else {
    // 全仓出场：删除持仓
    Reflect.deleteProperty(account.positions, symbol);
  }

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "sell",
    quantity: sellQty,
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
 * 模拟开空（做空）
 * 锁定保证金 = positionRatio × equity（或 overridePositionUsdt）
 * 虚拟"借币卖出"，平仓时买回归还，差价即盈亏
 * 仅在 futures / margin 市场有效
 */
export function paperOpenShort(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    positionRatio?: number;
    overridePositionUsdt?: number;
    feeRate?: number;
    slippagePercent?: number;
    minOrderUsdt?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
  } = {}
): PaperTrade | null {
  const {
    positionRatio = 0.2,
    overridePositionUsdt,
    feeRate = 0.001,
    slippagePercent = 0.05,
    minOrderUsdt = 10,
    stopLossPercent = 5,
    takeProfitPercent = 15,
  } = opts;

  if (account.positions[symbol]) return null; // 该币种已有持仓（不论多空）

  const equity = calcTotalEquity(account, { [symbol]: price });
  const marginToLock = overridePositionUsdt ?? equity * positionRatio;

  if (marginToLock < minOrderUsdt || marginToLock > account.usdt) return null;

  // 空头开仓：卖出时滑点导致成交价略低（对做空方不利）
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price - slippageAmount;

  const fee = marginToLock * feeRate;
  const actualMargin = marginToLock - fee; // 净保证金（扣除手续费）
  const quantity = actualMargin / execPrice; // 借来卖出的币量

  // 空头止损/止盈方向与多头相反
  const stopLossPrice = execPrice * (1 + stopLossPercent / 100);   // 价格上涨 = 亏损
  const takeProfitPrice = execPrice * (1 - takeProfitPercent / 100); // 价格下跌 = 盈利

  account.usdt -= marginToLock; // 锁定保证金
  account.positions[symbol] = {
    symbol,
    side: "short",
    quantity,
    entryPrice: execPrice,
    entryTime: Date.now(),
    stopLoss: stopLossPrice,
    takeProfit: takeProfitPrice,
    marginUsdt: actualMargin,
  };

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "short",
    quantity,
    price: execPrice,
    usdtAmount: marginToLock,
    fee,
    slippage: quantity * slippageAmount,
    timestamp: Date.now(),
    reason,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * 模拟平空（买入归还借币）
 * pnl = (entryPrice - coverPrice) × quantity - coverFee
 * 将保证金 + pnl 归还到 account.usdt
 */
export function paperCoverShort(
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
  if (position?.side !== "short") return null;

  // 平空时买入：滑点导致成交价略高（对买入方不利）
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;

  const { quantity, entryPrice } = position;
  const marginUsdt = position.marginUsdt ?? quantity * entryPrice;

  const grossUsdt = quantity * execPrice; // 买回所需花费
  const fee = grossUsdt * feeRate;
  const pnl = (entryPrice - execPrice) * quantity - fee; // 正数=盈利，负数=亏损
  const pnlPercent = pnl / marginUsdt;

  // 保护：最多亏光保证金（无负余额）
  const returnAmount = Math.max(0, marginUsdt + pnl);

  if (pnl < 0) {
    account.dailyLoss.loss += Math.abs(pnl);
  }

  account.usdt += returnAmount;
  Reflect.deleteProperty(account.positions, symbol);

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "cover",
    quantity,
    price: execPrice,
    usdtAmount: returnAmount,
    fee,
    slippage: quantity * slippageAmount,
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
 * - 多头：追踪最高价，从高点回撤 callbackPercent 触发
 * - 空头：追踪最低价，从低点反弹 callbackPercent 触发
 * @returns 是否需要触发止损平仓
 */
export function updateTrailingStop(
  position: PaperPosition,
  currentPrice: number,
  opts: { activationPercent: number; callbackPercent: number }
): boolean {
  const { activationPercent, callbackPercent } = opts;
  const isShort = position.side === "short";

  const ts = (position.trailingStop ??= isShort
    ? { active: false, highestPrice: position.entryPrice, lowestPrice: position.entryPrice, stopPrice: 0 }
    : { active: false, highestPrice: position.entryPrice, stopPrice: 0 });

  if (isShort) {
    // ── 空头追踪止损：跟踪最低价，从低点反弹时平仓 ──
    ts.lowestPrice ??= position.entryPrice;
    if (currentPrice < ts.lowestPrice) ts.lowestPrice = currentPrice;

    // 盈利百分比 = 价格从入场价下跌的幅度
    const lowestPrice = ts.lowestPrice; // narrow to number for TS
    const gainPercent = ((position.entryPrice - lowestPrice) / position.entryPrice) * 100;
    if (!ts.active && gainPercent >= activationPercent) ts.active = true;

    if (ts.active) {
      ts.stopPrice = lowestPrice * (1 + callbackPercent / 100);
      // 价格从低点反弹超过回调幅度，触发平仓
      if (currentPrice >= ts.stopPrice) return true;
    }
  } else {
    // ── 多头追踪止损：跟踪最高价，从高点下跌时平仓 ──
    if (currentPrice > ts.highestPrice) ts.highestPrice = currentPrice;

    const gainPercent = ((ts.highestPrice - position.entryPrice) / position.entryPrice) * 100;
    if (!ts.active && gainPercent >= activationPercent) ts.active = true;

    if (ts.active) {
      ts.stopPrice = ts.highestPrice * (1 - callbackPercent / 100);
      if (currentPrice <= ts.stopPrice) return true;
    }
  }

  return false;
}

/**
 * 计算总资产（USDT + 持仓市值）
 * - 多头：equity += quantity × currentPrice
 * - 空头：equity += marginUsdt + (entryPrice - currentPrice) × quantity
 */
export function calcTotalEquity(account: PaperAccount, prices: Record<string, number>): number {
  let equity = account.usdt;
  for (const [symbol, pos] of Object.entries(account.positions)) {
    const price = prices[symbol];
    if (!price) continue;
    if (pos.side === "short") {
      // 空头：锁定保证金 + 浮动盈亏
      const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
      const unrealizedPnl = (pos.entryPrice - price) * pos.quantity;
      equity += margin + unrealizedPnl;
    } else {
      // 多头：持仓市值
      equity += pos.quantity * price;
    }
  }
  return equity;
}

export interface PositionSummary {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  stopLoss: number;
  takeProfit: number;
}

/**
 * 账户摘要（支持多头 + 空头持仓）
 */
export function getAccountSummary(
  account: PaperAccount,
  prices: Record<string, number>
): {
  usdt: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPercent: number;
  positions: PositionSummary[];
  tradeCount: number;
  winRate: number;
  dailyLoss: number;
} {
  const totalEquity = calcTotalEquity(account, prices);
  const totalPnl = totalEquity - account.initialUsdt;
  const totalPnlPercent = totalPnl / account.initialUsdt;

  const positions: PositionSummary[] = Object.values(account.positions).map((pos) => {
    const currentPrice = prices[pos.symbol] ?? pos.entryPrice;
    const side: PositionSide = pos.side ?? "long";

    let unrealizedPnl: number;
    let costBasis: number;

    if (side === "short") {
      const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
      unrealizedPnl = (pos.entryPrice - currentPrice) * pos.quantity;
      costBasis = margin;
    } else {
      const currentValue = pos.quantity * currentPrice;
      costBasis = pos.quantity * pos.entryPrice;
      unrealizedPnl = currentValue - costBasis;
    }

    return {
      symbol: pos.symbol,
      side,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPercent: costBasis > 0 ? unrealizedPnl / costBasis : 0,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
    };
  });

  // 已平仓交易：sell（平多）+ cover（平空）
  const closedTrades = account.trades.filter(
    (t) => (t.side === "sell" || t.side === "cover") && t.pnl !== undefined
  );
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

// ─────────────────────────────────────────────────────
// F5: 订单状态机辅助函数
// ─────────────────────────────────────────────────────

/**
 * 注册一个新挂单到账户状态表
 */
export function registerOrder(
  account: PaperAccount,
  order: Omit<PendingOrder, "status">
): void {
  account.openOrders ??= {};
  account.openOrders[order.orderId] = { ...order, status: "pending" };
}

/**
 * 确认订单成交（完全或部分），并从 openOrders 中移除或更新
 */
export function confirmOrder(
  account: PaperAccount,
  orderId: number,
  filledQty: number,
  requestedQty: number
): "filled" | "partial" | "not_found" {
  if (!account.openOrders?.[orderId]) return "not_found";
  const status: PendingOrder["status"] = filledQty >= requestedQty * 0.999 ? "filled" : "partial";
  account.openOrders[orderId] = { ...account.openOrders[orderId], filledQty, status };
  // 已完成的订单保留一段时间用于 audit，最终会被 scanOpenOrders 清理
  return status;
}

/**
 * 将订单标记为已取消，并从 openOrders 移除
 */
export function cancelOrder(account: PaperAccount, orderId: number): void {
  if (!account.openOrders) return;
  Reflect.deleteProperty(account.openOrders, orderId);
}

/**
 * 返回所有超时仍未确认的挂单（孤儿订单）
 */
export function getTimedOutOrders(account: PaperAccount): PendingOrder[] {
  if (!account.openOrders) return [];
  const now = Date.now();
  return Object.values(account.openOrders).filter(
    (o) => o.status === "pending" && now - o.placedAt > o.timeoutMs
  );
}

/**
 * 清理已完成/已取消订单（保留 pending 和 partial）
 */
export function cleanupOrders(account: PaperAccount): void {
  if (!account.openOrders) return;
  for (const [id, order] of Object.entries(account.openOrders)) {
    if (order.status === "filled" || order.status === "cancelled") {
      Reflect.deleteProperty(account.openOrders, id);
    }
  }
}

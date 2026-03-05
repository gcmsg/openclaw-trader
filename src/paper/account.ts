/**
 * Paper Trading virtual account management
 * Uses real market prices, simulates buy/sell locally
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PositionSide } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** Returns account state file path based on scenario ID */
export function getAccountPath(scenarioId = "default"): string {
  return path.join(LOGS_DIR, `paper-${scenarioId}.json`);
}

export interface PaperPosition {
  symbol: string;
  /** Position direction: long or short (undefined treated as long for backward compatibility) */
  side?: PositionSide;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;   // Stop loss price (long: below entry; short: above entry)
  takeProfit: number; // Take profit price (long: above entry; short: below entry)
  /** Margin locked for short position (net value after fees), used to restore funds on close */
  marginUsdt?: number;
  trailingStop?: {
    active: boolean;
    highestPrice: number; // Long: highest price during hold; Short: entry price (historical)
    lowestPrice?: number; // Short: lowest price during hold (trailing stop reference)
    stopPrice: number;    // Current trailing stop trigger price
  };
  // Staged take profit progress (corresponds to risk.take_profit_stages)
  tpStages?: {
    stagePct: number;    // Profit percentage trigger for this stage
    closeRatio: number;  // Close ratio for this stage
    triggered: boolean;  // Whether this stage has been triggered
  }[];
  // ATR value at entry (used as stop loss distance reference)
  entryAtr?: number;
  // Signal history database ID (used to write back results on close)
  signalHistoryId?: string;
  /**
   * Trade ID in SQLite database (G5)
   * Returned by db.insertTrade() on open, used by db.closeTrade() on close
   */
  dbId?: number;
  /**
   * Whether Positive Trailing Stop is activated (G4: Freqtrade-style trailing_stop_positive_offset)
   * Set to true when position profit exceeds trailing_stop_positive_offset,
   * then uses trailing_stop_positive as the trailing distance (tighter)
   */
  trailingStopActivated?: boolean;
  // Live order ID tracking (F5 order state machine)
  /** Entry order ID (used for orphan detection on startup) */
  entryOrderId?: number;
  /** Stop loss order ID */
  stopLossOrderId?: number;
  /** Take profit order ID */
  takeProfitOrderId?: number;
  /** Native exchange stop loss order ID (optional, only used in live mode) */
  exchangeSlOrderId?: number;
  /** Native exchange stop loss price (kept in sync with local stop loss) */
  exchangeSlPrice?: number;
  /** Exit order timeout count (triggers forceExit after N consecutive timeouts) */
  exitTimeoutCount?: number;
  // DCA (Dollar-Cost Averaging) state
  dcaState?: {
    /** Target number of tranches (including the first) */
    totalTranches: number;
    /** Completed tranches count (including the first) */
    completedTranches: number;
    /** Last tranche fill price, used to calculate drop trigger point */
    lastTranchePrice: number;
    /** Drop percentage per tranche (e.g., 3.0 = add when price drops 3%) */
    dropPct: number;
    /** DCA start time (stop adding after timeout) */
    startedAt: number;
    /** Maximum duration (milliseconds) */
    maxMs: number;
  };
}

export interface PaperTrade {
  id: string;
  symbol: string;
  /** buy=open long, sell=close long, short=open short, cover=close short */
  side: "buy" | "sell" | "short" | "cover";
  quantity: number;
  price: number; // Fill price (includes slippage)
  usdtAmount: number;
  fee: number;
  slippage: number; // Slippage amount (USDT)
  timestamp: number;
  reason: string;
  pnl?: number;
  pnlPercent?: number;
}

/**
 * Pending order state (F5 order state machine)
 * Tracks the lifecycle of all entry/exit orders issued by the system, used for:
 * - Detecting and handling orphan orders after restart (not cleaned up during process crash)
 * - Partial fill detection and position correction
 */
export interface PendingOrder {
  orderId: number;
  symbol: string;
  /** buy=long entry, sell=long exit, short=short entry, cover=short exit */
  side: "buy" | "sell" | "short" | "cover";
  placedAt: number;      // Date.now()
  requestedQty: number;  // Requested fill quantity
  filledQty: number;     // Actual filled quantity (may be partial)
  /** pending=awaiting confirmation, filled=fully filled, partial=partially filled, cancelled=cancelled */
  status: "pending" | "filled" | "partial" | "cancelled";
  /** Timeout threshold (ms), considered orphan if still pending after this */
  timeoutMs: number;
}

export interface PaperAccount {
  initialUsdt: number;
  usdt: number;
  positions: Record<string, PaperPosition>;
  trades: PaperTrade[];
  createdAt: number;
  updatedAt: number;
  // Daily loss tracking
  dailyLoss: {
    date: string; // YYYY-MM-DD
    loss: number; // Daily cumulative loss in USDT
  };
  /** Pending order state table (F5 order state machine) -- key: orderId */
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
    // Guard: basic field validation, prevent corrupted file from causing NaN downstream
    if (typeof account.usdt !== "number" || typeof account.positions !== "object" || account.positions === null) {
      throw new Error(`Invalid account state: ${statePath}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!account.dailyLoss) {
      // Backward compatibility for old account files (missing dailyLoss field)
      account.dailyLoss = { date: todayStr(), loss: 0 };
    }
     
    if (!account.initialUsdt || account.initialUsdt <= 0) {
      // Backward compatibility for old account files (missing initialUsdt field), prevent NaN in PnL calculation
      account.initialUsdt = initialUsdt;
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
  // Atomic write: write to .tmp first then rename, prevent corruption from concurrent writes
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(account, null, 2));
  fs.renameSync(tmpPath, statePath);
}

/** Reset daily loss counter (auto-triggered on first call each day) */
export function resetDailyLossIfNeeded(account: PaperAccount): void {
  const today = todayStr();
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }
}

/**
 * Simulated buy
 */
export function paperBuy(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    positionRatio?: number;
    overridePositionUsdt?: number; // If set, ignore positionRatio and use this amount directly (ATR position sizing)
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

  // Slippage: buy execution price is slightly higher than current price (adverse slippage)
  // Only simulated by raising execPrice, slippageUsdt is not deducted separately (avoid double counting)
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;
  const slippageUsdt = usdtToSpend * (slippagePercent / 100); // For trade record only, not deducted separately

  const fee = usdtToSpend * feeRate;
  const actualUsdt = usdtToSpend - fee; // execPrice already includes slippage, no extra deduction needed
  const quantity = actualUsdt / execPrice;

  // Calculate stop loss / take profit prices
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
 * DCA add buy: add to an existing long position
 *
 * Differs from paperBuy():
 * - Allows an existing position (designed for DCA additions)
 * - New quantity added to position, entryPrice recalculated as weighted average
 * - Stop loss stays at original level (does not move down with additions, avoids deepening losses)
 */
export function paperDcaAdd(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    addUsdt: number;         // Amount to add this tranche (USDT)
    feeRate?: number;
    slippagePercent?: number;
  } = { addUsdt: 0 }
): PaperTrade | null {
  const pos = account.positions[symbol];
  if (!pos || pos.side === "short") return null;  // Only add to long positions

  const { addUsdt, feeRate = 0.001, slippagePercent = 0.05 } = opts;
  if (addUsdt < 1 || addUsdt > account.usdt) return null;

  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;
  if (!isFinite(execPrice) || execPrice <= 0) return null; // Guard: invalid price
  const slippageUsdt = addUsdt * (slippagePercent / 100);
  const fee = addUsdt * feeRate;
  const netUsdt = addUsdt - fee;
  const addQty = netUsdt / execPrice;

  // Weighted average price: (old position value + new position value) / total quantity
  const totalQty = pos.quantity + addQty;
  if (totalQty <= 0) return null; // Guard: zero total quantity
  const weightedAvgPrice =
    (pos.quantity * pos.entryPrice + addQty * execPrice) / totalQty;

  account.usdt -= addUsdt;

  // Calculate updated DCA state (computed before spread, written together into new object)
  const updatedDcaState = pos.dcaState
    ? {
        ...pos.dcaState,
        completedTranches: pos.dcaState.completedTranches + 1,
        lastTranchePrice: execPrice,
      }
    : undefined;

  // Update position: quantity increased, avg price recalculated, stop loss unchanged, DCA state synced
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
 * Simulated sell (supports full or partial close)
 * @param opts.overrideQty If set, only close this quantity (used for staged take profit); otherwise close entire position
 */
export function paperSell(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    feeRate?: number;
    slippagePercent?: number;
    overrideQty?: number; // Partial close quantity (used for staged take profit)
  } = {}
): PaperTrade | null {
  const { feeRate = 0.001, slippagePercent = 0.05, overrideQty } = opts;

  const position = account.positions[symbol];
  if (!position) return null;

  // Partial close quantity (capped at actual position size)
  const sellQty = overrideQty && overrideQty > 0
    ? Math.min(overrideQty, position.quantity)
    : position.quantity;
  if (sellQty <= 0) return null; // Prevent division by zero when overrideQty=0
  const isPartial = sellQty < position.quantity;

  // Slippage: sell execution price is slightly lower than current price
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price - slippageAmount;

  const grossUsdt = sellQty * execPrice;
  const fee = grossUsdt * feeRate;
  const slippageUsdt = sellQty * slippageAmount;
  const netUsdt = grossUsdt - fee;

  const costBasis = sellQty * position.entryPrice;
  const pnl = netUsdt - costBasis;
  const pnlPercent = costBasis > 0 ? pnl / costBasis : 0;

  // Update daily loss
  if (pnl < 0) {
    account.dailyLoss.loss += Math.abs(pnl);
  }

  account.usdt += netUsdt;

  if (isPartial) {
    // Partial close: update remaining position quantity
    position.quantity -= sellQty;
  } else {
    // Full exit: delete position
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
 * Simulated open short
 * Lock margin = positionRatio x equity (or overridePositionUsdt)
 * Virtual "borrow and sell", buy back on close, difference is PnL
 * Only valid on futures / margin markets
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

  if (account.positions[symbol]) return null; // Already has a position for this symbol (regardless of direction)

  const equity = calcTotalEquity(account, { [symbol]: price });
  const marginToLock = overridePositionUsdt ?? equity * positionRatio;

  if (marginToLock < minOrderUsdt || marginToLock > account.usdt) return null;

  // Short entry: sell slippage causes execution price to be slightly lower (adverse for short side)
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price - slippageAmount;

  const fee = marginToLock * feeRate;
  const actualMargin = marginToLock - fee; // Net margin (after fees)
  const quantity = actualMargin / execPrice; // Quantity of borrowed coins to sell

  // Short stop loss / take profit directions are reversed from long
  const stopLossPrice = execPrice * (1 + stopLossPercent / 100);   // Price rise = loss
  const takeProfitPrice = execPrice * (1 - takeProfitPercent / 100); // Price drop = profit

  account.usdt -= marginToLock; // Lock margin
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
 * Simulated cover short (buy back borrowed coins)
 * pnl = (entryPrice - coverPrice) x quantity - coverFee
 * Returns margin + pnl to account.usdt
 */
export function paperCoverShort(
  account: PaperAccount,
  symbol: string,
  price: number,
  reason: string,
  opts: {
    feeRate?: number;
    slippagePercent?: number;
    overrideQty?: number; // A-007: partial cover (used for staged take profit)
  } = {}
): PaperTrade | null {
  const { feeRate = 0.001, slippagePercent = 0.05, overrideQty } = opts;

  const position = account.positions[symbol];
  if (position?.side !== "short") return null;

  // Cover short buy: slippage causes execution price to be slightly higher (adverse for buyer)
  const slippageAmount = (price * slippagePercent) / 100;
  const execPrice = price + slippageAmount;

  const { entryPrice } = position;
  // Partial cover support
  const coverQty = overrideQty && overrideQty > 0
    ? Math.min(overrideQty, position.quantity)
    : position.quantity;
  const isPartial = coverQty < position.quantity;
  const marginUsdt = position.marginUsdt ?? position.quantity * entryPrice;
  const coverMargin = isPartial ? marginUsdt * (coverQty / position.quantity) : marginUsdt;

  const grossUsdt = coverQty * execPrice; // Cost to buy back
  const fee = grossUsdt * feeRate;
  const pnl = (entryPrice - execPrice) * coverQty - fee; // Positive=profit, negative=loss
  const pnlPercent = coverMargin > 0 ? pnl / coverMargin : 0;

  // Protection: lose at most the margin (no negative balance)
  const returnAmount = Math.max(0, coverMargin + pnl);

  if (pnl < 0) {
    account.dailyLoss.loss += Math.abs(pnl);
  }

  account.usdt += returnAmount;
  if (isPartial) {
    position.quantity -= coverQty;
    if (position.marginUsdt !== undefined) {
      position.marginUsdt -= coverMargin;
    }
  } else {
    Reflect.deleteProperty(account.positions, symbol);
  }

  const trade: PaperTrade = {
    id: generateId(),
    symbol,
    side: "cover",
    quantity: coverQty,
    price: execPrice,
    usdtAmount: returnAmount,
    fee,
    slippage: coverQty * slippageAmount,
    timestamp: Date.now(),
    reason,
    pnl,
    pnlPercent,
  };

  account.trades.push(trade);
  return trade;
}

/**
 * Update trailing stop price (called on each price update)
 * - Long: tracks highest price, triggers on callbackPercent retracement from peak
 * - Short: tracks lowest price, triggers on callbackPercent bounce from trough
 * @returns Whether stop loss exit should be triggered
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
    // ── Short trailing stop: track lowest price, close on bounce from low ──
    ts.lowestPrice ??= position.entryPrice;
    if (currentPrice < ts.lowestPrice) ts.lowestPrice = currentPrice;

    // Profit percentage = magnitude of price drop from entry
    const lowestPrice = ts.lowestPrice; // narrow to number for TS
    const gainPercent = ((position.entryPrice - lowestPrice) / position.entryPrice) * 100;
    if (!ts.active && gainPercent >= activationPercent) ts.active = true;

    if (ts.active) {
      ts.stopPrice = lowestPrice * (1 + callbackPercent / 100);
      // Price bounced from low beyond callback threshold, trigger close
      if (currentPrice >= ts.stopPrice) return true;
    }
  } else {
    // ── Long trailing stop: track highest price, close on drop from high ──
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
 * Calculate total equity (USDT + position market value)
 * - Long: equity += quantity x currentPrice
 * - Short: equity += marginUsdt + (entryPrice - currentPrice) x quantity
 */
export function calcTotalEquity(account: PaperAccount, prices: Record<string, number>): number {
  let equity = account.usdt;
  for (const [symbol, pos] of Object.entries(account.positions)) {
    const price = prices[symbol];
    if (!price) continue;
    if (pos.side === "short") {
      // Short: locked margin + unrealized PnL
      const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
      const unrealizedPnl = (pos.entryPrice - price) * pos.quantity;
      equity += margin + unrealizedPnl;
    } else {
      // Long: position market value
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
 * Account summary (supports both long and short positions)
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

  // Closed trades: sell (close long) + cover (close short)
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
// F5: Order state machine helper functions
// ─────────────────────────────────────────────────────

/**
 * Register a new pending order to the account state table
 */
export function registerOrder(
  account: PaperAccount,
  order: Omit<PendingOrder, "status">
): void {
  account.openOrders ??= {};
  account.openOrders[order.orderId] = { ...order, status: "pending" };
}

/**
 * Confirm order fill (full or partial), and remove or update in openOrders
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
  // Completed orders are retained for audit, eventually cleaned up by scanOpenOrders
  return status;
}

/**
 * Mark order as cancelled and remove from openOrders
 */
export function cancelOrder(account: PaperAccount, orderId: number): void {
  if (!account.openOrders) return;
  Reflect.deleteProperty(account.openOrders, orderId);
}

/**
 * Return all timed-out unconfirmed pending orders (orphan orders)
 */
export function getTimedOutOrders(account: PaperAccount): PendingOrder[] {
  if (!account.openOrders) return [];
  const now = Date.now();
  return Object.values(account.openOrders).filter(
    (o) => o.status === "pending" && now - o.placedAt > o.timeoutMs
  );
}

/**
 * Clean up completed/cancelled orders (keep pending and partial)
 */
export function cleanupOrders(account: PaperAccount): void {
  if (!account.openOrders) return;
  for (const [id, order] of Object.entries(account.openOrders)) {
    if (order.status === "filled" || order.status === "cancelled") {
      Reflect.deleteProperty(account.openOrders, id);
    }
  }
}

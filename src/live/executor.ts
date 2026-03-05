/**
 * Live/Testnet Trade Executor
 *
 * Responsibilities:
 * - Receives signals (Signal), executes real orders via BinanceClient
 * - Syncs position state to local JSON (paper-compatible format for reusing stats tools)
 * - Stop loss/take profit/trailing stop checks (via limit orders or polling)
 *
 * Usage:
 *   mode: "testnet"  -> connects to testapi.binance.vision (virtual funds, real prices)
 *   mode: "live"     -> connects to api.binance.com (⚠️ real funds)
 */

import type { Signal, RuntimeConfig } from "../types.js";
import {
  BinanceClient,
  type OrderResponse,
} from "../exchange/binance-client.js";
import {
  loadAccount,
  saveAccount,
  resetDailyLossIfNeeded,
  calcTotalEquity,
  registerOrder,
  confirmOrder,
  getTimedOutOrders,
  cancelOrder,
  cleanupOrders,
  type PaperTrade,
  type PaperAccount,
  type PaperPosition,
} from "../paper/account.js";
import { calcAtrPositionSize } from "../strategy/indicators.js";
import { checkMinimalRoi } from "../strategy/roi-table.js";
import { resolveNewStopLoss } from "../strategy/break-even.js";
import { shouldConfirmExit, isExitRejectionCoolingDown } from "../strategy/confirm-exit.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import type { ExitReason } from "../paper/engine.js";
import type { ExchangePosition } from "./reconcile.js";
import { sendTelegramMessage } from "../notify/openclaw.js";

// Trigger forced market exit after N consecutive exit order timeouts
const EXIT_TIMEOUT_MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────
// Result types (compatible with PaperEngineResult)
// ─────────────────────────────────────────────────────

export interface LiveEngineResult {
  trade: PaperTrade | null;
  skipped?: string;
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
  orderId?: number; // Binance order ID
}

// ─────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────

function generateId(): string {
  return `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Convert Binance OrderResponse to PaperTrade format (for reusing stats tools) */
function orderToPaperTrade(
  order: OrderResponse,
  side: PaperTrade["side"],
  reason: string,
  pnl?: number,
  pnlPercent?: number
): PaperTrade {
  const avgPrice =
    order.fills && order.fills.length > 0
      ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
        parseFloat(order.executedQty)
      : parseFloat(order.price);

  const qty = parseFloat(order.executedQty);
  const commission = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;
  const usdtAmount = qty * avgPrice;

  const base: PaperTrade = {
    id: generateId(),
    symbol: order.symbol,
    side,
    quantity: qty,
    price: avgPrice,
    usdtAmount: side === "sell" ? usdtAmount - commission : usdtAmount + commission,
    fee: commission,
    slippage: 0, // No simulated slippage in live trading
    timestamp: order.transactTime,
    reason,
  };
  if (pnl !== undefined && pnlPercent !== undefined) {
    base.pnl = pnl;
    base.pnlPercent = pnlPercent;
  }
  return base;
}

// ─────────────────────────────────────────────────────
// LiveExecutor class
// ─────────────────────────────────────────────────────

export class LiveExecutor {
  private readonly client: BinanceClient;
  private readonly cfg: RuntimeConfig;
  private readonly scenarioId: string;
  private readonly isTestnet: boolean;
  /** Optional: strategy plugin (for customStoploss / confirmExit hooks) */
  strategy?: Strategy;
  /** P8.2: Exit rejection cooldown log (symbol -> last rejection timestamp) */
  private readonly _exitRejectionLog = new Map<string, number>();

  constructor(cfg: RuntimeConfig) {
    this.cfg = cfg;
    this.scenarioId = cfg.paper.scenarioId;
    this.isTestnet = cfg.exchange.testnet ?? false;

    const credsPath = cfg.exchange.credentials_path ?? ".secrets/binance.json";
    const market = cfg.exchange.market === "futures" ? "futures" : "spot";

    this.client = new BinanceClient(credsPath, this.isTestnet, market);
  }

  /** Test connection */
  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  /** Get account USDT balance (sync with local account) */
  async syncBalance(): Promise<number> {
    return this.client.getUsdtBalance();
  }

  /**
   * Read actual positions from exchange (for reconciliation)
   * Futures: reads positionRisk, filters positionAmt != 0
   * Spot: currently unsupported, returns empty array
   */
  async getExchangePositions(): Promise<ExchangePosition[]> {
    try {
      const raw = await this.client.getFuturesPositions();
      return raw
        .filter((p) => parseFloat(p.positionAmt) !== 0)
        .map((p) => ({
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? ("long" as const) : ("short" as const),
          qty: Math.abs(parseFloat(p.positionAmt)),
          avgPrice: parseFloat(p.entryPrice),
        }));
    } catch {
      return []; // Spot or unsupported markets return empty array
    }
  }

  /**
   * Handle buy signal
   * Flow: check position limit -> calculate position size -> place market order -> update local account
   */
  async handleBuy(signal: Signal): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    resetDailyLossIfNeeded(account);

    const openCount = Object.keys(account.positions).length;
    if (this.cfg.risk.max_positions > 0 && openCount >= this.cfg.risk.max_positions) {
      const skipped = `Max positions ${this.cfg.risk.max_positions} reached, skipping ${signal.symbol}`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    if (account.positions[signal.symbol]) {
      const skipped = `${signal.symbol} already has position, skipping`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // Get real balance from Binance (sync)
    const realBalance = await this.client.getUsdtBalance();
    const equity = Math.min(realBalance, calcTotalEquity(account, { [signal.symbol]: signal.price }));

    // Check daily loss limit
    if ((account.dailyLoss.loss / equity) * 100 >= this.cfg.risk.daily_loss_limit_percent) {
      const skipped = `Daily loss reached ${this.cfg.risk.daily_loss_limit_percent}%, pausing new entries for today`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // Calculate position size
    let usdtToSpend: number;
    const atrCfg = this.cfg.risk.atr_position;
    if (atrCfg?.enabled && signal.indicators.atr) {
      usdtToSpend = calcAtrPositionSize(
        equity,
        signal.price,
        signal.indicators.atr,
        atrCfg.risk_per_trade_percent / 100,
        atrCfg.atr_multiplier,
        atrCfg.max_position_ratio
      );
    } else {
      usdtToSpend = equity * this.cfg.risk.position_ratio;
    }

    // Check minimum order amount
    const minOrder = this.cfg.execution.min_order_usdt;
    if (usdtToSpend < minOrder) {
      const skipped = `Position $${usdtToSpend.toFixed(2)} below minimum order amount $${minOrder}`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🛡️ F4: Pre-entry price deviation check (prevent buying during flash crash)
    const maxSlippage = this.cfg.execution.max_entry_slippage ?? 0;
    if (maxSlippage > 0) {
      const currentPrice = await this.client.getPrice(signal.symbol);
      const drift = Math.abs(currentPrice - signal.price) / signal.price;
      if (drift > maxSlippage) {
        const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
        const skipped = `${label} Entry cancelled ${signal.symbol}: price deviation ${(drift * 100).toFixed(2)}% > ${(maxSlippage * 100).toFixed(1)}% (signal $${signal.price.toFixed(4)}, current $${currentPrice.toFixed(4)})`;
        console.log(skipped);
        return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
      }
    }

    // 🔥 Execute real order
    let order: OrderResponse;
    try {
      order = await this.client.marketBuy(signal.symbol, usdtToSpend);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] Buy ${signal.symbol} failed: ${msg}`, { cause: err });
    }

    // F5: Register entry order (basis for orphan detection)
    const expectedQty = usdtToSpend / signal.price;
    registerOrder(account, {
      orderId: order.orderId,
      symbol: signal.symbol,
      side: "buy",
      placedAt: Date.now(),
      requestedQty: expectedQty,
      filledQty: 0,
      timeoutMs: (this.cfg.execution.order_timeout_seconds ?? 30) * 1000,
    });

    // Calculate actual fill average price
    const avgPrice =
      order.fills && order.fills.length > 0
        ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
          parseFloat(order.executedQty)
        : signal.price;

    const execQty = parseFloat(order.executedQty);
    const totalFee = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;

    // F2: Partial fill detection
    const fillRatio = execQty / (expectedQty || 1);
    if (fillRatio < 0.95) {
      const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
      console.warn(`${label} ⚠️ Partial fill ${signal.symbol}: requested ${expectedQty.toFixed(6)}, filled ${execQty.toFixed(6)} (${(fillRatio * 100).toFixed(1)}%)`);
    }
    confirmOrder(account, order.orderId, execQty, expectedQty);

    // Update local account (mirror real state)
    // ATR dynamic stop loss: when atr_position enabled and signal has ATR, use ATR x multiplier as stop distance
    const signalAtr = signal.indicators.atr;
    const stopLossPrice = (atrCfg?.enabled && signalAtr)
      ? avgPrice - signalAtr * atrCfg.atr_multiplier
      : avgPrice * (1 - this.cfg.risk.stop_loss_percent / 100);
    const takeProfitPrice = avgPrice * (1 + this.cfg.risk.take_profit_percent / 100);

    // 🛡️ Place native stop loss order on exchange (P7.1)
    const exchangeSlOrderId = await this.placeExchangeStopLoss(
      signal.symbol, "long", execQty, stopLossPrice
    );
    let takeProfitOrderId: number | undefined;
    try {
      const tpOrder = await this.client.placeTakeProfitOrder(
        signal.symbol, "SELL", execQty, takeProfitPrice
      );
      // orderId=-1 means degraded to local polling take profit (LOCAL_ONLY)
      if (tpOrder.orderId !== -1) takeProfitOrderId = tpOrder.orderId;
    } catch (err) {
      console.warn(`[LiveExecutor] Take profit order placement failed ${signal.symbol}:`, err instanceof Error ? err.message : err);
    }

    account.usdt = realBalance - usdtToSpend;
    account.positions[signal.symbol] = {
      symbol: signal.symbol,
      side: "long",
      quantity: execQty,
      entryPrice: avgPrice,
      entryTime: order.transactTime,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
      entryOrderId: order.orderId,
      ...(exchangeSlOrderId !== null && {
        stopLossOrderId: exchangeSlOrderId,
        exchangeSlOrderId,
        exchangeSlPrice: stopLossPrice,
      }),
      ...(takeProfitOrderId !== undefined && { takeProfitOrderId }),
    };

    const trade = orderToPaperTrade(order, "buy", signal.reason.join(", "));
    account.trades.push(trade);
    cleanupOrders(account); // Clean up completed orders, avoid state table bloat
    saveAccount(account, this.scenarioId);

    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const slLabel = exchangeSlOrderId !== null ? `SL order#${exchangeSlOrderId}` : "SL order(placement failed, local polling fallback)";
    console.log(
      `${label} Buy ${signal.symbol}: qty=${execQty.toFixed(6)}, avgPrice=$${avgPrice.toFixed(4)}, fee=$${totalFee.toFixed(4)}, ${slLabel}`
    );

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * Handle sell signal or stop loss/take profit trigger
   */
  async handleSell(
    symbol: string,
    currentPrice: number,
    reason: string
  ): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const position = account.positions[symbol];

    if (!position) {
      return { trade: null, skipped: `${symbol} no position`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🗑️ Cancel take profit order (avoid duplicate sell)
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* may already be filled or not exist, ignore */ }
    }
    // Cancel native stop loss order (P7.1: prevent orphan orders)
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    } else if (position.stopLossOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.stopLossOrderId); }
      catch { /* may already be filled, ignore */ }
    }

    // 🔥 Execute real sell
    let order: OrderResponse;
    try {
      order = await this.client.marketSell(symbol, position.quantity);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] Sell ${symbol} failed: ${msg}`, { cause: err });
    }

    const avgPrice =
      order.fills && order.fills.length > 0
        ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
          parseFloat(order.executedQty)
        : currentPrice;

    const execQty = parseFloat(order.executedQty);
    const grossUsdt = execQty * avgPrice;
    const totalFee = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;
    const netUsdt = grossUsdt - totalFee;

    const costBasis = position.quantity * position.entryPrice;
    const pnl = netUsdt - costBasis;
    const pnlPercent = pnl / costBasis;

    if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

    // Sync real balance from Binance
    const realBalance = await this.client.getUsdtBalance();
    account.usdt = realBalance;
    Reflect.deleteProperty(account.positions, symbol);

    const trade = orderToPaperTrade(order, "sell", reason, pnl, pnlPercent);
    account.trades.push(trade);
    saveAccount(account, this.scenarioId);

    const isStopLoss = reason.includes("stop_loss") || reason.includes("Stop loss");
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    console.log(
      `${label} Sell ${symbol}: qty=${execQty.toFixed(6)}, avgPrice=$${avgPrice.toFixed(4)}, ` +
      `PnL=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%)`
    );

    return {
      trade,
      stopLossTriggered: isStopLoss,
      stopLossTrade: isStopLoss ? trade : null,
      account,
      orderId: order.orderId,
    };
  }

  /**
   * Open short (Futures/Margin only)
   * Uses marketSell by quantity to short, margin calculates in USDT then converts
   */
  async handleShort(signal: Signal): Promise<LiveEngineResult> {
    const market = this.cfg.exchange.market;
    if (market !== "futures" && market !== "margin") {
      const skipped = `Short requires futures/margin market, current is ${market}`;
      const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    resetDailyLossIfNeeded(account);

    if (account.positions[signal.symbol]) {
      return { trade: null, skipped: `${signal.symbol} already has position, skipping short`, stopLossTriggered: false, stopLossTrade: null, account };
    }
    if (Object.keys(account.positions).length >= this.cfg.risk.max_positions && this.cfg.risk.max_positions > 0) {
      return { trade: null, skipped: `Max positions reached, skipping short ${signal.symbol}`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    const realBalance = await this.client.getUsdtBalance();
    const equity = Math.min(realBalance, calcTotalEquity(account, { [signal.symbol]: signal.price }));

    if ((account.dailyLoss.loss / equity) * 100 >= this.cfg.risk.daily_loss_limit_percent) {
      return { trade: null, skipped: `Daily loss limit reached, pausing short entries`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // Calculate margin and quantity
    let marginToLock: number;
    const atrCfg = this.cfg.risk.atr_position;
    if (atrCfg?.enabled && signal.indicators.atr) {
      marginToLock = calcAtrPositionSize(equity, signal.price, signal.indicators.atr,
        atrCfg.risk_per_trade_percent / 100, atrCfg.atr_multiplier, atrCfg.max_position_ratio);
    } else {
      marginToLock = equity * this.cfg.risk.position_ratio;
    }

    if (marginToLock < this.cfg.execution.min_order_usdt) {
      return { trade: null, skipped: `Margin $${marginToLock.toFixed(2)} below minimum order amount`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // Calculate quantity based on current price
    const symbolInfo = await this.client.getSymbolInfo(signal.symbol);
    const rawQty = marginToLock / signal.price;
    const qty = Math.floor(rawQty / symbolInfo.stepSize) * symbolInfo.stepSize;

    // 🛡️ F4: Pre-entry price deviation check (prevent shorting during flash crash)
    const sMaxSlippage = this.cfg.execution.max_entry_slippage ?? 0;
    if (sMaxSlippage > 0) {
      const currentPrice = await this.client.getPrice(signal.symbol);
      const drift = Math.abs(currentPrice - signal.price) / signal.price;
      if (drift > sMaxSlippage) {
        const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
        const skipped = `${label} Short cancelled ${signal.symbol}: price deviation ${(drift * 100).toFixed(2)}% > ${(sMaxSlippage * 100).toFixed(1)}% (signal $${signal.price.toFixed(4)}, current $${currentPrice.toFixed(4)})`;
        console.log(skipped);
        return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
      }
    }

    // 🔥 Execute real short order (Futures: SELL = open short)
    let order: OrderResponse;
    try {
      order = await this.client.marketSell(signal.symbol, qty);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] Short ${signal.symbol} failed: ${msg}`, { cause: err });
    }

    // F5: Register short entry order
    registerOrder(account, {
      orderId: order.orderId,
      symbol: signal.symbol,
      side: "short",
      placedAt: Date.now(),
      requestedQty: qty,
      filledQty: 0,
      timeoutMs: (this.cfg.execution.order_timeout_seconds ?? 30) * 1000,
    });

    const avgPrice = order.fills && order.fills.length > 0
      ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / parseFloat(order.executedQty)
      : signal.price;

    const execQty = parseFloat(order.executedQty);
    const totalFee = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;
    const actualMargin = marginToLock - totalFee;

    // F2: Partial fill detection
    const sFillRatio = execQty / (qty || 1);
    if (sFillRatio < 0.95) {
      const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
      console.warn(`${label} ⚠️ Short partial fill ${signal.symbol}: requested ${qty.toFixed(6)}, filled ${execQty.toFixed(6)} (${(sFillRatio * 100).toFixed(1)}%)`);
    }

    // 🛡️ Zero fill protection: exchange accepted order but no fills (testnet low liquidity etc.), skip position record
    if (execQty === 0) {
      const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
      console.warn(`${label} ⚠️ Short ${signal.symbol} order 0 fills, skipping position record (orderId=${order.orderId})`);
      return {
        trade: null,
        skipped: `Short ${signal.symbol} order not filled (0 fill), orderId=${order.orderId}`,
        stopLossTriggered: false,
        stopLossTrade: null,
        account,
      };
    }
    confirmOrder(account, order.orderId, execQty, qty);

    // ATR dynamic stop loss (short direction: stop loss at entry price + ATR x multiplier)
    const sAtrCfg = this.cfg.risk.atr_position;
    const sSignalAtr = signal.indicators.atr;
    const shortStopLoss = (sAtrCfg?.enabled && sSignalAtr)
      ? avgPrice + sSignalAtr * sAtrCfg.atr_multiplier
      : avgPrice * (1 + this.cfg.risk.stop_loss_percent / 100);
    const shortTakeProfit = avgPrice * (1 - this.cfg.risk.take_profit_percent / 100);

    // 🛡️ Place native stop loss order (P7.1: Futures short stop loss needs BUY side)
    const shortExchangeSlOrderId = await this.placeExchangeStopLoss(
      signal.symbol, "short", execQty, shortStopLoss
    );
    let shortTpOrderId: number | undefined;
    try {
      const tpOrder = await this.client.placeTakeProfitOrder(signal.symbol, "BUY", execQty, shortTakeProfit);
      if (tpOrder.orderId !== -1) shortTpOrderId = tpOrder.orderId;
    } catch (err) {
      console.warn(`[LiveExecutor] Short take profit order placement failed ${signal.symbol}:`, err instanceof Error ? err.message : err);
    }

    account.usdt = realBalance - marginToLock;
    account.positions[signal.symbol] = {
      symbol: signal.symbol,
      side: "short",
      quantity: execQty,
      entryPrice: avgPrice,
      entryTime: order.transactTime,
      stopLoss: shortStopLoss,
      takeProfit: shortTakeProfit,
      marginUsdt: actualMargin,
      entryOrderId: order.orderId,
      ...(shortExchangeSlOrderId !== null && {
        stopLossOrderId: shortExchangeSlOrderId,
        exchangeSlOrderId: shortExchangeSlOrderId,
        exchangeSlPrice: shortStopLoss,
      }),
      ...(shortTpOrderId !== undefined && { takeProfitOrderId: shortTpOrderId }),
    };

    const trade = orderToPaperTrade(order, "short", signal.reason.join(", "));
    account.trades.push(trade);
    cleanupOrders(account);
    saveAccount(account, this.scenarioId);

    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const slLabel = shortExchangeSlOrderId !== null ? `SL order#${shortExchangeSlOrderId}` : "SL order(placement failed, local polling fallback)";
    console.log(`${label} Short ${signal.symbol}: qty=${execQty.toFixed(6)}, avgPrice=$${avgPrice.toFixed(4)}, fee=$${totalFee.toFixed(4)}, ${slLabel}`);

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * Cover short (Futures: BUY = buy back to return)
   */
  async handleCover(symbol: string, currentPrice: number, reason: string): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const position = account.positions[symbol];

    if (position?.side !== "short") {
      return { trade: null, skipped: `${symbol} no short position`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🗑️ Cancel take profit order
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* may already be filled, ignore */ }
    }
    // Cancel native stop loss order (P7.1: prevent orphan orders)
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    } else if (position.stopLossOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.stopLossOrderId); }
      catch { /* may already be filled, ignore */ }
    }

    // 🔥 Execute real cover short order (Futures: BUY = cover short)
    let order: OrderResponse;
    try {
      order = await this.client.marketBuyByQty(symbol, position.quantity);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] Cover short ${symbol} failed: ${msg}`, { cause: err });
    }

    const avgPrice = order.fills && order.fills.length > 0
      ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / parseFloat(order.executedQty)
      : currentPrice;

    const execQty = parseFloat(order.executedQty);
    const totalFee = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;
    const marginUsdt = position.marginUsdt ?? position.quantity * position.entryPrice;
    const pnl = (position.entryPrice - avgPrice) * execQty - totalFee;
    const pnlPercent = pnl / marginUsdt;

    if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

    const realBalance = await this.client.getUsdtBalance();
    account.usdt = realBalance;
    Reflect.deleteProperty(account.positions, symbol);

    const trade = orderToPaperTrade(order, "cover", reason, pnl, pnlPercent);
    account.trades.push(trade);
    saveAccount(account, this.scenarioId);

    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    console.log(`${label} Cover short ${symbol}: qty=${execQty.toFixed(6)}, avgPrice=$${avgPrice.toFixed(4)}, PnL=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%)`);

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * Check all positions for stop loss / take profit (long + short, polling mode)
   */
  async checkExitConditions(prices: Record<string, number>): Promise<
    { symbol: string; trade: PaperTrade; reason: ExitReason; pnlPercent: number }[]
  > {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    resetDailyLossIfNeeded(account);
    const results: { symbol: string; trade: PaperTrade; reason: ExitReason; pnlPercent: number }[] = [];

    for (const [symbol, pos] of Object.entries(account.positions)) {
      const currentPrice = prices[symbol];
      if (!currentPrice) continue;

      const isShort = pos.side === "short";

      // ── Priority: check exchange stop loss / take profit order status ──
      // If the order has been filled, exchange has auto-triggered, just sync local account
      let exchangeTriggeredReason: ExitReason | null = null;
      let exchangeTriggeredPrice = currentPrice;

      for (const [orderId, reason] of [
        [pos.stopLossOrderId, "stop_loss" as ExitReason],
        [pos.takeProfitOrderId, "take_profit" as ExitReason],
      ] as [number | undefined, ExitReason][]) {
        if (orderId === undefined) continue;
        try {
          const orderStatus = await this.client.getOrder(symbol, orderId);
          if (orderStatus.status === "FILLED") {
            // Parse actual fill average price (B5 bug fix)
            const fills = orderStatus.fills;
            if (fills && fills.length > 0) {
              exchangeTriggeredPrice = fills.reduce((s, f) =>
                s + parseFloat(f.price) * parseFloat(f.qty), 0
              ) / parseFloat(orderStatus.executedQty);
            } else if (parseFloat(orderStatus.price) > 0) {
              exchangeTriggeredPrice = parseFloat(orderStatus.price);
            }
            exchangeTriggeredReason = reason;
            break; // Only process the first filled order
          }
        } catch { /* Query failed, fall back to price polling */ }
      }

      // ── If exchange has triggered stop loss / take profit: sync local account ──
      if (exchangeTriggeredReason) {
        const pnlPercent = isShort
          ? ((pos.entryPrice - exchangeTriggeredPrice) / pos.entryPrice) * 100
          : ((exchangeTriggeredPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const label = `[Exchange Auto] ${exchangeTriggeredReason === "stop_loss" ? "Stop Loss" : "Take Profit"} @ $${exchangeTriggeredPrice.toFixed(4)}`;
        try {
          const result = isShort
            ? await this.handleCover(symbol, exchangeTriggeredPrice, label)
            : await this.handleSell(symbol, exchangeTriggeredPrice, label);
          if (result.trade) {
            results.push({ symbol, trade: result.trade, reason: exchangeTriggeredReason, pnlPercent });
          }
        } catch (err) {
          console.error(`[LiveExecutor] Exchange stop loss sync failed ${symbol}:`, err);
        }
        continue; // No need for further price checks
      }

      // ── Fallback: local price polling (safety net when limit orders fail) ──
      const pnlPercent = isShort
        ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
        : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // ── P8.1 Break-Even Stop / Custom Stoploss ──
      {
        const holdMs = Date.now() - pos.entryTime;
        const profitRatio = isShort
          ? (pos.entryPrice - currentPrice) / pos.entryPrice
          : (currentPrice - pos.entryPrice) / pos.entryPrice;
        const newStop = resolveNewStopLoss(
          pos.side ?? "long",
          pos.entryPrice,
          pos.stopLoss,
          currentPrice,
          profitRatio,
          holdMs,
          symbol,
          this.cfg.risk,
          this.strategy,
          undefined // StrategyContext not available in executor loop
        );
        if (newStop !== null) {
          const oldStop = pos.stopLoss;
          pos.stopLoss = newStop;
          // If there is a native stop loss order, cancel it first then place a new one
          if (pos.exchangeSlOrderId !== undefined) {
            await this.cancelExchangeStopLoss(symbol, pos.exchangeSlOrderId);
            const newSlOrderId = await this.placeExchangeStopLoss(
              symbol,
              pos.side ?? "long",
              pos.quantity,
              newStop
            );
            if (newSlOrderId !== null) {
              pos.exchangeSlOrderId = newSlOrderId;
              pos.exchangeSlPrice = newStop;
            }
          }
          saveAccount(account, this.scenarioId);
          const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
          console.log(
            `${label} [break-even] ${symbol} SL updated: $${oldStop.toFixed(4)} → $${newStop.toFixed(4)}`
          );
        }
      }

      const hitStopLoss = isShort ? currentPrice >= pos.stopLoss : currentPrice <= pos.stopLoss;
      const hitTakeProfit = isShort ? currentPrice <= pos.takeProfit : currentPrice >= pos.takeProfit;

      // ── ROI Table time-decay take profit (local polling fallback) ──
      const roiTable = this.cfg.risk.minimal_roi;
      const hitRoiTable =
        roiTable !== undefined &&
        Object.keys(roiTable).length > 0 &&
        (() => {
          const holdMs = Date.now() - pos.entryTime;
          const profitRatio = isShort
            ? (pos.entryPrice - currentPrice) / pos.entryPrice
            : (currentPrice - pos.entryPrice) / pos.entryPrice;
          return checkMinimalRoi(roiTable, holdMs, profitRatio);
        })();

      let exitReason: ExitReason | null = null;
      let exitLabel = "";

      if (hitStopLoss) {
        exitReason = "stop_loss";
        exitLabel = `[Local Poll] Stop loss triggered: loss ${Math.abs(pnlPercent).toFixed(2)}% (SL price $${pos.stopLoss.toFixed(4)})`;
      } else if (hitRoiTable) {
        exitReason = "take_profit";
        const holdMin = Math.round((Date.now() - pos.entryTime) / 60_000);
        exitLabel = `[Local Poll] ROI Table take profit: held ${holdMin}min, profit ${pnlPercent.toFixed(2)}%`;
      } else if (hitTakeProfit) {
        exitReason = "take_profit";
        exitLabel = `[Local Poll] Take profit triggered: profit ${pnlPercent.toFixed(2)}% (TP price $${pos.takeProfit.toFixed(4)})`;
      }

      if (exitReason) {
        // ── P8.2 Exit confirmation hook ──────────────────────────────────
        {
          const holdMs = Date.now() - pos.entryTime;
          const profitRatio = isShort
            ? (pos.entryPrice - currentPrice) / pos.entryPrice
            : (currentPrice - pos.entryPrice) / pos.entryPrice;
          const maxDev = this.cfg.execution.max_exit_price_deviation ?? 0.15;
          const cooldownSec = this.cfg.execution.exit_rejection_cooldown_seconds ?? 300;
          const confirmResult = shouldConfirmExit(
            { symbol, side: pos.side ?? "long", entryPrice: pos.entryPrice, currentPrice, profitRatio, holdMs },
            exitReason,
            maxDev,
            this.strategy,
            undefined // StrategyContext not available in executor loop
          );
          if (!confirmResult.confirmed) {
            const cooling = isExitRejectionCoolingDown(symbol, cooldownSec * 1000, this._exitRejectionLog);
            if (!cooling) {
              console.log(
                `[confirm-exit] ${symbol} exit rejected (reason: ${confirmResult.reason ?? "unknown"}, exitReason: ${exitReason})`
              );
              this._exitRejectionLog.set(symbol, Date.now());
            }
            continue;
          }
        }
        // ── Exit execution ───────────────────────────────────────────
        try {
          const result = isShort
            ? await this.handleCover(symbol, currentPrice, exitLabel)
            : await this.handleSell(symbol, currentPrice, exitLabel);
          if (result.trade) {
            results.push({ symbol, trade: result.trade, reason: exitReason, pnlPercent });
          }
        } catch (err: unknown) {
          console.error(`[LiveExecutor] Stop loss / take profit execution failed ${symbol}:`, err);
        }
      }
    }

    return results;
  }

  /**
   * F2/F5: Orphan order scan on startup
   *
   * Called at live-monitor startup to detect orphan orders left from previous process crash:
   * 1. Fetch all open orders from Binance
   * 2. Compare with local account.openOrders (registered but still pending orders)
   * 3. Orphan orders (exist on Binance but locally timed out / still pending) -> attempt to cancel
   * 4. Clean up filled/cancelled order local state
   *
   * @returns Number of cancelled orphan orders
   */
  async scanOpenOrders(): Promise<number> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    let cancelledCount = 0;

    // Get all locally pending orders that have timed out
    const timedOut = getTimedOutOrders(account);
    if (timedOut.length === 0) {
      cleanupOrders(account);
      saveAccount(account, this.scenarioId);
      return 0;
    }

    console.log(`${label} Found ${timedOut.length} timed-out pending orders, checking orphan status...`);

    for (const pending of timedOut) {
      try {
        const orderStatus = await this.client.getOrder(pending.symbol, pending.orderId);
        const status = orderStatus.status;

        if (status === "FILLED") {
          // Order filled but not confirmed locally -> mark as completed
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(`${label} Orphan order #${pending.orderId} (${pending.symbol}) filled, synced local state`);
        } else if (status === "PARTIALLY_FILLED" || status === "NEW") {
          // Still pending -> cancel
          await this.client.cancelOrder(pending.symbol, pending.orderId);
          cancelOrder(account, pending.orderId);
          cancelledCount++;
          console.log(`${label} Cancelled orphan order #${pending.orderId} (${pending.symbol}, status=${status})`);
        } else {
          // CANCELLED / EXPIRED etc. -> clean up local record directly
          cancelOrder(account, pending.orderId);
        }
      } catch (err) {
        console.warn(`${label} Scan order #${pending.orderId} failed:`, err instanceof Error ? err.message : err);
      }
    }

    cleanupOrders(account);
    saveAccount(account, this.scenarioId);
    return cancelledCount;
  }

  /**
   * G3: Called each main loop iteration -- check all timed-out order statuses, handle orphan entry/exit orders
   *
   * Flow:
   *   1. Call getTimedOutOrders(account) to get timed-out pending orders
   *   2. Query actual status on Binance
   *      - FILLED / PARTIALLY_FILLED -> confirmOrder (sync local state)
   *      - NEW (entry timeout) -> cancel + notify
   *      - NEW (exit timeout) -> cancel + notify (next iteration will re-trigger checkExitConditions)
   *   3. Save updated account state
   *
   * @param account Current account (already loaded via loadAccount, passed in for reuse)
   */
  async checkOrderTimeouts(account: PaperAccount): Promise<void> {
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const timedOut = getTimedOutOrders(account);
    if (timedOut.length === 0) return;

    console.log(`${label} checkOrderTimeouts: found ${timedOut.length} timed-out orders`);

    for (const pending of timedOut) {
      try {
        const orderStatus = await this.client.getOrder(pending.symbol, pending.orderId);
        const status = orderStatus.status;

        if (status === "FILLED") {
          // Filled but not confirmed locally -> sync
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(
            `${label} Timed-out order #${pending.orderId} (${pending.symbol}) filled, local state synced qty=${orderStatus.executedQty}`
          );
        } else if (status === "PARTIALLY_FILLED") {
          // Partially filled -> record actual executed quantity
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(
            `${label} Timed-out order #${pending.orderId} (${pending.symbol}) partially filled ${orderStatus.executedQty}/${pending.requestedQty.toFixed(6)}`
          );
        } else if (status === "NEW") {
          // Still pending but timed out -> cancel
          const isEntry = pending.side === "buy" || pending.side === "short";
          const typeLabel = isEntry ? "entry" : "exit";
          await this.client.cancelOrder(pending.symbol, pending.orderId);
          cancelOrder(account, pending.orderId);
          console.log(
            `${label} Timed-out ${typeLabel} order #${pending.orderId} (${pending.symbol}) cancelled. ` +
            (isEntry ? "Skipping entry this round." : "Waiting for next checkExitConditions to re-trigger.")
          );

          // P7.2: Exit order timeout tracking -> force market exit after threshold reached
          if (!isEntry) {
            const pos = account.positions[pending.symbol];
            if (pos) {
              pos.exitTimeoutCount = (pos.exitTimeoutCount ?? 0) + 1;
              if (pos.exitTimeoutCount >= EXIT_TIMEOUT_MAX_RETRIES) {
                console.warn(
                  `[ForceExit] ${pending.symbol} exit timed out ${EXIT_TIMEOUT_MAX_RETRIES} times, triggering forced market liquidation`
                );
                await this.forceExit(account, pos, this.scenarioId, "force_exit_timeout");
              }
            }
          }
        } else {
          // CANCELLED / EXPIRED / REJECTED etc. -> clean up local record
          cancelOrder(account, pending.orderId);
          console.log(
            `${label} Order #${pending.orderId} (${pending.symbol}) status=${status}, cleaning up local record`
          );
        }
      } catch (err) {
        console.warn(
          `${label} checkOrderTimeouts: failed to process order #${pending.orderId} (${pending.symbol}):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    cleanupOrders(account);
    saveAccount(account, this.scenarioId);
  }

  // ─────────────────────────────────────────────────────
  // Native stop loss order management (P7.1)
  // ─────────────────────────────────────────────────────

  /**
   * Place a native stop loss order on the exchange (STOP_LOSS_LIMIT / STOP_MARKET)
   * Long position -> place sell stop loss; Short position -> place buy stop loss
   * On failure, logs a warning but does not interrupt the flow (local stop loss serves as fallback)
   */
  async placeExchangeStopLoss(
    symbol: string,
    side: "long" | "short",
    qty: number,
    stopPrice: number
  ): Promise<number | null> {
    try {
      const orderSide = side === "long" ? ("SELL" as const) : ("BUY" as const);
      const slOrder = await this.client.placeStopLossOrder(symbol, orderSide, qty, stopPrice);
      // orderId=-1 means downgraded to local polling stop loss (LOCAL_ONLY), do not record exchange orderId
      if (slOrder.orderId === -1) return null;
      return slOrder.orderId;
    } catch (err: unknown) {
      console.warn(
        `[LiveExecutor] Native stop loss order placement failed ${symbol} (${side}):`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  /**
   * Cancel an existing native stop loss order (called on position close, to prevent orphan orders)
   * On failure, logs a warning but does not throw
   */
  async cancelExchangeStopLoss(symbol: string, orderId: number): Promise<void> {
    try {
      await this.client.cancelOrder(symbol, orderId);
    } catch (err: unknown) {
      console.warn(
        `[LiveExecutor] Cancel native stop loss order failed ${symbol} #${orderId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Check if native stop loss orders have been triggered (called in the main loop)
   * If stop loss order status is FILLED -> mark as closed locally
   */
  async syncExchangeStopLosses(account: PaperAccount, scenarioId: string): Promise<void> {
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";

    for (const [symbol, pos] of Object.entries(account.positions)) {
      if (pos.exchangeSlOrderId === undefined) continue;

      try {
        const orderStatus = await this.client.getOrder(symbol, pos.exchangeSlOrderId);
        const status = orderStatus.status;

        if (status === "FILLED") {
          const fills = orderStatus.fills;
          let exitPrice = parseFloat(orderStatus.price);
          if (fills && fills.length > 0) {
            exitPrice = fills.reduce(
              (s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0
            ) / parseFloat(orderStatus.executedQty);
          }
          console.log(
            `${label} [syncExchangeStopLosses] ${symbol} native stop loss order #${pos.exchangeSlOrderId} triggered @ $${exitPrice.toFixed(4)}`
          );
          const isShort = pos.side === "short";
          const pnl = isShort
            ? (pos.entryPrice - exitPrice) * pos.quantity
            : (exitPrice - pos.entryPrice) * pos.quantity;
          if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);
          Reflect.deleteProperty(account.positions, symbol);
        } else if (status === "CANCELED" || status === "EXPIRED" || status === "REJECTED") {
          console.warn(
            `${label} [syncExchangeStopLosses] ${symbol} native stop loss order #${pos.exchangeSlOrderId} abnormal status: ${status} (local polling as fallback)`
          );
        }
        // NEW / PARTIALLY_FILLED -> no action
      } catch (err: unknown) {
        console.warn(
          `${label} [syncExchangeStopLosses] query ${symbol} stop loss order #${pos.exchangeSlOrderId} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    saveAccount(account, scenarioId);
  }

  // ─────────────────────────────────────────────────────
  // Strategy-driven DCA (adjustPosition hook)
  // ─────────────────────────────────────────────────────

  /**
   * Check all positions for strategy-driven add/reduce (adjustPosition hook).
   *
   * If the strategy implements adjustPosition:
   *   > 0 -> add to position (buy corresponding USDT amount on exchange)
   *   < 0 -> reduce position (sell corresponding USDT worth of position)
   *   0 / null -> no action
   *
   * If the strategy has no adjustPosition method, falls back to built-in DCA dropPct logic.
   */
  async checkDcaTranches(
    prices: Record<string, number>,
    ctx?: StrategyContext
  ): Promise<{ symbol: string; side: "add" | "reduce"; usdtAmount: number }[]> {
    const dcaCfg = this.cfg.risk.dca;
    if (!dcaCfg?.enabled) return [];

    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const results: { symbol: string; side: "add" | "reduce"; usdtAmount: number }[] = [];
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";

    for (const [symbol, pos] of Object.entries(account.positions)) {
      if (!pos.dcaState) continue;
      const dca = pos.dcaState;

      const currentPrice = prices[symbol];
      if (!currentPrice) continue;

      const side = (pos.side ?? "long") as "long" | "short";
      const costBasis = pos.quantity * pos.entryPrice;
      const profitRatio = side === "short"
        ? (pos.entryPrice - currentPrice) / pos.entryPrice
        : (currentPrice - pos.entryPrice) / pos.entryPrice;
      const holdMs = Date.now() - pos.entryTime;
      const dcaCount = dca.completedTranches - 1;

      // ── Priority: strategy adjustPosition hook ──────────────────────────
      if (this.strategy?.adjustPosition !== undefined && ctx !== undefined) {
        const adjustAmount = this.strategy.adjustPosition(
          { symbol, side, entryPrice: pos.entryPrice, currentPrice, quantity: pos.quantity, costBasis, profitRatio, holdMs, dcaCount },
          ctx
        );

        if (adjustAmount !== null && adjustAmount !== 0) {
          if (adjustAmount > 0) {
            // Add to position
            try {
              const order = await this.client.marketBuy(symbol, adjustAmount);
              const execQty = parseFloat(order.executedQty);
              const avgPrice = order.fills && order.fills.length > 0
                ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / execQty
                : currentPrice;
              dca.completedTranches += 1;
              dca.lastTranchePrice = avgPrice;
              pos.quantity += execQty;
              pos.entryPrice = (costBasis + adjustAmount) / pos.quantity;
              account.usdt -= adjustAmount;
              saveAccount(account, this.scenarioId);
              results.push({ symbol, side: "add", usdtAmount: adjustAmount });
              console.log(`${label} [adjustPosition] ${symbol} added $${adjustAmount.toFixed(2)}`);
            } catch (err) {
              console.warn(`${label} [adjustPosition] ${symbol} add failed:`, err instanceof Error ? err.message : err);
            }
          } else {
            // Reduce position
            const reduceUsdt = Math.abs(adjustAmount);
            const reduceQty = reduceUsdt / currentPrice;
            if (reduceQty > 0 && reduceQty <= pos.quantity) {
              try {
                const order = await this.client.marketSell(symbol, reduceQty);
                const execQty = parseFloat(order.executedQty);
                pos.quantity -= execQty;
                if (pos.quantity <= 0) {
                  Reflect.deleteProperty(account.positions, symbol);
                }
                account.usdt += reduceUsdt;
                saveAccount(account, this.scenarioId);
                results.push({ symbol, side: "reduce", usdtAmount: reduceUsdt });
                console.log(`${label} [adjustPosition] ${symbol} reduced $${reduceUsdt.toFixed(2)}`);
              } catch (err) {
                console.warn(`${label} [adjustPosition] ${symbol} reduce failed:`, err instanceof Error ? err.message : err);
              }
            }
          }
          continue; // Strategy handled, skip default DCA
        }
        // adjustAmount === null/0 → fall through to default DCA logic
      }

      // ── Default DCA logic ────────────────────────────────────────────
      if (dca.completedTranches >= dca.totalTranches) continue;
      if (Date.now() - dca.startedAt > dca.maxMs) continue;

      const dropPct = ((dca.lastTranchePrice - currentPrice) / dca.lastTranchePrice) * 100;
      if (dropPct < dca.dropPct) continue;

      const realBalance = await this.client.getUsdtBalance();
      const equity = Math.min(realBalance, calcTotalEquity(account, prices));
      const addUsdt = equity * this.cfg.risk.position_ratio;

      if (addUsdt < this.cfg.execution.min_order_usdt) continue;

      try {
        const order = await this.client.marketBuy(symbol, addUsdt);
        const execQty = parseFloat(order.executedQty);
        const avgPrice = order.fills && order.fills.length > 0
          ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / execQty
          : currentPrice;
        dca.completedTranches += 1;
        dca.lastTranchePrice = avgPrice;
        pos.quantity += execQty;
        pos.entryPrice = (costBasis + addUsdt) / pos.quantity;
        account.usdt -= addUsdt;
        saveAccount(account, this.scenarioId);
        results.push({ symbol, side: "add", usdtAmount: addUsdt });
        console.log(`${label} [DCA] ${symbol} default add $${addUsdt.toFixed(2)} (drop ${dropPct.toFixed(1)}%)`);
      } catch (err) {
        console.warn(`${label} [DCA] ${symbol} add failed:`, err instanceof Error ? err.message : err);
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────
  // Force exit (P7.2)
  // ─────────────────────────────────────────────────────

  /**
   * Force market exit
   * 1. Cancel all pending orders (including native stop loss orders)
   * 2. Place MARKET exit order
   * 3. Mark as closed locally
   * 4. Send Telegram notification
   */
  async forceExit(
    account: PaperAccount,
    position: PaperPosition,
    scenarioId: string,
    reason: "force_exit_timeout" | "force_exit_manual"
  ): Promise<void> {
    const symbol = position.symbol;
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const isShort = position.side === "short";

    // 1. Cancel all pending orders (native stop loss, take profit)
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    }
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* may already be filled, ignore */ }
    }

    // 2. Place market exit order
    let exitPrice = position.entryPrice; // Fallback price
    try {
      let exitOrder: OrderResponse;
      if (isShort) {
        exitOrder = await this.client.marketBuyByQty(symbol, position.quantity);
      } else {
        exitOrder = await this.client.marketSell(symbol, position.quantity);
      }

      const fills = exitOrder.fills;
      if (fills && fills.length > 0) {
        exitPrice = fills.reduce(
          (s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0
        ) / parseFloat(exitOrder.executedQty);
      } else if (parseFloat(exitOrder.price) > 0) {
        exitPrice = parseFloat(exitOrder.price);
      }

      const execQty = parseFloat(exitOrder.executedQty);
      const totalFee = exitOrder.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;
      const grossUsdt = execQty * exitPrice;
      const costBasis = position.quantity * position.entryPrice;
      const pnl = isShort
        ? (position.entryPrice - exitPrice) * execQty - totalFee
        : grossUsdt - totalFee - costBasis;

      if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

      const trade: PaperTrade = {
        id: `force_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        symbol,
        side: isShort ? "cover" : "sell",
        quantity: execQty,
        price: exitPrice,
        usdtAmount: grossUsdt,
        fee: totalFee,
        slippage: 0,
        timestamp: Date.now(),
        reason,
        pnl,
        pnlPercent: pnl / costBasis,
      };
      account.trades.push(trade);

      console.log(
        `${label} [ForceExit] ${symbol} forced exit: price=$${exitPrice.toFixed(4)}, PnL=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, reason=${reason}`
      );
    } catch (err: unknown) {
      console.error(
        `${label} [ForceExit] ${symbol} force exit order failed:`,
        err instanceof Error ? err.message : err
      );
    }

    // 3. Mark position as closed locally (regardless of order success)
    position.exitTimeoutCount = 0;
    Reflect.deleteProperty(account.positions, symbol);
    saveAccount(account, scenarioId);

    // 4. Send Telegram notification
    try {
      const reasonLabel = reason === "force_exit_timeout"
        ? `Exit timed out ${EXIT_TIMEOUT_MAX_RETRIES} times`
        : "Manual force exit";
      sendTelegramMessage(
        `⚠️ [ForceExit] ${symbol} Forced market exit\nReason: ${reasonLabel}\nExit price: $${exitPrice.toFixed(4)}`
      );
    } catch { /* Notification failure does not affect main flow */ }
  }
}

// ─────────────────────────────────────────────────────
// Factory function
// ─────────────────────────────────────────────────────

/**
 * Create a LiveExecutor from RuntimeConfig
 * Automatically determines testnet / live based on cfg.mode
 */
export function createLiveExecutor(cfg: RuntimeConfig): LiveExecutor {
  return new LiveExecutor(cfg);
}

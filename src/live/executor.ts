/**
 * 实盘/Testnet 交易执行器
 *
 * 职责：
 * - 接收信号（Signal），通过 BinanceClient 执行真实下单
 * - 持仓状态同步到本地 JSON（与 paper 格式兼容，便于复用统计工具）
 * - 止损/止盈/追踪止损检查（通过下限价单或轮询触发）
 *
 * 使用方式：
 *   mode: "testnet"  → 连 testapi.binance.vision（虚拟资金，真实价格）
 *   mode: "live"     → 连 api.binance.com（⚠️ 真实资金）
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
import type { ExitReason } from "../paper/engine.js";
import type { ExchangePosition } from "./reconcile.js";
import { sendTelegramMessage } from "../notify/openclaw.js";

// 出场订单连续超时 N 次后触发强制市价清仓
const EXIT_TIMEOUT_MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────
// 结果类型（与 PaperEngineResult 兼容）
// ─────────────────────────────────────────────────────

export interface LiveEngineResult {
  trade: PaperTrade | null;
  skipped?: string;
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
  orderId?: number; // Binance 订单 ID
}

// ─────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────

function generateId(): string {
  return `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 将 Binance OrderResponse 转换为 PaperTrade 格式（便于统计复用） */
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
    slippage: 0, // 实盘没有模拟滑点
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
// LiveExecutor 类
// ─────────────────────────────────────────────────────

export class LiveExecutor {
  private readonly client: BinanceClient;
  private readonly cfg: RuntimeConfig;
  private readonly scenarioId: string;
  private readonly isTestnet: boolean;

  constructor(cfg: RuntimeConfig) {
    this.cfg = cfg;
    this.scenarioId = cfg.paper.scenarioId;
    this.isTestnet = cfg.exchange.testnet ?? false;

    const credsPath = cfg.exchange.credentials_path ?? ".secrets/binance.json";
    const market = cfg.exchange.market === "futures" ? "futures" : "spot";

    this.client = new BinanceClient(credsPath, this.isTestnet, market);
  }

  /** 测试连接 */
  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  /** 获取账户 USDT 余额（同步本地账户） */
  async syncBalance(): Promise<number> {
    return this.client.getUsdtBalance();
  }

  /**
   * 从交易所读取真实持仓（用于对账）
   * Futures：读取 positionRisk，过滤 positionAmt != 0
   * Spot：当前不支持，返回空数组
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
      return []; // spot 或不支持的市场返回空数组
    }
  }

  /**
   * 处理买入信号
   * 流程：检查仓位上限 → 计算仓位大小 → 下市价单 → 更新本地账户
   */
  async handleBuy(signal: Signal): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    resetDailyLossIfNeeded(account);

    const openCount = Object.keys(account.positions).length;
    if (openCount >= this.cfg.risk.max_positions) {
      const skipped = `已达最大持仓数 ${this.cfg.risk.max_positions}，跳过 ${signal.symbol}`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    if (account.positions[signal.symbol]) {
      const skipped = `${signal.symbol} 已有持仓，跳过`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 从 Binance 获取真实余额（同步）
    const realBalance = await this.client.getUsdtBalance();
    const equity = Math.min(realBalance, calcTotalEquity(account, { [signal.symbol]: signal.price }));

    // 检查每日亏损限制
    if ((account.dailyLoss.loss / equity) * 100 >= this.cfg.risk.daily_loss_limit_percent) {
      const skipped = `今日亏损已达 ${this.cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 计算仓位大小
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

    // 检查最小下单金额
    const minOrder = this.cfg.execution.min_order_usdt;
    if (usdtToSpend < minOrder) {
      const skipped = `仓位 $${usdtToSpend.toFixed(2)} 低于最小下单金额 $${minOrder}`;
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🛡️ F4: 入场前价格偏离检查（防闪崩误买）
    const maxSlippage = this.cfg.execution.max_entry_slippage ?? 0;
    if (maxSlippage > 0) {
      const currentPrice = await this.client.getPrice(signal.symbol);
      const drift = Math.abs(currentPrice - signal.price) / signal.price;
      if (drift > maxSlippage) {
        const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
        const skipped = `${label} 入场取消 ${signal.symbol}: 价格偏离 ${(drift * 100).toFixed(2)}% > ${(maxSlippage * 100).toFixed(1)}%（信号 $${signal.price.toFixed(4)}，当前 $${currentPrice.toFixed(4)}）`;
        console.log(skipped);
        return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
      }
    }

    // 🔥 执行真实下单
    let order: OrderResponse;
    try {
      order = await this.client.marketBuy(signal.symbol, usdtToSpend);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] 买入 ${signal.symbol} 失败: ${msg}`, { cause: err });
    }

    // F5: 注册入场订单（孤儿检测基础）
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

    // 计算实际成交均价
    const avgPrice =
      order.fills && order.fills.length > 0
        ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
          parseFloat(order.executedQty)
        : signal.price;

    const execQty = parseFloat(order.executedQty);
    const totalFee = order.fills?.reduce((s, f) => s + parseFloat(f.commission), 0) ?? 0;

    // F2: 部分成交检测
    const fillRatio = execQty / (expectedQty || 1);
    if (fillRatio < 0.95) {
      const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
      console.warn(`${label} ⚠️ 部分成交 ${signal.symbol}: 请求 ${expectedQty.toFixed(6)}, 实际成交 ${execQty.toFixed(6)} (${(fillRatio * 100).toFixed(1)}%)`);
    }
    confirmOrder(account, order.orderId, execQty, expectedQty);

    // 更新本地账户（镜像真实状态）
    // ATR 动态止损：当 atr_position 启用且信号含有 ATR 时，用 ATR × multiplier 作为止损距离
    const signalAtr = signal.indicators.atr;
    const stopLossPrice = (atrCfg?.enabled && signalAtr)
      ? avgPrice - signalAtr * atrCfg.atr_multiplier
      : avgPrice * (1 - this.cfg.risk.stop_loss_percent / 100);
    const takeProfitPrice = avgPrice * (1 + this.cfg.risk.take_profit_percent / 100);

    // 🛡️ 在交易所挂原生止损单（P7.1）
    const exchangeSlOrderId = await this.placeExchangeStopLoss(
      signal.symbol, "long", execQty, stopLossPrice
    );
    let takeProfitOrderId: number | undefined;
    try {
      const tpOrder = await this.client.placeTakeProfitOrder(
        signal.symbol, "SELL", execQty, takeProfitPrice
      );
      takeProfitOrderId = tpOrder.orderId;
    } catch (err) {
      console.warn(`[LiveExecutor] 止盈单挂单失败 ${signal.symbol}:`, err instanceof Error ? err.message : err);
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
    cleanupOrders(account); // 清理已完成订单，避免状态表膨胀
    saveAccount(account, this.scenarioId);

    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const slLabel = exchangeSlOrderId !== null ? `止损单#${exchangeSlOrderId}` : "止损单(挂单失败，本地轮询兜底)";
    console.log(
      `${label} 买入 ${signal.symbol}: 数量=${execQty.toFixed(6)}, 均价=$${avgPrice.toFixed(4)}, 手续费=$${totalFee.toFixed(4)}, ${slLabel}`
    );

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * 处理卖出信号或止损/止盈触发
   */
  async handleSell(
    symbol: string,
    currentPrice: number,
    reason: string
  ): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const position = account.positions[symbol];

    if (!position) {
      return { trade: null, skipped: `${symbol} 无持仓`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🗑️ 取消止盈挂单（避免重复卖出）
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* 可能已成交或不存在，忽略 */ }
    }
    // 取消原生止损单（P7.1：防止孤单）
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    } else if (position.stopLossOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.stopLossOrderId); }
      catch { /* 可能已成交，忽略 */ }
    }

    // 🔥 执行真实卖出
    let order: OrderResponse;
    try {
      order = await this.client.marketSell(symbol, position.quantity);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] 卖出 ${symbol} 失败: ${msg}`, { cause: err });
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

    // 从 Binance 同步真实余额
    const realBalance = await this.client.getUsdtBalance();
    account.usdt = realBalance;
    Reflect.deleteProperty(account.positions, symbol);

    const trade = orderToPaperTrade(order, "sell", reason, pnl, pnlPercent);
    account.trades.push(trade);
    saveAccount(account, this.scenarioId);

    const isStopLoss = reason.includes("止损");
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    console.log(
      `${label} 卖出 ${symbol}: 数量=${execQty.toFixed(6)}, 均价=$${avgPrice.toFixed(4)}, ` +
      `盈亏=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%)`
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
   * 开空（Futures/Margin 专用）
   * 使用 marketSell 以数量做空，margin 以 USDT 计算后换算
   */
  async handleShort(signal: Signal): Promise<LiveEngineResult> {
    const market = this.cfg.exchange.market;
    if (market !== "futures" && market !== "margin") {
      const skipped = `开空需要 futures/margin 市场，当前为 ${market}`;
      const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
      return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
    }

    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    resetDailyLossIfNeeded(account);

    if (account.positions[signal.symbol]) {
      return { trade: null, skipped: `${signal.symbol} 已有持仓，跳过开空`, stopLossTriggered: false, stopLossTrade: null, account };
    }
    if (Object.keys(account.positions).length >= this.cfg.risk.max_positions) {
      return { trade: null, skipped: `已达最大持仓数，跳过开空 ${signal.symbol}`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    const realBalance = await this.client.getUsdtBalance();
    const equity = Math.min(realBalance, calcTotalEquity(account, { [signal.symbol]: signal.price }));

    if ((account.dailyLoss.loss / equity) * 100 >= this.cfg.risk.daily_loss_limit_percent) {
      return { trade: null, skipped: `今日亏损已达上限，暂停开空`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 计算保证金与数量
    let marginToLock: number;
    const atrCfg = this.cfg.risk.atr_position;
    if (atrCfg?.enabled && signal.indicators.atr) {
      marginToLock = calcAtrPositionSize(equity, signal.price, signal.indicators.atr,
        atrCfg.risk_per_trade_percent / 100, atrCfg.atr_multiplier, atrCfg.max_position_ratio);
    } else {
      marginToLock = equity * this.cfg.risk.position_ratio;
    }

    if (marginToLock < this.cfg.execution.min_order_usdt) {
      return { trade: null, skipped: `保证金 $${marginToLock.toFixed(2)} 低于最小下单金额`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 按当前价格计算数量
    const symbolInfo = await this.client.getSymbolInfo(signal.symbol);
    const rawQty = marginToLock / signal.price;
    const qty = Math.floor(rawQty / symbolInfo.stepSize) * symbolInfo.stepSize;

    // 🛡️ F4: 入场前价格偏离检查（防闪崩误空）
    const sMaxSlippage = this.cfg.execution.max_entry_slippage ?? 0;
    if (sMaxSlippage > 0) {
      const currentPrice = await this.client.getPrice(signal.symbol);
      const drift = Math.abs(currentPrice - signal.price) / signal.price;
      if (drift > sMaxSlippage) {
        const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
        const skipped = `${label} 开空取消 ${signal.symbol}: 价格偏离 ${(drift * 100).toFixed(2)}% > ${(sMaxSlippage * 100).toFixed(1)}%（信号 $${signal.price.toFixed(4)}，当前 $${currentPrice.toFixed(4)}）`;
        console.log(skipped);
        return { trade: null, skipped, stopLossTriggered: false, stopLossTrade: null, account };
      }
    }

    // 🔥 执行真实做空下单（Futures: SELL = 开空）
    let order: OrderResponse;
    try {
      order = await this.client.marketSell(signal.symbol, qty);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] 开空 ${signal.symbol} 失败: ${msg}`, { cause: err });
    }

    // F5: 注册空头入场订单
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

    // F2: 部分成交检测
    const sFillRatio = execQty / (qty || 1);
    if (sFillRatio < 0.95) {
      const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
      console.warn(`${label} ⚠️ 空头部分成交 ${signal.symbol}: 请求 ${qty.toFixed(6)}, 实际成交 ${execQty.toFixed(6)} (${(sFillRatio * 100).toFixed(1)}%)`);
    }
    confirmOrder(account, order.orderId, execQty, qty);

    // ATR 动态止损（做空方向：止损在入场价 + ATR × multiplier）
    const sAtrCfg = this.cfg.risk.atr_position;
    const sSignalAtr = signal.indicators.atr;
    const shortStopLoss = (sAtrCfg?.enabled && sSignalAtr)
      ? avgPrice + sSignalAtr * sAtrCfg.atr_multiplier
      : avgPrice * (1 + this.cfg.risk.stop_loss_percent / 100);
    const shortTakeProfit = avgPrice * (1 - this.cfg.risk.take_profit_percent / 100);

    // 🛡️ 挂原生止损单（P7.1：Futures 做空止损需 BUY 方向）
    const shortExchangeSlOrderId = await this.placeExchangeStopLoss(
      signal.symbol, "short", execQty, shortStopLoss
    );
    let shortTpOrderId: number | undefined;
    try {
      const tpOrder = await this.client.placeTakeProfitOrder(signal.symbol, "BUY", execQty, shortTakeProfit);
      shortTpOrderId = tpOrder.orderId;
    } catch (err) {
      console.warn(`[LiveExecutor] 空头止盈单挂单失败 ${signal.symbol}:`, err instanceof Error ? err.message : err);
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
    const slLabel = shortExchangeSlOrderId !== null ? `止损单#${shortExchangeSlOrderId}` : "止损单(挂单失败，本地轮询兜底)";
    console.log(`${label} 开空 ${signal.symbol}: 数量=${execQty.toFixed(6)}, 均价=$${avgPrice.toFixed(4)}, 手续费=$${totalFee.toFixed(4)}, ${slLabel}`);

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * 平空（Futures: BUY = 买回归还）
   */
  async handleCover(symbol: string, currentPrice: number, reason: string): Promise<LiveEngineResult> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const position = account.positions[symbol];

    if (position?.side !== "short") {
      return { trade: null, skipped: `${symbol} 无空头持仓`, stopLossTriggered: false, stopLossTrade: null, account };
    }

    // 🗑️ 取消止盈挂单
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* 可能已成交，忽略 */ }
    }
    // 取消原生止损单（P7.1：防止孤单）
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    } else if (position.stopLossOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.stopLossOrderId); }
      catch { /* 可能已成交，忽略 */ }
    }

    // 🔥 执行真实平空下单（Futures: BUY = 平空）
    let order: OrderResponse;
    try {
      order = await this.client.marketBuyByQty(symbol, position.quantity);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LiveExecutor] 平空 ${symbol} 失败: ${msg}`, { cause: err });
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
    console.log(`${label} 平空 ${symbol}: 数量=${execQty.toFixed(6)}, 均价=$${avgPrice.toFixed(4)}, 盈亏=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%)`);

    return { trade, stopLossTriggered: false, stopLossTrade: null, account, orderId: order.orderId };
  }

  /**
   * 检查所有持仓的止损/止盈（多头 + 空头，轮询模式）
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

      // ── 优先：查询交易所止损/止盈单状态 ──
      // 如果挂单已经被填充，说明交易所已自动止损，只需同步本地账户
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
            // 解析实际成交均价（修复 B5 bug）
            const fills = orderStatus.fills;
            if (fills && fills.length > 0) {
              exchangeTriggeredPrice = fills.reduce((s, f) =>
                s + parseFloat(f.price) * parseFloat(f.qty), 0
              ) / parseFloat(orderStatus.executedQty);
            } else if (parseFloat(orderStatus.price) > 0) {
              exchangeTriggeredPrice = parseFloat(orderStatus.price);
            }
            exchangeTriggeredReason = reason;
            break; // 只处理第一个已成交的单
          }
        } catch { /* 查询失败，回退到价格轮询 */ }
      }

      // ── 如果交易所已触发止损/止盈：同步本地账户 ──
      if (exchangeTriggeredReason) {
        const pnlPercent = isShort
          ? ((pos.entryPrice - exchangeTriggeredPrice) / pos.entryPrice) * 100
          : ((exchangeTriggeredPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const label = `[交易所自动] ${exchangeTriggeredReason === "stop_loss" ? "止损" : "止盈"} @ $${exchangeTriggeredPrice.toFixed(4)}`;
        try {
          const result = isShort
            ? await this.handleCover(symbol, exchangeTriggeredPrice, label)
            : await this.handleSell(symbol, exchangeTriggeredPrice, label);
          if (result.trade) {
            results.push({ symbol, trade: result.trade, reason: exchangeTriggeredReason, pnlPercent });
          }
        } catch (err) {
          console.error(`[LiveExecutor] 交易所止损同步失败 ${symbol}:`, err);
        }
        continue; // 不需要再做价格检查
      }

      // ── 兜底：本地价格轮询（挂单失败时的保障）──
      const pnlPercent = isShort
        ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
        : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      const hitStopLoss = isShort ? currentPrice >= pos.stopLoss : currentPrice <= pos.stopLoss;
      const hitTakeProfit = isShort ? currentPrice <= pos.takeProfit : currentPrice >= pos.takeProfit;

      // ── ROI Table 时间衰减止盈（本地轮询兜底）──
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
        exitLabel = `[本地轮询] 止损触发：亏损 ${Math.abs(pnlPercent).toFixed(2)}%（止损价 $${pos.stopLoss.toFixed(4)}）`;
      } else if (hitRoiTable) {
        exitReason = "take_profit";
        const holdMin = Math.round((Date.now() - pos.entryTime) / 60_000);
        exitLabel = `[本地轮询] ROI Table 止盈：持仓 ${holdMin}min，盈利 ${pnlPercent.toFixed(2)}%`;
      } else if (hitTakeProfit) {
        exitReason = "take_profit";
        exitLabel = `[本地轮询] 止盈触发：盈利 ${pnlPercent.toFixed(2)}%（止盈价 $${pos.takeProfit.toFixed(4)}）`;
      }

      if (exitReason) {
        try {
          const result = isShort
            ? await this.handleCover(symbol, currentPrice, exitLabel)
            : await this.handleSell(symbol, currentPrice, exitLabel);
          if (result.trade) {
            results.push({ symbol, trade: result.trade, reason: exitReason, pnlPercent });
          }
        } catch (err: unknown) {
          console.error(`[LiveExecutor] 止损/止盈执行失败 ${symbol}:`, err);
        }
      }
    }

    return results;
  }

  /**
   * F2/F5: 启动时孤儿订单扫描
   *
   * 在 live-monitor 启动时调用，检测上次进程崩溃后遗留的孤儿挂单：
   * 1. 拉取 Binance 当前所有 open orders
   * 2. 对比本地 account.openOrders（已注册但状态仍 pending 的订单）
   * 3. 孤儿订单（Binance 有但本地超时仍 pending）→ 尝试取消
   * 4. 清理已成交/已取消订单的本地状态
   *
   * @returns 取消的孤儿订单数量
   */
  async scanOpenOrders(): Promise<number> {
    const account = loadAccount(this.cfg.paper.initial_usdt, this.scenarioId);
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    let cancelledCount = 0;

    // 获取所有超时仍未确认的本地挂单
    const timedOut = getTimedOutOrders(account);
    if (timedOut.length === 0) {
      cleanupOrders(account);
      saveAccount(account, this.scenarioId);
      return 0;
    }

    console.log(`${label} 发现 ${timedOut.length} 个超时挂单，检查孤儿状态...`);

    for (const pending of timedOut) {
      try {
        const orderStatus = await this.client.getOrder(pending.symbol, pending.orderId);
        const status = orderStatus.status;

        if (status === "FILLED") {
          // 订单已成交但本地未确认 → 标记为已完成
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(`${label} 孤儿订单 #${pending.orderId} (${pending.symbol}) 已成交，同步本地状态`);
        } else if (status === "PARTIALLY_FILLED" || status === "NEW") {
          // 仍在挂单 → 取消
          await this.client.cancelOrder(pending.symbol, pending.orderId);
          cancelOrder(account, pending.orderId);
          cancelledCount++;
          console.log(`${label} 已取消孤儿挂单 #${pending.orderId} (${pending.symbol}, 状态=${status})`);
        } else {
          // CANCELLED / EXPIRED 等 → 直接清理本地记录
          cancelOrder(account, pending.orderId);
        }
      } catch (err) {
        console.warn(`${label} 扫描订单 #${pending.orderId} 失败:`, err instanceof Error ? err.message : err);
      }
    }

    cleanupOrders(account);
    saveAccount(account, this.scenarioId);
    return cancelledCount;
  }

  /**
   * G3: 每轮主循环调用——检查所有超时订单状态，处理孤儿入场/出场单
   *
   * 流程：
   *   1. 调用 getTimedOutOrders(account) 获取超时挂单
   *   2. 查询 Binance 实际状态
   *      - FILLED / PARTIALLY_FILLED → confirmOrder（同步本地状态）
   *      - NEW（入场超时） → cancel + 通知
   *      - NEW（出场超时） → cancel + 通知（下一轮会重新触发 checkExitConditions）
   *   3. 保存更新后的账户状态
   *
   * @param account 当前账户（已 loadAccount，外部传入复用）
   */
  async checkOrderTimeouts(account: PaperAccount): Promise<void> {
    const label = this.isTestnet ? "[TESTNET]" : "[LIVE]";
    const timedOut = getTimedOutOrders(account);
    if (timedOut.length === 0) return;

    console.log(`${label} checkOrderTimeouts: 发现 ${timedOut.length} 个超时订单`);

    for (const pending of timedOut) {
      try {
        const orderStatus = await this.client.getOrder(pending.symbol, pending.orderId);
        const status = orderStatus.status;

        if (status === "FILLED") {
          // 已成交但本地未确认 → 同步
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(
            `${label} 超时订单 #${pending.orderId} (${pending.symbol}) 已成交，本地状态已同步 qty=${orderStatus.executedQty}`
          );
        } else if (status === "PARTIALLY_FILLED") {
          // 部分成交 → 记录实际成交量
          confirmOrder(account, pending.orderId, parseFloat(orderStatus.executedQty), pending.requestedQty);
          console.log(
            `${label} 超时订单 #${pending.orderId} (${pending.symbol}) 部分成交 ${orderStatus.executedQty}/${pending.requestedQty.toFixed(6)}`
          );
        } else if (status === "NEW") {
          // 仍在挂单但已超时 → 取消
          const isEntry = pending.side === "buy" || pending.side === "short";
          const typeLabel = isEntry ? "入场" : "出场";
          await this.client.cancelOrder(pending.symbol, pending.orderId);
          cancelOrder(account, pending.orderId);
          console.log(
            `${label} 超时${typeLabel}订单 #${pending.orderId} (${pending.symbol}) 已取消。` +
            (isEntry ? "本轮跳过入场。" : "等待下轮 checkExitConditions 重新触发。")
          );

          // P7.2: 出场订单超时追踪 → 达阈值后强制市价出场
          if (!isEntry) {
            const pos = account.positions[pending.symbol];
            if (pos) {
              pos.exitTimeoutCount = (pos.exitTimeoutCount ?? 0) + 1;
              if (pos.exitTimeoutCount >= EXIT_TIMEOUT_MAX_RETRIES) {
                console.warn(
                  `[ForceExit] ${pending.symbol} 出场超时 ${EXIT_TIMEOUT_MAX_RETRIES} 次，触发强制市价清仓`
                );
                await this.forceExit(account, pos, this.scenarioId, "force_exit_timeout");
              }
            }
          }
        } else {
          // CANCELLED / EXPIRED / REJECTED 等 → 清理本地记录
          cancelOrder(account, pending.orderId);
          console.log(
            `${label} 订单 #${pending.orderId} (${pending.symbol}) 状态=${status}，清理本地记录`
          );
        }
      } catch (err) {
        console.warn(
          `${label} checkOrderTimeouts: 处理订单 #${pending.orderId} (${pending.symbol}) 失败:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    cleanupOrders(account);
    saveAccount(account, this.scenarioId);
  }

  // ─────────────────────────────────────────────────────
  // 原生止损单管理（P7.1）
  // ─────────────────────────────────────────────────────

  /**
   * 在交易所挂原生止损单（STOP_LOSS_LIMIT / STOP_MARKET）
   * long 仓位 → 挂卖出止损；short 仓位 → 挂买入止损
   * 失败时记录 warn 日志但不中断流程（本地止损作为兜底）
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
      return slOrder.orderId;
    } catch (err: unknown) {
      console.warn(
        `[LiveExecutor] 原生止损单挂单失败 ${symbol} (${side}):`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  /**
   * 取消已挂的原生止损单（平仓时调用，防止孤单）
   * 失败时记录 warn 但不抛错
   */
  async cancelExchangeStopLoss(symbol: string, orderId: number): Promise<void> {
    try {
      await this.client.cancelOrder(symbol, orderId);
    } catch (err: unknown) {
      console.warn(
        `[LiveExecutor] 取消原生止损单失败 ${symbol} #${orderId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * 检查原生止损单是否已触发（在主循环中调用）
   * 若止损单状态为 FILLED → 本地标记为已平仓
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
            `${label} [syncExchangeStopLosses] ${symbol} 原生止损单 #${pos.exchangeSlOrderId} 已触发 @ $${exitPrice.toFixed(4)}`
          );
          const isShort = pos.side === "short";
          const pnl = isShort
            ? (pos.entryPrice - exitPrice) * pos.quantity
            : (exitPrice - pos.entryPrice) * pos.quantity;
          if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);
          Reflect.deleteProperty(account.positions, symbol);
        } else if (status === "CANCELED" || status === "EXPIRED" || status === "REJECTED") {
          console.warn(
            `${label} [syncExchangeStopLosses] ${symbol} 原生止损单 #${pos.exchangeSlOrderId} 状态异常: ${status}（本地轮询作为兜底）`
          );
        }
        // NEW / PARTIALLY_FILLED → 无操作
      } catch (err: unknown) {
        console.warn(
          `${label} [syncExchangeStopLosses] 查询 ${symbol} 止损单 #${pos.exchangeSlOrderId} 失败:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    saveAccount(account, scenarioId);
  }

  // ─────────────────────────────────────────────────────
  // 强制出场（P7.2）
  // ─────────────────────────────────────────────────────

  /**
   * 强制市价出场
   * 1. 取消所有挂单（包括原生止损单）
   * 2. 下 MARKET 出场单
   * 3. 本地标记为已平仓
   * 4. 发 Telegram 通知
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

    // 1. 取消所有挂单（原生止损、止盈）
    if (position.exchangeSlOrderId !== undefined) {
      await this.cancelExchangeStopLoss(symbol, position.exchangeSlOrderId);
    }
    if (position.takeProfitOrderId !== undefined) {
      try { await this.client.cancelOrder(symbol, position.takeProfitOrderId); }
      catch { /* 可能已成交，忽略 */ }
    }

    // 2. 下市价出场单
    let exitPrice = position.entryPrice; // 兜底价格
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
        `${label} [ForceExit] ${symbol} 强制出场: 价格=$${exitPrice.toFixed(4)}, 盈亏=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, 原因=${reason}`
      );
    } catch (err: unknown) {
      console.error(
        `${label} [ForceExit] ${symbol} 强制出场下单失败:`,
        err instanceof Error ? err.message : err
      );
    }

    // 3. 本地标记为已平仓（无论下单是否成功）
    position.exitTimeoutCount = 0;
    Reflect.deleteProperty(account.positions, symbol);
    saveAccount(account, scenarioId);

    // 4. 发 Telegram 通知
    try {
      const reasonLabel = reason === "force_exit_timeout"
        ? `出场超时 ${EXIT_TIMEOUT_MAX_RETRIES} 次`
        : "手动强制出场";
      sendTelegramMessage(
        `⚠️ [ForceExit] ${symbol} 强制市价出场\n原因：${reasonLabel}\n出场价：$${exitPrice.toFixed(4)}`
      );
    } catch { /* 通知失败不影响主流程 */ }
  }
}

// ─────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────

/**
 * 从 RuntimeConfig 创建 LiveExecutor
 * 根据 cfg.mode 自动判断 testnet / live
 */
export function createLiveExecutor(cfg: RuntimeConfig): LiveExecutor {
  return new LiveExecutor(cfg);
}

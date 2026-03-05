/**
 * Backtest Engine Main Loop
 *
 * Design principles:
 * 1. Multi-symbol shared account (consistent with live/paper behavior)
 * 2. Sliding window indicator calculation (consistent with real-time monitor)
 * 3. Intra-candle high/low price stop loss/take profit (more realistic than close-only)
 * 4. Stop loss takes priority over take profit (pessimistic model, prevents over-optimistic estimates)
 */

import { calculateIndicators } from "../strategy/indicators.js";
import { processSignal } from "../strategy/signal-engine.js";
import { getMinimalRoiThreshold } from "../strategy/roi-table.js";
import { resolveNewStopLoss } from "../strategy/break-even.js";
import { shouldConfirmExit } from "../strategy/confirm-exit.js";
import type { Kline, StrategyConfig } from "../types.js";
import {
  calculateMetrics,
  type BacktestTrade,
  type BacktestMetrics,
  type EquityPoint,
} from "./metrics.js";
import type { FundingRateRecord } from "./fetcher.js";
import type { Strategy, StrategyContext, TradeResult } from "../strategies/types.js";
// Side effect: register all built-in strategies
import "../strategies/index.js";
import { getStrategy } from "../strategies/registry.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

/** Trade execution function only needs fee rate + slippage + spread parameters */
interface ExecOpts { feeRate: number; slippagePercent: number; spreadBps: number; }

interface BacktestPosition {
  symbol: string;
  side?: "long" | "short"; // undefined treated as long (backward compatible)
  entryTime: number;
  entryPrice: number; // includes slippage
  quantity: number;
  cost: number;      // long: USDT spent on buy; short: locked margin (including fees)
  marginUsdt?: number; // short only: net margin (after fees, for return)
  stopLoss: number;
  takeProfit: number;
  trailingStop?: {
    active: boolean;
    highestPrice: number; // long: highest price during position
    lowestPrice?: number; // short: lowest price during position
    stopPrice: number;
  };
  /** G4: whether positive trailing is activated (modeled after Freqtrade trailing_stop_positive_offset) */
  trailingStopActivated?: boolean;
  // Funding rate tracking (Futures only)
  lastFundingTs?: number;    // last funding rate settlement time (milliseconds)
  totalFundingPaid?: number; // cumulative funding paid (positive=paid out, negative=received)
  // Signal conditions that triggered the entry
  signalConditions?: string[];
}

interface BacktestAccount {
  usdt: number;
  positions: Record<string, BacktestPosition>;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  // Daily loss tracking
  dailyLoss: { date: string; loss: number };
  // Cumulative funding rate net expenditure per symbol (positive=cost, negative=income)
  fundingPaidBySymbol: Record<string, number>;
}

export interface BacktestOptions {
  initialUsdt?: number;       // default 1000
  feeRate?: number;           // default 0.001 (0.1%)
  slippagePercent?: number;   // default 0.05%
  /**
   * Backtest simulated bid/ask spread (basis points bps). e.g. 5 = 0.05%. Default 0 (no simulation)
   * Buy: actual entry price = close * (1 + spreadBps / 20000) (buy at ask)
   * Sell: actual exit price = close * (1 - spreadBps / 20000) (sell at bid)
   * Reversed for short. Spread cost is added on top of existing slippage.
   */
  spreadBps?: number;
  /**
   * Futures funding rate (settled every 8h)
   * When provided, automatically deducted/credited for both long/short positions
   * ── Choose one of two methods ──
   */
  avgFundingRatePer8h?: number;                             // cross-symbol average (e.g. -0.0001)
  fundingHistory?: Record<string, FundingRateRecord[]>;    // per-symbol historical rates (precise)
  /**
   * P6.3 Intra-candle Simulation
   * true (default): use candle high/low for stop loss/take profit detection, stop loss takes priority (conservative model)
   * false: backward compatible, all exits use close price (legacy behavior)
   */
  intracandle?: boolean;
  /**
   * Test/externally injected strategy instance (takes priority over cfg.strategy_id registry lookup)
   * Used for passing mock strategies in unit tests without registering to the global registry.
   */
  strategyOverride?: Strategy;
  /**
   * Delay signal execution by one candle (execute at next candle open price)
   *
   * false (default): signal triggers at current candle close, fills at current close price.
   *                  Has look-ahead bias: in live trading, close signals can only fill on next candle.
   *
   * true (recommended): signal is recorded after current candle close, fills at next candle open.
   *                     Closer to live execution logic, more conservative and realistic backtest results.
   *                     Note: signals on the last candle are discarded (no next candle to fill).
   */
  signalToNextOpen?: boolean;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  totalFundingPaid: number;  // positive = net outflow (unfavorable), negative = net income
  perSymbol: Record<
    string,
    {
      trades: number;
      wins: number;
      losses: number;
      pnl: number;
      winRate: number;
      fundingPaid: number; // net funding rate expenditure for this symbol
    }
  >;
  config: {
    strategy: string;
    symbols: string[];
    timeframe: string;
    startDate: string;
    endDate: string;
    days: number;
    initialUsdt: number;
    fundingEnabled: boolean;
    /** Spread used in backtest (basis points), default 0 */
    spreadBps?: number;
    /** Delay signal execution by one candle (eliminates look-ahead bias), default false */
    signalToNextOpen: boolean;
  };
}

// ─────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function calcEquity(account: BacktestAccount, prices: Record<string, number>): number {
  let equity = account.usdt;
  for (const [sym, pos] of Object.entries(account.positions)) {
    const price = prices[sym] ?? pos.entryPrice;
    if (pos.side === "short") {
      const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
      equity += margin + (pos.entryPrice - price) * pos.quantity;
    } else {
      equity += pos.quantity * price;
    }
  }
  return equity;
}

function doBuy(
  account: BacktestAccount,
  symbol: string,
  price: number,
  time: number,
  cfg: StrategyConfig,
  opts: ExecOpts,
  signalConditions: string[] = []
): void {
  // Skip if already holding position
  if (account.positions[symbol]) return;

  // Max positions check
  if (Object.keys(account.positions).length >= cfg.risk.max_positions) return;

  // Daily loss limit
  const today = new Date(time).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }

  const equity = calcEquity(account, { [symbol]: price });
  const symbolValue = 0; // no position
  if (symbolValue / equity >= cfg.risk.max_position_per_symbol) return;
  if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) return;

  const usdtToSpend = equity * cfg.risk.position_ratio;
  if (usdtToSpend < cfg.execution.min_order_usdt) return;
  if (usdtToSpend > account.usdt) return;

  // Buy price slips up (slightly above quote): slippage + spread (buy at ask)
  // Don't additionally deduct slippageUsdt to avoid double counting with execPrice
  const spreadAdj = opts.spreadBps / 20000; // spreadBps/10000/2 -> half spread
  const execPrice = price * (1 + opts.slippagePercent / 100 + spreadAdj);
  const fee = usdtToSpend * opts.feeRate;
  const netUsdt = usdtToSpend - fee; // execPrice already includes slippage cost
  const quantity = netUsdt / execPrice;

  account.usdt -= usdtToSpend;

  const pos: BacktestPosition = {
    symbol,
    entryTime: time,
    entryPrice: execPrice,
    quantity,
    cost: usdtToSpend,
    stopLoss: execPrice * (1 - cfg.risk.stop_loss_percent / 100),
    takeProfit: execPrice * (1 + cfg.risk.take_profit_percent / 100),
    ...(signalConditions.length > 0 && { signalConditions }),
  };

  if (cfg.risk.trailing_stop.enabled) {
    pos.trailingStop = {
      active: false,
      highestPrice: execPrice,
      stopPrice: 0,
    };
  }

  account.positions[symbol] = pos;

  // Only record buy event (for debugging), trade PnL is calculated at sell time
  account.trades.push({
    symbol,
    side: "buy",
    entryTime: time,
    exitTime: time,
    entryPrice: execPrice,
    exitPrice: execPrice,
    quantity,
    cost: usdtToSpend,
    proceeds: 0,
    pnl: 0,
    pnlPercent: 0,
    exitReason: "signal",
    ...(signalConditions.length > 0 && { signalConditions }),
  });
}

function doOpenShort(
  account: BacktestAccount,
  symbol: string,
  price: number,
  time: number,
  cfg: StrategyConfig,
  opts: ExecOpts,
  signalConditions: string[] = []
): void {
  if (account.positions[symbol]) return;
  if (Object.keys(account.positions).length >= cfg.risk.max_positions) return;

  const today = new Date(time).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) account.dailyLoss = { date: today, loss: 0 };

  const equity = calcEquity(account, { [symbol]: price });
  if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) return;

  const marginToLock = equity * cfg.risk.position_ratio;
  if (marginToLock < cfg.execution.min_order_usdt || marginToLock > account.usdt) return;

  // Open short: sell at bid (slightly below quote), slippage + spread stacked
  const spreadAdjShortOpen = opts.spreadBps / 20000;
  const execPrice = price * (1 - opts.slippagePercent / 100 - spreadAdjShortOpen);
  const fee = marginToLock * opts.feeRate;
  const actualMargin = marginToLock - fee;
  const quantity = actualMargin / execPrice;

  account.usdt -= marginToLock;

  const pos: BacktestPosition = {
    symbol,
    side: "short",
    entryTime: time,
    entryPrice: execPrice,
    quantity,
    cost: marginToLock,     // total locked margin (including fees)
    marginUsdt: actualMargin, // net margin (for return)
    stopLoss: execPrice * (1 + cfg.risk.stop_loss_percent / 100),   // price rises above = loss
    takeProfit: execPrice * (1 - cfg.risk.take_profit_percent / 100), // price drops below = profit
    ...(signalConditions.length > 0 && { signalConditions }),
  };

  if (cfg.risk.trailing_stop.enabled) {
    pos.trailingStop = { active: false, highestPrice: execPrice, lowestPrice: execPrice, stopPrice: 0 };
  }

  account.positions[symbol] = pos;
}

function doCoverShort(
  account: BacktestAccount,
  symbol: string,
  exitPrice: number,
  exitTime: number,
  exitReason: BacktestTrade["exitReason"],
  opts: ExecOpts
): void {
  const pos = account.positions[symbol];
  if (pos?.side !== "short") return;

  // Cover short by buying: buy at ask (fill price slightly higher), slippage + spread stacked
  const spreadAdjCover = opts.spreadBps / 20000;
  const execPrice = exitPrice * (1 + opts.slippagePercent / 100 + spreadAdjCover);
  const grossUsdt = pos.quantity * execPrice; // cost to buy back
  const fee = grossUsdt * opts.feeRate;
  const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
  const pnl = (pos.entryPrice - execPrice) * pos.quantity - fee;
  const pnlPercent = pnl / margin;
  const proceeds = Math.max(0, margin + pnl); // return: margin +/- PnL (minimum zero)

  const today = new Date(exitTime).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) account.dailyLoss = { date: today, loss: 0 };
  if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

  account.usdt += proceeds;
  const { [symbol]: _coveredPos, ...remainingAfterCover } = account.positions;
  account.positions = remainingAfterCover;

  account.trades.push({
    symbol,
    side: "cover",
    entryTime: pos.entryTime,
    exitTime,
    entryPrice: pos.entryPrice,
    exitPrice: execPrice,
    quantity: pos.quantity,
    cost: pos.cost,
    proceeds,
    pnl,
    pnlPercent,
    exitReason,
    ...(pos.signalConditions && pos.signalConditions.length > 0 && { signalConditions: pos.signalConditions }),
  });
}

function doSell(
  account: BacktestAccount,
  symbol: string,
  exitPrice: number,
  exitTime: number,
  exitReason: BacktestTrade["exitReason"],
  opts: ExecOpts
): void {
  const pos = account.positions[symbol];
  if (!pos) return;

  // Sell: sell at bid (slightly below quote), slippage + spread stacked
  const spreadAdjSell = opts.spreadBps / 20000;
  const execPrice = exitPrice * (1 - opts.slippagePercent / 100 - spreadAdjSell);
  const grossUsdt = pos.quantity * execPrice;
  const fee = grossUsdt * opts.feeRate;
  const proceeds = grossUsdt - fee;
  const pnl = proceeds - pos.cost;
  const pnlPercent = pnl / pos.cost;

  // Update daily loss
  const today = new Date(exitTime).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }
  if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

  account.usdt += proceeds;
  const { [symbol]: _soldPos, ...remainingAfterSell } = account.positions;
  account.positions = remainingAfterSell;

  account.trades.push({
    symbol,
    side: "sell",
    entryTime: pos.entryTime,
    exitTime,
    entryPrice: pos.entryPrice,
    exitPrice: execPrice,
    quantity: pos.quantity,
    cost: pos.cost,
    proceeds,
    pnl,
    pnlPercent,
    exitReason,
    ...(pos.signalConditions && pos.signalConditions.length > 0 && { signalConditions: pos.signalConditions }),
  });
}

function updateTrailingStop(
  pos: BacktestPosition,
  high: number,
  low: number,
  cfg: StrategyConfig
): boolean {
  if (!pos.trailingStop || !cfg.risk.trailing_stop.enabled) return false;
  const ts = pos.trailingStop;
  const { activation_percent, callback_percent } = cfg.risk.trailing_stop;

  // ── G4 Enhanced Trailing Stop: positive trailing offset ──────────
  const positivePct = cfg.risk.trailing_stop_positive;
  const positiveOffset = cfg.risk.trailing_stop_positive_offset;
  const onlyOffset = cfg.risk.trailing_only_offset_is_reached;

  // Current PnL% (simulated per-candle using high/low)
  const pnlPct = pos.side === "short"
    ? ((pos.entryPrice - low) / pos.entryPrice) * 100   // short: use best price (lowest)
    : ((high - pos.entryPrice) / pos.entryPrice) * 100; // long: use best price (highest)

  // Check if positive trailing should be activated
  if (positivePct !== undefined && positiveOffset !== undefined) {
    const offsetPct = positiveOffset * 100;
    if (!pos.trailingStopActivated && pnlPct >= offsetPct) {
      pos.trailingStopActivated = true;
    }
  }

  // trailing_only_offset_is_reached=true + offset not reached -> skip trailing
  const skipTrailing =
    onlyOffset === true &&
    positivePct !== undefined &&
    positiveOffset !== undefined &&
    !pos.trailingStopActivated;

  if (skipTrailing) return false;

  // Use positive trailing percentage (if activated) or original callback_percent
  const activeCallbackPct =
    pos.trailingStopActivated && positivePct !== undefined
      ? positivePct * 100
      : callback_percent;

  if (pos.side === "short") {
    // Short: track lowest price, close when price bounces from low
    ts.lowestPrice ??= pos.entryPrice;
    if (low < ts.lowestPrice) ts.lowestPrice = low;
    const lowestPrice = ts.lowestPrice;
    const gainPct = ((pos.entryPrice - lowestPrice) / pos.entryPrice) * 100;
    if (!ts.active && gainPct >= activation_percent) ts.active = true;
    if (ts.active) {
      ts.stopPrice = lowestPrice * (1 + activeCallbackPct / 100);
      return high >= ts.stopPrice; // high price hits stop, close short
    }
  } else {
    // Long: track highest price, close when price pulls back from high
    if (high > ts.highestPrice) ts.highestPrice = high;
    const gainPct = ((ts.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (!ts.active && gainPct >= activation_percent) ts.active = true;
    if (ts.active) {
      ts.stopPrice = ts.highestPrice * (1 - activeCallbackPct / 100);
      return low <= ts.stopPrice; // low price hits stop, close long
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────
// P6.3 — Intra-candle Simulated Exit Check
// ─────────────────────────────────────────────────────

/**
 * Simulate stop loss/take profit exits within a single candle (more realistic than close-only)
 *
 * Priority (conservative assumption: adverse direction occurs first):
 *   Long: stop loss (low) > ROI > take profit (high) > staged take profit > trailing stop > time stop
 *   Short: stop loss (high) > ROI > take profit (low) > staged take profit > trailing stop > time stop
 *
 * @param pos               current position
 * @param kline             current candle OHLC
 * @param cfg               strategy config
 * @param time              current candle timestamp (openTime, milliseconds)
 * @param trailingTriggered return value of updateTrailingStop() (whether trailing stop triggered)
 * @param useIntracandle    true: use high/low (new behavior); false: use close (legacy behavior)
 * @returns { exitPrice, reason } when exit is triggered, otherwise null
 */
function checkIntracandleExit(
  pos: BacktestPosition,
  kline: { open: number; high: number; low: number; close: number },
  cfg: StrategyConfig,
  time: number,
  trailingTriggered: boolean,
  useIntracandle: boolean
): { exitPrice: number; reason: BacktestTrade["exitReason"] } | null {
  // Select check price based on intracandle mode
  const checkHigh = useIntracandle ? kline.high : kline.close;
  const checkLow  = useIntracandle ? kline.low  : kline.close;

  // ROI Table threshold (calculated once)
  const roiTable = cfg.risk.minimal_roi;
  const roiThreshold =
    roiTable !== undefined && Object.keys(roiTable).length > 0
      ? getMinimalRoiThreshold(roiTable, time - pos.entryTime)
      : null;

  if (pos.side === "short") {
    // ── Short exit: stop loss = price rises above, take profit = price drops below ──────────────

    // 1. Stop loss (high price touches stop loss line)
    if (checkHigh >= pos.stopLoss) {
      return { exitPrice: pos.stopLoss, reason: "stop_loss" };
    }

    // 2. ROI Table
    if (roiThreshold !== null) {
      const roiPrice = pos.entryPrice * (1 - roiThreshold);
      if (checkLow <= roiPrice) {
        return { exitPrice: Math.max(roiPrice, kline.close), reason: "take_profit" };
      }
    }

    // 3. Fixed take profit (low price touches take profit line)
    if (checkLow <= pos.takeProfit) {
      return { exitPrice: pos.takeProfit, reason: "take_profit" };
    }

    // 4. Staged take profit (short: low price touches target price)
    if (cfg.risk.take_profit_stages && cfg.risk.take_profit_stages.length > 0) {
      for (const stage of cfg.risk.take_profit_stages) {
        const stagePrice = pos.entryPrice * (1 - stage.at_percent / 100);
        if (checkLow <= stagePrice) {
          return { exitPrice: stagePrice, reason: "take_profit" };
        }
      }
    }

    // 5. Trailing stop
    if (trailingTriggered && pos.trailingStop?.stopPrice) {
      return { exitPrice: pos.trailingStop.stopPrice, reason: "trailing_stop" };
    }

    // 6. Time stop (exit if holding too long with no profit)
    if (cfg.risk.time_stop_hours) {
      const holdMs = time - pos.entryTime;
      if (holdMs >= cfg.risk.time_stop_hours * 3_600_000) {
        const pnlPct = ((pos.entryPrice - kline.close) / pos.entryPrice) * 100;
        if (pnlPct <= 0) {
          return { exitPrice: kline.close, reason: "time_stop" };
        }
      }
    }
  } else {
    // ── Long exit: stop loss = price drops below, take profit = price rises above ──────────────

    // 1. Stop loss (low price touches stop loss line)
    if (checkLow <= pos.stopLoss) {
      return { exitPrice: pos.stopLoss, reason: "stop_loss" };
    }

    // 2. ROI Table
    if (roiThreshold !== null) {
      const roiPrice = pos.entryPrice * (1 + roiThreshold);
      if (checkHigh >= roiPrice) {
        return { exitPrice: Math.min(roiPrice, kline.close), reason: "take_profit" };
      }
    }

    // 3. Fixed take profit (high price touches take profit line)
    if (checkHigh >= pos.takeProfit) {
      return { exitPrice: pos.takeProfit, reason: "take_profit" };
    }

    // 4. Staged take profit (long: high price touches target price)
    if (cfg.risk.take_profit_stages && cfg.risk.take_profit_stages.length > 0) {
      for (const stage of cfg.risk.take_profit_stages) {
        const stagePrice = pos.entryPrice * (1 + stage.at_percent / 100);
        if (checkHigh >= stagePrice) {
          return { exitPrice: stagePrice, reason: "take_profit" };
        }
      }
    }

    // 5. Trailing stop
    if (trailingTriggered && pos.trailingStop?.stopPrice) {
      return { exitPrice: pos.trailingStop.stopPrice, reason: "trailing_stop" };
    }

    // 6. Time stop (exit if holding too long with no profit)
    if (cfg.risk.time_stop_hours) {
      const holdMs = time - pos.entryTime;
      if (holdMs >= cfg.risk.time_stop_hours * 3_600_000) {
        const pnlPct = ((kline.close - pos.entryPrice) / pos.entryPrice) * 100;
        if (pnlPct <= 0) {
          return { exitPrice: kline.close, reason: "time_stop" };
        }
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────
// Main Backtest Function
// ─────────────────────────────────────────────────────

/**
 * Multi-symbol shared account backtest
 *
 * @param klinesBySymbol       complete historical klines per symbol (main timeframe, sorted by time)
 * @param cfg                  strategy config (merged from strategy.yaml + strategy file)
 * @param opts                 backtest options (initial capital, fees, slippage)
 * @param trendKlinesBySymbol  optional: higher timeframe klines (MTF trend filter, e.g. 4h)
 *                             when provided, buy signals only execute when trend MA is bullish
 */
// ─────────────────────────────────────────────────────
// Funding Rate Utilities
// ─────────────────────────────────────────────────────

/** Binance standard funding rate settlement times (every 8h, UTC) */
const FUNDING_INTERVAL_MS = 8 * 3600 * 1000;

/** Find all settlement time points in the [lastFundingTs, currentTs] interval */
function getFundingSettlements(lastTs: number, currentTs: number): number[] {
  const result: number[] = [];
  // Settlement times = 00:00 / 08:00 / 16:00 UTC daily
  // Find the first settlement time after lastTs
  const base = Math.ceil(lastTs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
  for (let t = base; t <= currentTs; t += FUNDING_INTERVAL_MS) {
    result.push(t);
  }
  return result;
}

/** Find the closest funding rate for a given time (from ts-sorted record array) */
function findFundingRate(
  history: FundingRateRecord[],
  settlementTs: number
): number {
  // Find the most recent record where ts <= settlementTs
  let best: FundingRateRecord | undefined;
  for (const r of history) {
    if (r.ts <= settlementTs) best = r;
    else break;
  }
  return best?.rate ?? 0;
}

export function runBacktest(
  klinesBySymbol: Record<string, Kline[]>,
  cfg: StrategyConfig,
  opts: BacktestOptions = {},
  trendKlinesBySymbol?: Record<string, Kline[]>
): BacktestResult {
  const { initialUsdt = 1000, feeRate = 0.001, slippagePercent = 0.05,
          avgFundingRatePer8h, fundingHistory, intracandle = true,
          signalToNextOpen = false } = opts;
  // spread_bps: opts takes priority, then cfg.risk.spread_bps, default 0
  const spreadBps = opts.spreadBps ?? cfg.risk.spread_bps ?? 0;
  const fundingEnabled = avgFundingRatePer8h !== undefined || fundingHistory !== undefined;
  // ExecOpts: only used by trade functions (fee + slippage + spread)
  const legacyOpts: ExecOpts = { feeRate, slippagePercent, spreadBps };

  // ── Strategy plugin lookup (for backtest hooks: shouldExit / customStoploss / confirmExit / onTradeClosed) ──
  let strategy: Strategy | undefined = opts.strategyOverride;
  if (strategy === undefined) {
    const strategyId = cfg.strategy_id;
    if (strategyId !== undefined && strategyId !== "") {
      try {
        strategy = getStrategy(strategyId);
      } catch {
        // Strategy not registered, ignore (doesn't affect existing backtest logic)
      }
    }
  }

  const symbols = Object.keys(klinesBySymbol);
  if (symbols.length === 0) {
    throw new Error("klinesBySymbol cannot be empty");
  }

  // ── Merge all kline timestamps (intersection, ensuring all symbols have data) ──
  const timeSets = symbols.map(
    (s) => new Set((klinesBySymbol[s] ?? []).map((k) => k.openTime))
  );
  const allTimes = Array.from(timeSets[0] ?? new Set<number>())
    .filter((t) => timeSets.every((set) => set.has(t)))
    .sort((a, b) => a - b);

  // ── Build time -> kline index ──
  const klineIndex: Record<string, Record<number, Kline>> = {};
  for (const sym of symbols) {
    klineIndex[sym] = {};
    for (const k of klinesBySymbol[sym] ?? []) {
      klineIndex[sym][k.openTime] = k;
    }
  }

  // ── Calculate warmup period length ──
  const macdCfg = cfg.strategy.macd;
  const macdMinBars = macdCfg.enabled ? macdCfg.slow + macdCfg.signal + 1 : 0;
  const warmupBars = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

  // ── Initialize account ──
  const account: BacktestAccount = {
    usdt: initialUsdt,
    positions: {},
    trades: [],
    equityCurve: [],
    dailyLoss: { date: todayStr(), loss: 0 },
    fundingPaidBySymbol: {},
  };

  // Sliding window (independent per symbol)
  const windows: Record<string, Kline[]> = {};
  for (const sym of symbols) windows[sym] = [];

  // ── MTF trend filter setup ──────────────────────────────
  const useMtf = trendKlinesBySymbol !== undefined;
  const trendWarmup = cfg.strategy.ma.long + 10;
  // Trend klines sorted by closeTime (for appending to trend window in chronological order)
  const trendSorted: Record<string, Kline[]> = {};
  const trendWindowPos: Record<string, number> = {}; // index of processed candles
  const trendWindows: Record<string, Kline[]> = {};
  if (useMtf) {
    for (const sym of symbols) {
      trendSorted[sym] = [...(trendKlinesBySymbol[sym] ?? [])].sort(
        (a, b) => a.closeTime - b.closeTime
      );
      trendWindowPos[sym] = 0;
      trendWindows[sym] = [];
    }
  }
  /** Get trend MA status for sym at time (bullish=true, bearish=false, no data=null) */
  function getTrendBull(sym: string, time: number): boolean | null {
    if (!useMtf) return null;
    const sorted = trendSorted[sym] ?? [];
    const pos = trendWindowPos[sym] ?? 0;
    let nextPos = pos;
    // Push trend klines with closeTime < time into window (only closed candles to avoid look-ahead bias)
    while (nextPos < sorted.length && (sorted[nextPos]?.closeTime ?? Infinity) < time) {
      const trendKline = sorted[nextPos];
      if (trendKline) trendWindows[sym]?.push(trendKline);
      nextPos++;
    }
    trendWindowPos[sym] = nextPos;
    const tw = trendWindows[sym] ?? [];
    if (tw.length < trendWarmup) return null; // insufficient data, allow through
    const ind = calculateIndicators(
      tw,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      { enabled: false, fast: 12, slow: 26, signal: 9 } // MTF only needs MA, no MACD
    );
    if (!ind) return null;
    return ind.maShort > ind.maLong;
  }

  // ── signalToNextOpen: pending signal queue (produced by previous candle, executed at next candle open) ──
  type PendingSignal = {
    type: "buy" | "sell" | "short" | "cover";
    reason: string[];
    regimeCfg: StrategyConfig;
  };
  const pendingSignals: Record<string, PendingSignal> = {};

  // ── Main loop: advance candle by candle ──
  for (const time of allTimes) {
    const currentPrices: Record<string, number> = {};

    // Step 0 (signalToNextOpen): execute pending signals from previous candle, fill at this candle's open price
    if (signalToNextOpen) {
      for (const [sym, pending] of Object.entries(pendingSignals)) {
        const kline = klineIndex[sym]?.[time];
        if (!kline) { delete pendingSignals[sym]; continue; }
        const execPrice = kline.open;
        if (pending.type === "buy") {
          doBuy(account, sym, execPrice, time, pending.regimeCfg, legacyOpts, pending.reason);
        } else if (pending.type === "sell") {
          doSell(account, sym, execPrice, time, "signal", legacyOpts);
        } else if (pending.type === "short") {
          doOpenShort(account, sym, execPrice, time, pending.regimeCfg, legacyOpts, pending.reason);
        } else if (pending.type === "cover") {
          doCoverShort(account, sym, execPrice, time, "signal", legacyOpts);
        }
        delete pendingSignals[sym];
      }
    }

    // Step 1: advance sliding window
    for (const sym of symbols) {
      const kline = klineIndex[sym]?.[time];
      if (!kline) continue;
      windows[sym]?.push(kline);
      // Only keep enough history for indicator calculation (window <= warmupBars * 2)
      if ((windows[sym]?.length ?? 0) > warmupBars * 2) {
        windows[sym]?.shift();
      }
      currentPrices[sym] = kline.close;
    }

    // No operations during warmup period
    if (Object.values(windows).every((w) => w.length < warmupBars)) continue;

    // Step 2a: funding rate settlement (Futures only, every 8h)
    if (fundingEnabled) {
      for (const sym of symbols) {
        const pos = account.positions[sym];
        if (!pos) continue;

        const lastTs = pos.lastFundingTs ?? pos.entryTime;
        const settlements = getFundingSettlements(lastTs, time);

        for (const settlementTs of settlements) {
          const currentKline = klineIndex[sym]?.[time];
          const positionValue = (pos.quantity) * (currentKline?.close ?? pos.entryPrice);

          // Determine this settlement's rate
          let rate: number;
          if (fundingHistory) {
            const symHistory = fundingHistory[sym] ?? fundingHistory[sym.replace("USDT", "") + "USDT"];
            rate = symHistory ? findFundingRate(symHistory, settlementTs) : (avgFundingRatePer8h ?? 0);
          } else {
            rate = avgFundingRatePer8h ?? 0;
          }

          // Funding rate calculation (relative to position notional value)
          // Long: rate > 0 -> pay funding (bearish); rate < 0 -> receive funding (bullish)
          // Short: rate > 0 -> receive funding (bullish); rate < 0 -> pay funding (bearish)
          const isShort = pos.side === "short";
          const cashFlow = isShort
            ? rate * positionValue           // short: positive rate receives, negative rate pays
            : -(rate * positionValue);       // long: positive rate pays, negative rate receives

          account.usdt += cashFlow;
          const paid = -cashFlow; // positive=paid out, negative=received
          pos.totalFundingPaid = (pos.totalFundingPaid ?? 0) + paid;
          account.fundingPaidBySymbol[sym] = (account.fundingPaidBySymbol[sym] ?? 0) + paid;
          pos.lastFundingTs = settlementTs;
        }
      }
    }

    // Step 2b: check existing positions for stop loss/take profit (priority over new signals)
    // P6.3: use checkIntracandleExit() for intra-candle simulation (uses high/low when intracandle=true)
    for (const sym of symbols) {
      const pos = account.positions[sym];
      if (!pos) continue;
      const kline = klineIndex[sym]?.[time];
      if (!kline) continue;

      const posSide: "long" | "short" = pos.side ?? "long";
      const holdMs = time - pos.entryTime;
      const currentPrice = kline.close;
      const profitRatio = posSide === "short"
        ? (pos.entryPrice - currentPrice) / pos.entryPrice
        : (currentPrice - pos.entryPrice) / pos.entryPrice;

      // ── Build StrategyContext (for hook usage) ──────────────────
      const needsCtx = strategy !== undefined || cfg.risk.break_even_profit !== undefined;
      let stratCtx: StrategyContext | undefined;
      if (needsCtx) {
        const win = windows[sym] ?? [];
        const ind = calculateIndicators(
          win,
          cfg.strategy.ma.short,
          cfg.strategy.ma.long,
          cfg.strategy.rsi.period,
          cfg.strategy.macd
        );
        if (ind) {
          stratCtx = { klines: win, cfg, indicators: ind, currentPosSide: posSide };
        }
      }

      // ── Helper: execute exit and call onTradeClosed ─────────────────
      const executeExit = (exitPrice: number, exitReason: BacktestTrade["exitReason"]): void => {
        if (posSide === "short") {
          doCoverShort(account, sym, exitPrice, time, exitReason, legacyOpts);
        } else {
          doSell(account, sym, exitPrice, time, exitReason, legacyOpts);
        }
        // Hook: onTradeClosed
        if (strategy?.onTradeClosed !== undefined && stratCtx !== undefined) {
          const lastTrade = account.trades[account.trades.length - 1];
          if (lastTrade !== undefined) {
            const tradeResult: TradeResult = {
              symbol: sym,
              side: posSide,
              entryPrice: lastTrade.entryPrice,
              exitPrice: lastTrade.exitPrice,
              pnl: lastTrade.pnl,
              pnlPercent: lastTrade.pnlPercent,
              holdMs: lastTrade.exitTime - lastTrade.entryTime,
              exitReason,
            };
            strategy.onTradeClosed(tradeResult, stratCtx);
          }
        }
      };

      // ── Hook Priority 1: shouldExit ───────────────────────────
      if (strategy?.shouldExit !== undefined && stratCtx !== undefined) {
        const shouldExitResult = strategy.shouldExit(
          { symbol: sym, side: posSide, entryPrice: pos.entryPrice, currentPrice, holdMs },
          stratCtx
        );
        if (shouldExitResult?.exit) {
          // confirmExit check
          const maxDev = cfg.execution.max_exit_price_deviation ?? 0.15;
          const confirmResult = shouldConfirmExit(
            { symbol: sym, side: posSide, entryPrice: pos.entryPrice, currentPrice, profitRatio, holdMs },
            shouldExitResult.reason,
            maxDev,
            strategy,
            stratCtx
          );
          if (confirmResult.confirmed) {
            executeExit(currentPrice, "signal");
          }
          continue; // shouldExit takes priority, skip subsequent checks regardless of confirmation
        }
      }

      // ── Hook Priority 2: break_even + customStoploss -> update pos.stopLoss ──
      {
        const newStop = resolveNewStopLoss(
          posSide,
          pos.entryPrice,
          pos.stopLoss,
          currentPrice,
          profitRatio,
          holdMs,
          sym,
          cfg.risk,
          strategy,
          stratCtx
        );
        if (newStop !== null) {
          pos.stopLoss = newStop;
        }
      }

      // Trailing stop state update (always uses high/low, independent of intracandle)
      const trailingTriggered = updateTrailingStop(pos, kline.high, kline.low, cfg);

      // ── Standard exit check (intra-candle simulation) ─────────────────────────
      const exitResult = checkIntracandleExit(
        pos, kline, cfg, time, trailingTriggered, intracandle
      );

      if (exitResult) {
        // ── Hook Priority 3: confirmExit ─────────────────────────
        const useConfirmExit = strategy !== undefined || cfg.execution.max_exit_price_deviation !== undefined;
        if (useConfirmExit) {
          const maxDev = cfg.execution.max_exit_price_deviation ?? 0.15;
          const confirmResult = shouldConfirmExit(
            { symbol: sym, side: posSide, entryPrice: pos.entryPrice, currentPrice, profitRatio, holdMs },
            exitResult.reason,
            maxDev,
            strategy,
            stratCtx
          );
          if (!confirmResult.confirmed) {
            continue; // exit rejected, continue holding
          }
        }
        executeExit(exitResult.exitPrice, exitResult.reason);
      }
    }

    // Step 3: calculate indicators & signals
    for (const sym of symbols) {
      const window = windows[sym] ?? [];
      if (window.length < warmupBars) continue;
      const kline = klineIndex[sym]?.[time];
      if (!kline) continue;

      // ── Unified signal engine (F3) ──────────────────────────────────
      // Build held position kline map (for correlation check)
      const heldKlinesBySymbol: Record<string, Kline[]> = {};
      if (cfg.risk.correlation_filter?.enabled) {
        for (const heldSym of Object.keys(account.positions)) {
          if (heldSym === sym) continue;
          const heldWin = windows[heldSym];
          if (heldWin) heldKlinesBySymbol[heldSym] = heldWin;
        }
      }

      const currentPos = account.positions[sym];
      const posSide = currentPos?.side;
      const externalCtx = {
        ...(posSide !== undefined ? { currentPosSide: posSide } : {}),
        ...(Object.keys(heldKlinesBySymbol).length > 0 ? { heldKlinesMap: heldKlinesBySymbol } : {}),
      };

      const engineResult = processSignal(sym, window, cfg, externalCtx);
      if (!engineResult.indicators) continue;

      const { signal, effectiveRisk, effectivePositionRatio, rejected } = engineResult;
      if (rejected) continue;
      if (signal.type === "none") continue;

      // effectiveCfg: merge regime parameter overrides + correlation position adjustment
      const effectiveRatio = effectivePositionRatio ?? effectiveRisk.position_ratio;
      const regimeCfg: typeof cfg = {
        ...cfg,
        risk: { ...effectiveRisk, position_ratio: effectiveRatio },
      };

      if (signal.type === "buy") {
        // MTF filter: long signal requires higher timeframe MA to also be bullish
        const trendBull = getTrendBull(sym, time);
        if (trendBull === false) continue;
        if (signalToNextOpen) {
          // Delay to next candle open price (eliminates look-ahead bias)
          pendingSignals[sym] = { type: "buy", reason: signal.reason, regimeCfg };
        } else {
          doBuy(account, sym, kline.close, time, regimeCfg, legacyOpts, signal.reason);
        }
      } else if (signal.type === "sell") {
        // Close long (detectSignal ensures sell is only returned when holding long)
        if (signalToNextOpen) {
          pendingSignals[sym] = { type: "sell", reason: signal.reason, regimeCfg };
        } else {
          doSell(account, sym, kline.close, time, "signal", legacyOpts);
        }
      } else if (signal.type === "short") {
        // MTF filter: short signal requires higher timeframe MA to also be bearish (reverse filter)
        const trendBull = getTrendBull(sym, time);
        if (trendBull === true) continue; // macro trend is bullish, don't open short
        if (signalToNextOpen) {
          pendingSignals[sym] = { type: "short", reason: signal.reason, regimeCfg };
        } else {
          doOpenShort(account, sym, kline.close, time, regimeCfg, legacyOpts, signal.reason);
        }
      } else {
        // cover — close short (detectSignal ensures cover is only returned when holding short)
        if (signalToNextOpen) {
          pendingSignals[sym] = { type: "cover", reason: signal.reason, regimeCfg };
        } else {
          doCoverShort(account, sym, kline.close, time, "signal", legacyOpts);
        }
      }
    }

    // Step 4: record equity curve
    account.equityCurve.push({
      time,
      equity: calcEquity(account, currentPrices),
    });
  }

  // ── Force close all positions (at backtest end, at last close price) ──
  const lastTime = allTimes[allTimes.length - 1] ?? 0;
  for (const sym of Object.keys(account.positions)) {
    const pos = account.positions[sym];
    const lastKline = lastTime > 0 ? klineIndex[sym]?.[lastTime] : undefined;
    if (!lastKline || !pos) continue;
    const posSideForClose: "long" | "short" = pos.side ?? "long";
    if (pos.side === "short") {
      doCoverShort(account, sym, lastKline.close, lastTime, "end_of_data", legacyOpts);
    } else {
      doSell(account, sym, lastKline.close, lastTime, "end_of_data", legacyOpts);
    }
    // Hook: onTradeClosed (also triggered on forced close)
    if (strategy?.onTradeClosed !== undefined) {
      const win = windows[sym] ?? [];
      const ind = calculateIndicators(
        win, cfg.strategy.ma.short, cfg.strategy.ma.long, cfg.strategy.rsi.period, cfg.strategy.macd
      );
      if (ind) {
        const closeCtx: StrategyContext = { klines: win, cfg, indicators: ind, currentPosSide: posSideForClose };
        const lastTrade = account.trades[account.trades.length - 1];
        if (lastTrade !== undefined) {
          const tradeResult: TradeResult = {
            symbol: sym,
            side: posSideForClose,
            entryPrice: lastTrade.entryPrice,
            exitPrice: lastTrade.exitPrice,
            pnl: lastTrade.pnl,
            pnlPercent: lastTrade.pnlPercent,
            holdMs: lastTrade.exitTime - lastTrade.entryTime,
            exitReason: "end_of_data",
          };
          strategy.onTradeClosed(tradeResult, closeCtx);
        }
      }
    }
  }

  // ── BTC Buy & Hold Benchmark ──
  // Calculate hold return using first/last close prices of BTC during backtest period
  const btcKlines = klinesBySymbol["BTCUSDT"] ?? (symbols[0] !== undefined ? klinesBySymbol[symbols[0]] : undefined);
  const btcBenchmarkReturn = (() => {
    if (!btcKlines || btcKlines.length < 2) return undefined;
    const firstClose = btcKlines[0]?.close;
    const lastClose = btcKlines[btcKlines.length - 1]?.close;
    if (!firstClose || !lastClose) return undefined;
    return ((lastClose - firstClose) / firstClose) * 100;
  })();

  // ── Calculate performance metrics ──
  const metrics = calculateMetrics(account.trades, initialUsdt, account.equityCurve, btcBenchmarkReturn);

  // ── Per-symbol statistics ──
  // sell=close long, cover=close short (both are realized trades)
  const closedTrades = account.trades.filter((t) => t.side === "sell" || t.side === "cover");
  const perSymbol: BacktestResult["perSymbol"] = {};
  for (const sym of symbols) {
    const symTrades = closedTrades.filter((t) => t.symbol === sym);
    const symWins = symTrades.filter((t) => t.pnl > 0);
    const symLosses = symTrades.filter((t) => t.pnl <= 0);
    perSymbol[sym] = {
      trades: symTrades.length,
      wins: symWins.length,
      losses: symLosses.length,
      pnl: symTrades.reduce((s, t) => s + t.pnl, 0),
      winRate: symTrades.length > 0 ? symWins.length / symTrades.length : 0,
      fundingPaid: account.fundingPaidBySymbol[sym] ?? 0,
    };
  }

  // ── Calculate total funding rate cost ──
  const totalFundingPaid = Object.values(perSymbol).reduce((s, v) => s + v.fundingPaid, 0);

  // ── Time range info ──
  const firstTime = allTimes[0] ?? 0;
  const lastTimeMs = allTimes[allTimes.length - 1] ?? 0;
  const startDate = new Date(firstTime).toISOString().slice(0, 10);
  const endDate = new Date(lastTimeMs).toISOString().slice(0, 10);
  const days = Math.round((lastTimeMs - firstTime) / 86_400_000);

  return {
    metrics,
    trades: account.trades,
    totalFundingPaid,
    perSymbol,
    config: {
      strategy: cfg.strategy.name,
      symbols,
      timeframe: cfg.timeframe,
      startDate,
      endDate,
      days,
      initialUsdt,
      fundingEnabled,
      spreadBps,
      signalToNextOpen,
    },
  };
}

/**
 * 回测引擎主循环
 *
 * 设计原则：
 * 1. 多币种共享账户（与实盘/paper 行为一致）
 * 2. 滑动窗口指标计算（与实时 monitor 一致）
 * 3. K 线内高低价止损/止盈（比只用收盘价更真实）
 * 4. 止损优先于止盈（悲观模型，防止过度乐观估计）
 */

import { calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import type { Kline, StrategyConfig } from "../types.js";
import {
  calculateMetrics,
  type BacktestTrade,
  type BacktestMetrics,
  type EquityPoint,
} from "./metrics.js";
import type { FundingRateRecord } from "./fetcher.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

/** 交易执行函数仅需要手续费 + 滑点两个参数 */
interface ExecOpts { feeRate: number; slippagePercent: number; }

interface BacktestPosition {
  symbol: string;
  side?: "long" | "short"; // undefined 视为 long（向后兼容）
  entryTime: number;
  entryPrice: number; // 含滑点
  quantity: number;
  cost: number;      // 多头：买入花费的 USDT；空头：锁定的保证金（含手续费）
  marginUsdt?: number; // 空头专用：净保证金（扣除手续费后，用于归还）
  stopLoss: number;
  takeProfit: number;
  trailingStop?: {
    active: boolean;
    highestPrice: number; // 多头：持仓最高价
    lowestPrice?: number; // 空头：持仓最低价
    stopPrice: number;
  };
  // 资金费率追踪（Futures 专用）
  lastFundingTs?: number;    // 上次资金费率结算时间（毫秒）
  totalFundingPaid?: number; // 累计已付资金费（正=付出，负=收入）
}

interface BacktestAccount {
  usdt: number;
  positions: Record<string, BacktestPosition>;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  // 每日亏损追踪
  dailyLoss: { date: string; loss: number };
  // 各币种累计资金费率净支出（正=付出成本，负=收入）
  fundingPaidBySymbol: Record<string, number>;
}

export interface BacktestOptions {
  initialUsdt?: number;       // 默认 1000
  feeRate?: number;           // 默认 0.001 (0.1%)
  slippagePercent?: number;   // 默认 0.05%
  /**
   * Futures 资金费率（每 8h 一次结算）
   * 传入后对 long/short 仓位均自动扣除/计入
   * ── 两种方式二选一 ──
   */
  avgFundingRatePer8h?: number;                             // 全币种平均值（如 -0.0001）
  fundingHistory?: Record<string, FundingRateRecord[]>;    // 各币种历史费率（精确）
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  totalFundingPaid: number;  // 正 = 净支出（对账户不利），负 = 净收入
  perSymbol: Record<
    string,
    {
      trades: number;
      wins: number;
      losses: number;
      pnl: number;
      winRate: number;
      fundingPaid: number; // 该币种的资金费率净支出
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
  };
}

// ─────────────────────────────────────────────────────
// 辅助函数
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
  opts: ExecOpts
): void {
  // 已持仓则跳过
  if (account.positions[symbol]) return;

  // 最大持仓数检查
  if (Object.keys(account.positions).length >= cfg.risk.max_positions) return;

  // 每日亏损限额
  const today = new Date(time).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }

  const equity = calcEquity(account, { [symbol]: price });
  const symbolValue = 0; // 没有持仓
  if (symbolValue / equity >= cfg.risk.max_position_per_symbol) return;
  if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) return;

  const usdtToSpend = equity * cfg.risk.position_ratio;
  if (usdtToSpend < cfg.execution.min_order_usdt) return;
  if (usdtToSpend > account.usdt) return;

  // 买入时价格上滑（略高于报价），仅通过提高 execPrice 模拟滑点
  // 不额外扣除 slippageUsdt，避免与 execPrice 双重计算
  const execPrice = price * (1 + opts.slippagePercent / 100);
  const fee = usdtToSpend * opts.feeRate;
  const netUsdt = usdtToSpend - fee; // execPrice 已含滑点成本
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
  };

  if (cfg.risk.trailing_stop.enabled) {
    pos.trailingStop = {
      active: false,
      highestPrice: execPrice,
      stopPrice: 0,
    };
  }

  account.positions[symbol] = pos;

  // 只记录买入事件（用于调试），交易 PnL 在卖出时计算
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
  });
}

function doOpenShort(
  account: BacktestAccount,
  symbol: string,
  price: number,
  time: number,
  cfg: StrategyConfig,
  opts: ExecOpts
): void {
  if (account.positions[symbol]) return;
  if (Object.keys(account.positions).length >= cfg.risk.max_positions) return;

  const today = new Date(time).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) account.dailyLoss = { date: today, loss: 0 };

  const equity = calcEquity(account, { [symbol]: price });
  if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) return;

  const marginToLock = equity * cfg.risk.position_ratio;
  if (marginToLock < cfg.execution.min_order_usdt || marginToLock > account.usdt) return;

  // 开空时成交价略低（对做空方不利）
  const execPrice = price * (1 - opts.slippagePercent / 100);
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
    cost: marginToLock,     // 锁定的总保证金（含手续费）
    marginUsdt: actualMargin, // 净保证金（用于归还）
    stopLoss: execPrice * (1 + cfg.risk.stop_loss_percent / 100),   // 涨破 = 亏损
    takeProfit: execPrice * (1 - cfg.risk.take_profit_percent / 100), // 跌破 = 盈利
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

  // 平空时买入：成交价略高（对买入方不利）
  const execPrice = exitPrice * (1 + opts.slippagePercent / 100);
  const grossUsdt = pos.quantity * execPrice; // 买回所需花费
  const fee = grossUsdt * opts.feeRate;
  const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
  const pnl = (pos.entryPrice - execPrice) * pos.quantity - fee;
  const pnlPercent = pnl / margin;
  const proceeds = Math.max(0, margin + pnl); // 归还：保证金 ± 盈亏（最多归零）

  const today = new Date(exitTime).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) account.dailyLoss = { date: today, loss: 0 };
  if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

  account.usdt += proceeds;
  delete account.positions[symbol];

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

  // 卖出时价格下滑（略低于报价）
  const execPrice = exitPrice * (1 - opts.slippagePercent / 100);
  const grossUsdt = pos.quantity * execPrice;
  const fee = grossUsdt * opts.feeRate;
  const proceeds = grossUsdt - fee;
  const pnl = proceeds - pos.cost;
  const pnlPercent = pnl / pos.cost;

  // 更新每日亏损
  const today = new Date(exitTime).toISOString().slice(0, 10);
  if (account.dailyLoss.date !== today) {
    account.dailyLoss = { date: today, loss: 0 };
  }
  if (pnl < 0) account.dailyLoss.loss += Math.abs(pnl);

  account.usdt += proceeds;
  delete account.positions[symbol];

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

  if (pos.side === "short") {
    // 空头：追踪最低价，从低点反弹时平仓
    ts.lowestPrice ??= pos.entryPrice;
    if (low < ts.lowestPrice) ts.lowestPrice = low;
    const lowestPrice = ts.lowestPrice;
    const gainPct = ((pos.entryPrice - lowestPrice) / pos.entryPrice) * 100;
    if (!ts.active && gainPct >= activation_percent) ts.active = true;
    if (ts.active) {
      ts.stopPrice = lowestPrice * (1 + callback_percent / 100);
      return high >= ts.stopPrice; // 高价触碰止损价，平空
    }
  } else {
    // 多头：追踪最高价，从高点回撤时平仓
    if (high > ts.highestPrice) ts.highestPrice = high;
    const gainPct = ((ts.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (!ts.active && gainPct >= activation_percent) ts.active = true;
    if (ts.active) {
      ts.stopPrice = ts.highestPrice * (1 - callback_percent / 100);
      return low <= ts.stopPrice; // 低价触碰止损价，平多
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────
// 主回测函数
// ─────────────────────────────────────────────────────

/**
 * 多币种共享账户回测
 *
 * @param klinesBySymbol       每个 symbol 的完整历史 K 线（主时间框架，已按时间排序）
 * @param cfg                  策略配置（strategy.yaml + 策略文件合并后）
 * @param opts                 回测选项（初始资金、手续费、滑点）
 * @param trendKlinesBySymbol  可选：高级时间框架 K 线（MTF 趋势过滤，如 4h）
 *                             提供后，买入信号只在趋势 MA 多头时执行
 */
// ─────────────────────────────────────────────────────
// 资金费率工具
// ─────────────────────────────────────────────────────

/** Binance 资金费率标准结算时间（每 8h，UTC）*/
const FUNDING_INTERVAL_MS = 8 * 3600 * 1000;

/** 找到 [lastFundingTs, currentTs] 区间内所有结算时间点 */
function getFundingSettlements(lastTs: number, currentTs: number): number[] {
  const result: number[] = [];
  // 结算时间 = 当天 00:00 / 08:00 / 16:00 UTC
  // 找到 lastTs 之后的第一个结算时间
  const base = Math.ceil(lastTs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
  for (let t = base; t <= currentTs; t += FUNDING_INTERVAL_MS) {
    result.push(t);
  }
  return result;
}

/** 查找给定时间最近的资金费率（按 ts 排序的记录数组） */
function findFundingRate(
  history: FundingRateRecord[],
  settlementTs: number
): number {
  // 找到 <= settlementTs 的最近一条
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
          avgFundingRatePer8h, fundingHistory } = opts;
  const fundingEnabled = avgFundingRatePer8h !== undefined || fundingHistory !== undefined;
  // ExecOpts：仅供交易函数使用（手续费 + 滑点）
  const legacyOpts: ExecOpts = { feeRate, slippagePercent };

  const symbols = Object.keys(klinesBySymbol);
  if (symbols.length === 0) {
    throw new Error("klinesBySymbol 不能为空");
  }

  // ── 合并所有 K 线时间戳（取交集，确保所有 symbol 都有数据）──
  const timeSets = symbols.map(
    // Object.keys 返回的 key 一定在 map 中，! 断言安全
    (s) => new Set(klinesBySymbol[s]!.map((k) => k.openTime))
  );
  // timeSets[0] 一定存在（symbols 非空已检查）
  const allTimes = Array.from(timeSets[0]!)
    .filter((t) => timeSets.every((set) => set.has(t)))
    .sort((a, b) => a - b);

  // ── 构建时间→K线索引 ──
  const klineIndex: Record<string, Record<number, Kline>> = {};
  for (const sym of symbols) {
    klineIndex[sym] = {};
    for (const k of klinesBySymbol[sym]!) {
      klineIndex[sym][k.openTime] = k;
    }
  }

  // ── 计算预热期长度 ──
  const macdCfg = cfg.strategy.macd;
  const macdMinBars = macdCfg.enabled ? macdCfg.slow + macdCfg.signal + 1 : 0;
  const warmupBars = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

  // ── 初始化账户 ──
  const account: BacktestAccount = {
    usdt: initialUsdt,
    positions: {},
    trades: [],
    equityCurve: [],
    dailyLoss: { date: todayStr(), loss: 0 },
    fundingPaidBySymbol: {},
  };

  // 滑动窗口（每个 symbol 独立）
  const windows: Record<string, Kline[]> = {};
  for (const sym of symbols) windows[sym] = [];

  // ── MTF 趋势过滤设置 ──────────────────────────────
  const useMtf = trendKlinesBySymbol !== undefined;
  const trendWarmup = cfg.strategy.ma.long + 10;
  // 趋势 K 线按 closeTime 排序（用于按时间顺序追加到趋势窗口）
  const trendSorted: Record<string, Kline[]> = {};
  const trendWindowPos: Record<string, number> = {}; // 已处理到第几根
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
  /** 获取 sym 在时刻 time 时的趋势 MA 状态（多头=true，空头=false，无数据=null） */
  function getTrendBull(sym: string, time: number): boolean | null {
    if (!useMtf) return null;
    const sorted = trendSorted[sym] ?? [];
    const pos = trendWindowPos[sym] ?? 0;
    let nextPos = pos;
    // 将 closeTime < time 的趋势 K 线推入窗口（已关闭的才算，避免前瞻偏差）
    while (nextPos < sorted.length && sorted[nextPos]!.closeTime < time) {
      trendWindows[sym]!.push(sorted[nextPos]!);
      nextPos++;
    }
    trendWindowPos[sym] = nextPos;
    const tw = trendWindows[sym]!;
    if (tw.length < trendWarmup) return null; // 数据不足，放行
    const ind = calculateIndicators(
      tw,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      { enabled: false, fast: 12, slow: 26, signal: 9 } // MTF 只需 MA，不算 MACD
    );
    if (!ind) return null;
    return ind.maShort > ind.maLong;
  }

  // ── 主循环：逐根 K 线前进 ──
  for (const time of allTimes) {
    const currentPrices: Record<string, number> = {};

    // Step 1：推进滑动窗口
    for (const sym of symbols) {
      // sym 由 symbols = Object.keys(klinesBySymbol) 产生，klineIndex[sym] 一定存在
      const kline = klineIndex[sym]![time];
      if (!kline) continue;
      windows[sym]!.push(kline);
      // 只保留足够指标计算的历史（窗口不超过 warmupBars * 2）
      if (windows[sym]!.length > warmupBars * 2) {
        windows[sym]!.shift();
      }
      currentPrices[sym] = kline.close;
    }

    // 预热期内不操作
    if (Object.values(windows).every((w) => w.length < warmupBars)) continue;

    // Step 2a：资金费率结算（Futures 专用，每 8h）
    if (fundingEnabled) {
      for (const sym of symbols) {
        const pos = account.positions[sym];
        if (!pos) continue;

        const lastTs = pos.lastFundingTs ?? pos.entryTime;
        const settlements = getFundingSettlements(lastTs, time);

        for (const settlementTs of settlements) {
          const currentKline = klineIndex[sym]?.[time];
          const positionValue = (pos.quantity) * (currentKline?.close ?? pos.entryPrice);

          // 确定本次费率
          let rate: number;
          if (fundingHistory) {
            const symHistory = fundingHistory[sym] ?? fundingHistory[sym.replace("USDT", "") + "USDT"];
            rate = symHistory ? findFundingRate(symHistory, settlementTs) : (avgFundingRatePer8h ?? 0);
          } else {
            rate = avgFundingRatePer8h ?? 0;
          }

          // 资金费率计算（相对头寸名义价值）
          // 多头：rate > 0 → 付资金费（利空）；rate < 0 → 收资金费（利多）
          // 空头：rate > 0 → 收资金费（利多）；rate < 0 → 付资金费（利空）
          const isShort = pos.side === "short";
          const cashFlow = isShort
            ? rate * positionValue           // 空头：正费率收钱，负费率付钱
            : -(rate * positionValue);       // 多头：正费率付钱，负费率收钱

          account.usdt += cashFlow;
          const paid = -cashFlow; // 正=付出，负=收入
          pos.totalFundingPaid = (pos.totalFundingPaid ?? 0) + paid;
          account.fundingPaidBySymbol[sym] = (account.fundingPaidBySymbol[sym] ?? 0) + paid;
          pos.lastFundingTs = settlementTs;
        }
      }
    }

    // Step 2b：检查已有持仓的止损/止盈（优先于新信号）
    for (const sym of symbols) {
      const pos = account.positions[sym];
      if (!pos) continue;
      const kline = klineIndex[sym]![time];
      if (!kline) continue;

      const trailingTriggered = updateTrailingStop(pos, kline.high, kline.low, cfg);

      if (pos.side === "short") {
        // ── 空头出场（止损=涨破，止盈=跌破）──
        if (kline.high >= pos.stopLoss) {
          doCoverShort(account, sym, pos.stopLoss, time, "stop_loss", legacyOpts);
        } else if (kline.low <= pos.takeProfit) {
          doCoverShort(account, sym, pos.takeProfit, time, "take_profit", legacyOpts);
        } else if (trailingTriggered && pos.trailingStop?.stopPrice) {
          doCoverShort(account, sym, pos.trailingStop.stopPrice, time, "trailing_stop", legacyOpts);
        }
      } else {
        // ── 多头出场（止损=跌破，止盈=涨破）──
        if (kline.low <= pos.stopLoss) {
          doSell(account, sym, pos.stopLoss, time, "stop_loss", legacyOpts);
        } else if (kline.high >= pos.takeProfit) {
          doSell(account, sym, pos.takeProfit, time, "take_profit", legacyOpts);
        } else if (trailingTriggered && pos.trailingStop?.stopPrice) {
          doSell(account, sym, pos.trailingStop.stopPrice, time, "trailing_stop", legacyOpts);
        }
      }
    }

    // Step 3：计算指标 & 信号
    for (const sym of symbols) {
      const window = windows[sym]!; // sym ∈ symbols，windows[sym] 必存在
      if (window.length < warmupBars) continue;
      const kline = klineIndex[sym]![time];
      if (!kline) continue;

      const indicators = calculateIndicators(
        window,
        cfg.strategy.ma.short,
        cfg.strategy.ma.long,
        cfg.strategy.rsi.period,
        cfg.strategy.macd
      );
      if (!indicators) continue;

      const currentPos = account.positions[sym];
      // 传入持仓方向，让 detectSignal 使用正确的优先级
      // long 持仓 → 只检查 sell；short 持仓 → 只检查 cover；无持仓 → 检查 buy/short
      const posSide = currentPos?.side;
      const signal = detectSignal(sym, indicators, cfg, posSide);

      if (signal.type === "buy") {
        // MTF 过滤：多头信号需高级别 MA 也是多头
        const trendBull = getTrendBull(sym, time);
        if (trendBull === false) continue;
        doBuy(account, sym, kline.close, time, cfg, legacyOpts);
      } else if (signal.type === "sell") {
        // 平多（detectSignal 已确保只在持多时返回 sell）
        doSell(account, sym, kline.close, time, "signal", legacyOpts);
      } else if (signal.type === "short") {
        // MTF 过滤：空头信号需高级别 MA 也是空头（反向过滤）
        const trendBull = getTrendBull(sym, time);
        if (trendBull === true) continue; // 大趋势多头，不开空
        doOpenShort(account, sym, kline.close, time, cfg, legacyOpts);
      } else if (signal.type === "cover") {
        // 平空（detectSignal 已确保只在持空时返回 cover）
        doCoverShort(account, sym, kline.close, time, "signal", legacyOpts);
      }
    }

    // Step 4：记录权益曲线
    account.equityCurve.push({
      time,
      equity: calcEquity(account, currentPrices),
    });
  }

  // ── 强制平仓（回测结束时，按最后收盘价）──
  const lastTime = allTimes[allTimes.length - 1] ?? 0;
  for (const sym of Object.keys(account.positions)) {
    const pos = account.positions[sym];
    const lastKline = lastTime > 0 ? klineIndex[sym]?.[lastTime] : undefined;
    if (!lastKline || !pos) continue;
    if (pos.side === "short") {
      doCoverShort(account, sym, lastKline.close, lastTime, "end_of_data", legacyOpts);
    } else {
      doSell(account, sym, lastKline.close, lastTime, "end_of_data", legacyOpts);
    }
  }

  // ── 计算绩效指标 ──
  const metrics = calculateMetrics(account.trades, initialUsdt, account.equityCurve);

  // ── 各币种统计 ──
  // sell=平多，cover=平空（均为已实现交易）
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

  // ── 统计总资金费率成本 ──
  const totalFundingPaid = Object.values(perSymbol).reduce((s, v) => s + v.fundingPaid, 0);

  // ── 时间范围信息 ──
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
    },
  };
}

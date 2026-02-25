/**
 * 回测绩效指标计算
 * 包含：总收益、夏普比率、索提诺比率、最大回撤、盈亏比、利润因子等
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface BacktestTrade {
  symbol: string;
  /** buy=开多, sell=平多, short=开空, cover=平空 */
  side: "buy" | "sell" | "short" | "cover";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  cost: number; // 买入时花费的 USDT（含手续费）
  proceeds: number; // 卖出时获得的 USDT（扣手续费）
  pnl: number; // 盈亏 USDT
  pnlPercent: number; // 盈亏百分比（-0.05 表示 -5%）
  exitReason: "signal" | "stop_loss" | "take_profit" | "trailing_stop" | "end_of_data";
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestMetrics {
  // ── 基础 ──
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1

  // ── 收益 ──
  totalReturn: number; // USDT 绝对收益
  totalReturnPercent: number; // 百分比

  // ── 风险 ──
  maxDrawdown: number; // 最大回撤 %（正数）
  maxDrawdownUsdt: number; // 最大回撤 USDT
  sharpeRatio: number; // 年化夏普（基于权益曲线逐点收益）
  sortinoRatio: number; // 年化索提诺

  // ── 交易质量 ──
  profitFactor: number; // 总盈 / 总亏
  avgWinPercent: number; // 平均盈利 %
  avgLossPercent: number; // 平均亏损 %（正数）
  winLossRatio: number; // 盈亏比 = avgWin / avgLoss
  avgHoldingHours: number; // 平均持仓时长

  // ── 出场原因 ──
  stopLossCount: number;
  takeProfitCount: number;
  trailingStopCount: number;
  signalExitCount: number;
  endOfDataCount: number;

  // ── 极值 ──
  bestTradePct: number; // 最佳单笔 %
  worstTradePct: number; // 最差单笔 %

  // ── 风险调整指标 ──
  calmarRatio: number; // 年化收益 / 最大回撤（比夏普更适合加密高波动市场）

  // ── Benchmark 对比（BTC Buy & Hold）──
  benchmarkReturn?: number; // 同期 BTC 持有收益率 %（可选，需传入 BTC 数据）
  alpha?: number; // 策略 alpha = 策略收益 - BTC 收益

  // ── 权益曲线 ──
  equityCurve: EquityPoint[];
}

// ─────────────────────────────────────────────────────
// 计算函数
// ─────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (arr.length - 1));
}

/**
 * 根据已完成交易和权益曲线计算绩效指标
 * @param btcBenchmarkReturn 同期 BTC Buy & Hold 收益率 %（可选，用于计算 alpha）
 */
export function calculateMetrics(
  trades: BacktestTrade[],
  initialUsdt: number,
  equityCurve: EquityPoint[],
  btcBenchmarkReturn?: number
): BacktestMetrics {
  // sell = 平多；cover = 平空（两者都是已实现交易，用于计算绩效）
  const sellTrades = trades.filter((t) => t.side === "sell" || t.side === "cover");
  const wins = sellTrades.filter((t) => t.pnl > 0);
  const losses = sellTrades.filter((t) => t.pnl <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // ── 最大回撤 ──
  let peak = initialUsdt;
  let maxDrawdown = 0;
  let maxDrawdownUsdt = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownUsdt = peak - pt.equity;
    }
  }

  // ── 权益曲线逐点收益率（用于 Sharpe / Sortino）──
  const periodReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prevPoint = equityCurve[i - 1];
    const currPoint = equityCurve[i];
    const prev = prevPoint?.equity ?? 0;
    const curr = currPoint?.equity ?? 0;
    if (prev > 0) periodReturns.push((curr - prev) / prev);
  }

  // Sharpe = (avgReturn / stddev) * sqrt(N)，N 为时间周期数（年化）
  const avgPeriodReturn = mean(periodReturns);
  const stdPeriodReturn = stddev(periodReturns, avgPeriodReturn);
  const sharpeRatio =
    stdPeriodReturn > 0 ? (avgPeriodReturn / stdPeriodReturn) * Math.sqrt(periodReturns.length) : 0;

  // Sortino = (avgReturn / downsideStddev) * sqrt(N)
  const downReturns = periodReturns.filter((r) => r < 0);
  const downDev =
    downReturns.length > 0
      ? Math.sqrt(downReturns.reduce((s, r) => s + r * r, 0) / downReturns.length)
      : 0;
  const sortinoRatio =
    downDev > 0 ? (avgPeriodReturn / downDev) * Math.sqrt(periodReturns.length) : 0;

  // ── 均值统计 ──
  const avgWinPct =
    wins.length > 0 ? (wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length) * 100 : 0;
  const avgLossPct =
    losses.length > 0
      ? Math.abs((losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) * 100)
      : 0;

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialUsdt;
  const totalReturnPct = ((finalEquity - initialUsdt) / initialUsdt) * 100;

  // ── Calmar Ratio = 年化收益 / 最大回撤 ──
  // 年化收益 = totalReturn% × (365 / numDays)
  const firstTime = equityCurve[0]?.time ?? 0;
  const lastTime = equityCurve[equityCurve.length - 1]?.time ?? firstTime;
  const numDays = firstTime > 0 && lastTime > firstTime
    ? (lastTime - firstTime) / 86_400_000
    : 365;
  const annualizedReturn = totalReturnPct * (365 / numDays);
  const calmarRatio = maxDrawdown > 0 ? annualizedReturn / (maxDrawdown * 100) : 0;

  // ── Benchmark & Alpha ──
  const alpha =
    btcBenchmarkReturn !== undefined ? totalReturnPct - btcBenchmarkReturn : undefined;

  return {
    totalTrades: sellTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sellTrades.length > 0 ? wins.length / sellTrades.length : 0,

    totalReturn: finalEquity - initialUsdt,
    totalReturnPercent: totalReturnPct,

    maxDrawdown: maxDrawdown * 100,
    maxDrawdownUsdt,
    sharpeRatio,
    sortinoRatio,

    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWinPercent: avgWinPct,
    avgLossPercent: avgLossPct,
    winLossRatio: avgLossPct > 0 ? avgWinPct / avgLossPct : 0,
    avgHoldingHours:
      sellTrades.length > 0
        ? sellTrades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 3_600_000, 0) /
          sellTrades.length
        : 0,

    stopLossCount: sellTrades.filter((t) => t.exitReason === "stop_loss").length,
    takeProfitCount: sellTrades.filter((t) => t.exitReason === "take_profit").length,
    trailingStopCount: sellTrades.filter((t) => t.exitReason === "trailing_stop").length,
    signalExitCount: sellTrades.filter((t) => t.exitReason === "signal").length,
    endOfDataCount: sellTrades.filter((t) => t.exitReason === "end_of_data").length,

    bestTradePct:
      sellTrades.length > 0 ? Math.max(...sellTrades.map((t) => t.pnlPercent * 100)) : 0,
    worstTradePct:
      sellTrades.length > 0 ? Math.min(...sellTrades.map((t) => t.pnlPercent * 100)) : 0,

    calmarRatio,
    ...(btcBenchmarkReturn !== undefined ? { benchmarkReturn: btcBenchmarkReturn } : {}),
    ...(alpha !== undefined ? { alpha } : {}),

    equityCurve,
  };
}

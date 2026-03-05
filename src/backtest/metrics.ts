/**
 * Backtest Performance Metrics Calculation
 * Includes: total return, Sharpe ratio, Sortino ratio, max drawdown, risk-reward ratio, profit factor, etc.
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface BacktestTrade {
  symbol: string;
  /** buy=open long, sell=close long, short=open short, cover=close short */
  side: "buy" | "sell" | "short" | "cover";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  cost: number; // USDT spent on buy (including fees)
  proceeds: number; // USDT received on sell (after fees)
  pnl: number; // PnL in USDT
  pnlPercent: number; // PnL percentage (-0.05 means -5%)
  exitReason: "signal" | "stop_loss" | "take_profit" | "trailing_stop" | "end_of_data" | "time_stop";
  signalConditions?: string[];
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestMetrics {
  // ── Basics ──
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1

  // ── Returns ──
  totalReturn: number; // USDT absolute return
  totalReturnPercent: number; // percentage

  // ── Risk ──
  maxDrawdown: number; // max drawdown % (positive number)
  maxDrawdownUsdt: number; // max drawdown in USDT
  sharpeRatio: number; // annualized Sharpe (based on equity curve point-to-point returns)
  sortinoRatio: number; // annualized Sortino

  // ── Trade Quality ──
  profitFactor: number; // gross profit / gross loss
  avgWinPercent: number; // average win %
  avgLossPercent: number; // average loss % (positive number)
  winLossRatio: number; // risk-reward ratio = avgWin / avgLoss
  avgHoldingHours: number; // average holding duration

  // ── Exit Reasons ──
  stopLossCount: number;
  takeProfitCount: number;
  trailingStopCount: number;
  signalExitCount: number;
  endOfDataCount: number;

  // ── Extremes ──
  bestTradePct: number; // best single trade %
  worstTradePct: number; // worst single trade %

  // ── Risk-Adjusted Metrics ──
  calmarRatio: number; // annualized return / max drawdown (more suitable for high-volatility crypto markets than Sharpe)

  // ── Benchmark Comparison (BTC Buy & Hold) ──
  benchmarkReturn?: number; // same-period BTC hold return % (optional, requires BTC data)
  alpha?: number; // strategy alpha = strategy return - BTC return

  // ── Equity Curve ──
  equityCurve: EquityPoint[];
}

// ─────────────────────────────────────────────────────
// Calculation Functions
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
 * Calculate performance metrics from completed trades and equity curve
 * @param btcBenchmarkReturn same-period BTC Buy & Hold return % (optional, used for alpha calculation)
 */
export function calculateMetrics(
  trades: BacktestTrade[],
  initialUsdt: number,
  equityCurve: EquityPoint[],
  btcBenchmarkReturn?: number
): BacktestMetrics {
  // sell = close long; cover = close short (both are realized trades, used for performance calculation)
  const sellTrades = trades.filter((t) => t.side === "sell" || t.side === "cover");
  const wins = sellTrades.filter((t) => t.pnl > 0);
  const losses = sellTrades.filter((t) => t.pnl <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // ── Max Drawdown ──
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

  // ── Equity curve point-to-point returns (for Sharpe / Sortino) ──
  const periodReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prevPoint = equityCurve[i - 1];
    const currPoint = equityCurve[i];
    const prev = prevPoint?.equity ?? 0;
    const curr = currPoint?.equity ?? 0;
    if (prev > 0) periodReturns.push((curr - prev) / prev);
  }

  // Sharpe = (avgReturn / stddev) * sqrt(N), N is the number of time periods (annualized)
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

  // ── Average statistics ──
  const avgWinPct =
    wins.length > 0 ? (wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length) * 100 : 0;
  const avgLossPct =
    losses.length > 0
      ? Math.abs((losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) * 100)
      : 0;

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialUsdt;
  const totalReturnPct = ((finalEquity - initialUsdt) / initialUsdt) * 100;

  // ── Calmar Ratio = annualized return / max drawdown ──
  // Annualized return = totalReturn% * (365 / numDays)
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

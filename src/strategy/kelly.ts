/**
 * Kelly Criterion Dynamic Position Sizing
 *
 * ## Principle
 * Kelly% = W - (1 - W) / R
 *   W = Recent win rate (winning trades / total closed trades)
 *   R = Risk-reward ratio (avg win % / avg loss %)
 *
 * Half Kelly (x 0.5) reduces variance, suitable for live trading.
 *
 * ## Usage (strategy.yaml)
 * ```yaml
 * risk:
 *   position_sizing: "kelly"  # "fixed" (default) | "kelly"
 *   kelly_lookback: 30        # Reference last N closed trades (default 30)
 *   kelly_half: true          # Whether to use half Kelly (default true)
 *   kelly_min_ratio: 0.05     # Kelly result lower bound (default 5%)
 *   kelly_max_ratio: 0.4      # Kelly result upper bound (default 40%)
 * ```
 *
 * ## Notes
 * - When samples < 10, falls back to fixed position_ratio (insufficient samples, unreliable)
 * - When Kelly < 0 (negative expectancy strategy) returns 0 (suggest pausing)
 * - Backtesting uses fixed ratio (historical data doesn't roll, Kelly is meaningless)
 */

// ─── Types ──────────────────────────────────────────────

export interface KellyInput {
  pnlPercent: number; // P&L percentage per closed trade
}

export interface KellyResult {
  ratio: number;         // Final position ratio (after half Kelly and bounds clamping)
  rawKelly: number;      // Raw Kelly% (unclamped)
  winRate: number;       // Win rate
  rrRatio: number;       // Risk-reward ratio R
  sampleSize: number;    // Reference sample size
  reliable: boolean;     // Reliable only when samples >= 10
  reason: string;        // Explanation (for logging)
}

export interface KellyOptions {
  lookback?: number;    // Reference last N trades (default 30)
  half?: boolean;       // Whether to use half Kelly (default true)
  minRatio?: number;    // Lower bound (default 0.05)
  maxRatio?: number;    // Upper bound (default 0.40)
  fallback?: number;    // Fallback ratio when insufficient samples (default 0.2)
  minSamples?: number;  // Minimum sample count (default 10)
}

// ─── Core Calculation ─────────────────────────────────────────

/**
 * Calculate Kelly position ratio based on historical trade records
 *
 * @param trades   List of closed trades (pnlPercent field)
 * @param opts     Kelly parameters
 */
export function calcKellyRatio(trades: KellyInput[], opts: KellyOptions = {}): KellyResult {
  const lookback = opts.lookback ?? 30;
  const half = opts.half ?? true;
  const minRatio = opts.minRatio ?? 0.05;
  const maxRatio = opts.maxRatio ?? 0.40;
  const fallback = opts.fallback ?? 0.2;
  const minSamples = opts.minSamples ?? 10;

  // Take only the most recent lookback trades
  const recent = trades.slice(-lookback);
  const sampleSize = recent.length;

  // Insufficient samples -> fallback
  if (sampleSize < minSamples) {
    return {
      ratio: fallback,
      rawKelly: 0,
      winRate: 0,
      rrRatio: 0,
      sampleSize,
      reliable: false,
      reason: `Insufficient samples (${sampleSize}/${minSamples}), using fixed position ${fallback * 100}%`,
    };
  }

  const wins = recent.filter((t) => t.pnlPercent > 0);
  const losses = recent.filter((t) => t.pnlPercent <= 0);

  const W = wins.length / sampleSize;

  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length)
    : 0;

  // When no losses (avgLoss=0), R -> Infinity, Kelly -> W (position = win rate)
  // Note: avgLoss=0 includes "all break-even" scenario (pnlPercent=0 filtered into losses)
  const R = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  // Kelly formula: W - (1-W)/R; when R=Infinity, (1-W)/R=0, result=W
  let rawKelly = R === Infinity ? W : R > 0 ? W - (1 - W) / R : 0;

  // Negative expectancy (rawKelly < 0) -> suggest pausing
  if (rawKelly < 0) {
    return {
      ratio: 0,
      rawKelly,
      winRate: W,
      rrRatio: R,
      sampleSize,
      reliable: true,
      reason: `Negative expectancy strategy (Kelly=${(rawKelly * 100).toFixed(1)}%), suggest pausing`,
    };
  }

  // Half Kelly
  if (half) rawKelly *= 0.5;

  // Clamp to [minRatio, maxRatio]
  const ratio = Math.min(maxRatio, Math.max(minRatio, rawKelly));

  return {
    ratio,
    rawKelly,
    winRate: W,
    rrRatio: R,
    sampleSize,
    reliable: true,
    reason: `Kelly${half ? "(half)" : ""} = ${(rawKelly * 100).toFixed(1)}% -> clamped to ${(ratio * 100).toFixed(1)}%`,
  };
}

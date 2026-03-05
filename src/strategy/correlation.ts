/**
 * Correlation Filter Module
 *
 * Used to check price correlation between a new signal and existing positions before opening.
 * Major coins like BTC/ETH/BNB/SOL typically have correlation > 0.8,
 * making simultaneous holding very poor for diversification.
 *
 * Logic:
 *   Calculate Pearson correlation coefficient of recent N kline returns
 *   between the new symbol and held symbols.
 *   If correlation > threshold (default 0.7), skip the new buy signal.
 */

import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Calculation Utilities
// ─────────────────────────────────────────────────────

/** Calculate per-bar log returns from kline array (ln(close_t / close_{t-1})) */
export function calcReturns(klines: Kline[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1];
    const curr = klines[i];
    if (prev && curr && prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  return returns;
}

/**
 * Pearson correlation coefficient
 * @returns Correlation coefficient between -1 and 1, NaN indicates insufficient data
 */
export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;

  const aSlice = a.slice(-n);
  const bSlice = b.slice(-n);

  const meanA = aSlice.reduce((s, v) => s + v, 0) / n;
  const meanB = bSlice.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = (aSlice[i] ?? 0) - meanA;
    const db = (bSlice[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? NaN : cov / denom;
}

// ─────────────────────────────────────────────────────
// Position Correlation Check
// ─────────────────────────────────────────────────────

export interface CorrelationResult {
  /** Whether a highly correlated position was found */
  correlated: boolean;
  /** Highest correlation coefficient */
  maxCorrelation: number;
  /** Held symbol with highest correlation */
  correlatedWith: string | null;
  /** Skip reason (has value when correlated=true) */
  reason: string | null;
}

/**
 * Check whether the new symbol's klines are highly correlated with held symbols' klines
 *
 * @param newSymbol   Symbol of the new signal
 * @param newKlines   Recent N klines for the new symbol
 * @param heldKlines  Kline Map for each held symbol (symbol -> Kline[])
 * @param threshold   Correlation coefficient threshold; above this is considered highly correlated (default 0.7)
 * @returns CorrelationResult
 */
export function checkCorrelation(
  newSymbol: string,
  newKlines: Kline[],
  heldKlines: Map<string, Kline[]>,
  threshold = 0.7
): CorrelationResult {
  if (heldKlines.size === 0) {
    return { correlated: false, maxCorrelation: 0, correlatedWith: null, reason: null };
  }

  const newReturns = calcReturns(newKlines);
  if (newReturns.length < 10) {
    // Insufficient data, skip correlation check (allow trade)
    return { correlated: false, maxCorrelation: 0, correlatedWith: null, reason: null };
  }

  let maxCorr = -Infinity;
  let maxCorrSymbol: string | null = null;

  for (const [heldSymbol, heldKlineList] of heldKlines) {
    if (heldSymbol === newSymbol) continue;
    const heldReturns = calcReturns(heldKlineList);
    const corr = pearsonCorrelation(newReturns, heldReturns);
    if (isNaN(corr)) continue;
    if (corr > maxCorr) {
      maxCorr = corr;
      maxCorrSymbol = heldSymbol;
    }
  }

  if (maxCorr === -Infinity) {
    return { correlated: false, maxCorrelation: 0, correlatedWith: null, reason: null };
  }

  if (maxCorr >= threshold) {
    return {
      correlated: true,
      maxCorrelation: maxCorr,
      correlatedWith: maxCorrSymbol,
      reason: `${newSymbol} correlated with held ${maxCorrSymbol} coeff=${maxCorr.toFixed(3)} (threshold=${threshold}), poor diversification, skipped`,
    };
  }

  return {
    correlated: false,
    maxCorrelation: maxCorr,
    correlatedWith: maxCorrSymbol,
    reason: null,
  };
}

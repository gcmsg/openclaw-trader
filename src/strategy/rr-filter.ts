/**
 * Risk-Reward Filter
 *
 * Logic:
 *   distance_to_resistance / distance_to_support < min_rr -> reject signal
 *
 * Uses recent N klines' highs/lows to estimate support/resistance zones.
 * When Pivot Point data is available it can be passed externally, otherwise falls back to recent highs/lows.
 *
 * Default min_rr = 1.5: profit potential must be at least 1.5x the stop-loss distance.
 */

import type { Kline } from "../types.js";

/** Auto-select decimal places based on price magnitude, avoiding "$0" display for micro-priced coins */
function fmtPrice(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 1)   return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

// ─── Types ──────────────────────────────────────────────

export interface RrCheckResult {
  ratio: number;       // Actual R:R (long = distance-to-resistance / distance-to-support, short = inverse)
  passed: boolean;
  support: number;
  resistance: number;
  reason: string;
}

// ─── Core Check Function ───────────────────────────────────────

/**
 * Check if the risk/reward ratio of a buy/short signal meets the minimum requirement
 *
 * @param klines Fetched klines (recommended 20-60)
 * @param price  Current price
 * @param side   "long" | "short"
 * @param minRr  Minimum acceptable R:R, 0 = disabled (default 1.5)
 * @param lookback Number of klines for S/R estimation (default 20)
 * @param pivotSupport  Optional external support level (takes priority over recent lows)
 * @param pivotResistance Optional external resistance level (takes priority over recent highs)
 */
export function checkRiskReward(
  klines: Kline[],
  price: number,
  side: "long" | "short",
  minRr = 1.5,
  lookback = 20,
  pivotSupport?: number,
  pivotResistance?: number
): RrCheckResult {
  // Disabled: pass through
  if (minRr <= 0) {
    return {
      ratio: Infinity,
      passed: true,
      support: pivotSupport ?? price * 0.95,
      resistance: pivotResistance ?? price * 1.05,
      reason: "R:R filter disabled (min_rr=0)",
    };
  }

  const window = klines.slice(-lookback);

  // Insufficient data: skip check (prefer to pass rather than false reject)
  if (window.length < 5) {
    return {
      ratio: Infinity,
      passed: true,
      support: price * 0.95,
      resistance: price * 1.05,
      reason: "Insufficient klines, skipping R:R check",
    };
  }

  // Use Pivot or recent highs/lows as S/R
  const support = pivotSupport ?? Math.min(...window.map((k) => k.low));
  const resistance = pivotResistance ?? Math.max(...window.map((k) => k.high));

  const distUp = resistance - price;   // Distance to resistance (potential profit)
  const distDown = price - support;    // Distance to support (potential stop-loss)

  if (distDown <= 0 || distUp <= 0) {
    return {
      ratio: 0,
      passed: false,
      support,
      resistance,
      reason: `Price $${fmtPrice(price)} is outside recent range (support $${fmtPrice(support)} – resistance $${fmtPrice(resistance)})`,
    };
  }

  const ratio = side === "long" ? distUp / distDown : distDown / distUp;
  const passed = ratio >= minRr;
  const dirLabel = side === "long" ? "long" : "short";

  const reason = passed
    ? `R:R=${ratio.toFixed(2)} >= ${minRr} (${dirLabel}), resistance $${fmtPrice(resistance)} / support $${fmtPrice(support)}`
    : `R:R=${ratio.toFixed(2)} < ${minRr} (${dirLabel}), insufficient profit potential (dist-to-resistance $${fmtPrice(distUp)} / dist-to-support $${fmtPrice(distDown)})`;

  return { ratio, passed, support, resistance, reason };
}

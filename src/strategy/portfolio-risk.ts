/**
 * Portfolio Exposure Management
 *
 * Core problem:
 *   Current correlation filter is a binary decision -- correlation > 0.7 means reject.
 *   This is too coarse: BTC/ETH correlation is 0.85, but ETH at 10% of portfolio is far less risky than 40%.
 *
 * Improvement: Correlation-weighted position scaling
 *   heat = sum(correlation_i x weight_i)  <- correlation contribution from all held assets
 *   adjusted_size = base_size x (1 - heat)
 *
 * Example:
 *   ETH held at 30%, BTC/ETH correlation 0.85
 *   -> heat = 0.85 x 0.30 = 0.255
 *   -> New BTC position = base x 0.745 ~= reduced by ~25%
 *
 *   ETH + SOL each at 30% (correlated 0.85 with new signal)
 *   -> heat = 0.85x0.30 + 0.85x0.30 = 0.51
 *   -> New position = base x 0.49 ~= reduced 51%
 *
 *   If heat >= 1.0 -> reject opening (portfolio is severely concentrated in same direction)
 */

import { pearsonCorrelation, calcReturns } from "./correlation.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface PositionWeight {
  symbol: string;
  side: "long" | "short";
  notionalUsdt: number;   // Position notional value
  weight: number;         // Proportion of total equity (0-1)
}

export interface PortfolioHeat {
  /** Correlation heat of new position relative to portfolio (0 = no correlation, 1 = fully correlated) */
  heat: number;
  /** Each held asset's contribution to heat */
  contributions: {
    symbol: string;
    correlation: number;
    weight: number;
    contribution: number;  // correlation × weight
  }[];
  /** Adjusted position ratio (relative to base_ratio) */
  sizeMultiplier: number;
  /** Suggested final position ratio */
  adjustedPositionRatio: number;
  /** Decision description */
  decision: "normal" | "reduced" | "blocked";
  reason: string;
}

export interface PortfolioExposureSummary {
  totalNotionalUsdt: number;
  totalEquityUsdt: number;
  netExposureRatio: number;       // Net exposure (long-short) / equity
  grossExposureRatio: number;     // Gross exposure (long+short) / equity
  longExposureRatio: number;
  shortExposureRatio: number;
  numLong: number;
  numShort: number;
  /** Pairwise correlation within portfolio (only calculated when >= 2 positions) */
  avgPairwiseCorrelation: number | null;
  /** Risk rating */
  riskLevel: "low" | "medium" | "high" | "extreme";
  riskLabel: string;
}

// ─────────────────────────────────────────────────────
// Core Calculation
// ─────────────────────────────────────────────────────

/**
 * Calculate the "correlation heat" of a new position against the existing portfolio
 * and return the adjusted position ratio
 *
 * @param newSymbol         New symbol to open
 * @param newSide           New position direction (long/short)
 * @param baseRatio         Base position ratio (from cfg.risk.position_ratio)
 * @param existingPositions Current position list (with weights)
 * @param klinesBySymbol    Historical klines (for correlation calculation)
 * @param lookback          Number of klines for correlation calculation (default 60)
 * @param maxHeat           Heat ceiling, reject above this (default 0.85)
 */
export function calcCorrelationAdjustedSize(
  newSymbol: string,
  newSide: "long" | "short",
  baseRatio: number,
  existingPositions: PositionWeight[],
  klinesBySymbol: Record<string, Kline[]>,
  lookback = 60,
  maxHeat = 0.85
): PortfolioHeat {
  if (existingPositions.length === 0) {
    return {
      heat: 0,
      contributions: [],
      sizeMultiplier: 1,
      adjustedPositionRatio: baseRatio,
      decision: "normal",
      reason: "Portfolio empty, normal position",
    };
  }

  const newKlines = klinesBySymbol[newSymbol] ?? [];
  const newReturns = calcReturns(newKlines.slice(-lookback - 1));

  if (newReturns.length < 10) {
    return {
      heat: 0,
      contributions: [],
      sizeMultiplier: 1,
      adjustedPositionRatio: baseRatio,
      decision: "normal",
      reason: "Insufficient data, skipping correlation adjustment",
    };
  }

  const contributions: PortfolioHeat["contributions"] = [];
  let totalHeat = 0;

  for (const pos of existingPositions) {
    const posKlines = klinesBySymbol[pos.symbol] ?? [];
    const posReturns = calcReturns(posKlines.slice(-lookback - 1));

    if (posReturns.length < 10) continue;

    const corr = pearsonCorrelation(newReturns, posReturns);
    if (isNaN(corr)) continue;

    // Direction adjustment:
    //   If new position and held position are opposite (one long one short), correlation is negative contribution (hedging effect)
    //   If new position and held position are same direction, correlation is positive contribution (increases concentration)
    const sameDirection = newSide === pos.side;
    const effectiveCorr = sameDirection ? Math.abs(corr) : -Math.abs(corr);
    const contribution = effectiveCorr * pos.weight;

    contributions.push({
      symbol: pos.symbol,
      correlation: corr,
      weight: pos.weight,
      contribution,
    });

    totalHeat += contribution;
  }

  // Clamp heat to [0, 1] (negative heat means hedging effect, treat as 0)
  const heat = Math.max(0, totalHeat);
  const sizeMultiplier = Math.max(0, 1 - heat);
  const adjustedPositionRatio = baseRatio * sizeMultiplier;

  let decision: PortfolioHeat["decision"];
  let reason: string;

  const topContrib = [...contributions]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map((c) => `${c.symbol.replace("USDT", "")} corr=${c.correlation.toFixed(2)} w=${(c.weight * 100).toFixed(0)}%`)
    .join(", ");

  if (heat >= maxHeat) {
    decision = "blocked";
    reason = `Portfolio heat ${(heat * 100).toFixed(0)}% >= ${(maxHeat * 100).toFixed(0)}% (${topContrib}), position rejected`;
  } else if (sizeMultiplier < 0.95) {
    decision = "reduced";
    const reduction = ((1 - sizeMultiplier) * 100).toFixed(0);
    reason = `Correlation heat ${(heat * 100).toFixed(0)}%, position reduced ${reduction}% (${topContrib})`;
  } else {
    decision = "normal";
    reason = `Portfolio heat ${(heat * 100).toFixed(0)}%, low correlation, normal position`;
  }

  return {
    heat,
    contributions,
    sizeMultiplier,
    adjustedPositionRatio,
    decision,
    reason,
  };
}

// ─────────────────────────────────────────────────────
// Portfolio Exposure Summary
// ─────────────────────────────────────────────────────

/**
 * Calculate overall portfolio exposure
 * @param positions    Position list (with notionalUsdt and side)
 * @param totalEquity  Total equity (USDT)
 * @param klinesBySymbol  Kline data (for pairwise correlation calculation)
 */
export function calcPortfolioExposure(
  positions: PositionWeight[],
  totalEquity: number,
  klinesBySymbol?: Record<string, Kline[]>
): PortfolioExposureSummary {
  const longPositions = positions.filter((p) => p.side === "long");
  const shortPositions = positions.filter((p) => p.side === "short");

  const longExposure = longPositions.reduce((s, p) => s + p.notionalUsdt, 0);
  const shortExposure = shortPositions.reduce((s, p) => s + p.notionalUsdt, 0);
  const totalNotional = longExposure + shortExposure;

  const netExposureRatio = totalEquity > 0 ? (longExposure - shortExposure) / totalEquity : 0;
  const grossExposureRatio = totalEquity > 0 ? totalNotional / totalEquity : 0;

  // Pairwise correlation (only calculated when kline data available and positions >= 2)
  let avgPairwiseCorrelation: number | null = null;
  if (klinesBySymbol && positions.length >= 2) {
    const pairs: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const aKlines = klinesBySymbol[positions[i]?.symbol ?? ""];
        const bKlines = klinesBySymbol[positions[j]?.symbol ?? ""];
        if (!aKlines || !bKlines) continue;
        const corr = pearsonCorrelation(calcReturns(aKlines.slice(-61)), calcReturns(bKlines.slice(-61)));
        if (!isNaN(corr)) pairs.push(Math.abs(corr));
      }
    }
    if (pairs.length > 0) {
      avgPairwiseCorrelation = pairs.reduce((s, c) => s + c, 0) / pairs.length;
    }
  }

  // Risk rating
  let riskLevel: PortfolioExposureSummary["riskLevel"];
  let riskLabel: string;

  const isHighCorr = avgPairwiseCorrelation !== null && avgPairwiseCorrelation > 0.75;

  if (grossExposureRatio > 0.8 && isHighCorr) {
    riskLevel = "extreme";
    riskLabel = `🔴 Extreme risk: leverage ${(grossExposureRatio * 100).toFixed(0)}% + high correlation (${((avgPairwiseCorrelation ?? 0) * 100).toFixed(0)}%)`;
  } else if (grossExposureRatio > 0.6 || isHighCorr) {
    riskLevel = "high";
    riskLabel = `🟠 High risk: position ${(grossExposureRatio * 100).toFixed(0)}%` + (isHighCorr ? `, correlation ${((avgPairwiseCorrelation ?? 0) * 100).toFixed(0)}%` : "");
  } else if (grossExposureRatio > 0.3) {
    riskLevel = "medium";
    riskLabel = `🟡 Medium risk: position ${(grossExposureRatio * 100).toFixed(0)}%`;
  } else {
    riskLevel = "low";
    riskLabel = `🟢 Low risk: position ${(grossExposureRatio * 100).toFixed(0)}%`;
  }

  return {
    totalNotionalUsdt: totalNotional,
    totalEquityUsdt: totalEquity,
    netExposureRatio,
    grossExposureRatio,
    longExposureRatio: totalEquity > 0 ? longExposure / totalEquity : 0,
    shortExposureRatio: totalEquity > 0 ? shortExposure / totalEquity : 0,
    numLong: longPositions.length,
    numShort: shortPositions.length,
    avgPairwiseCorrelation,
    riskLevel,
    riskLabel,
  };
}

// ─────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────

export function formatPortfolioExposure(summary: PortfolioExposureSummary): string {
  const lines = [
    `📊 **Portfolio Exposure**`,
    `Long ${(summary.longExposureRatio * 100).toFixed(1)}%  Short ${(summary.shortExposureRatio * 100).toFixed(1)}%  Net ${summary.netExposureRatio >= 0 ? "+" : ""}${(summary.netExposureRatio * 100).toFixed(1)}%`,
  ];

  if (summary.avgPairwiseCorrelation !== null) {
    lines.push(`Avg pairwise correlation: ${(summary.avgPairwiseCorrelation * 100).toFixed(0)}%`);
  }

  lines.push(summary.riskLabel);
  return lines.join("\n");
}

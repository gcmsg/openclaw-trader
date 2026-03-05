/**
 * Break-Even Stop + Custom Stoploss utility functions (P8.1)
 *
 * Provides two core functions:
 *   - calcBreakEvenStop: Calculate break-even stop-loss price
 *   - resolveNewStopLoss: Combine break-even + customStoploss strategy callback, return final stop-loss price
 */

import type { RiskConfig } from "../types.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";

/**
 * Calculate break-even stop-loss price.
 *
 * Logic: When profitRatio >= breakEvenProfit, move the stop-loss to:
 *   - Long: entryPrice * (1 + breakEvenStop)
 *   - Short: entryPrice * (1 - breakEvenStop)
 *
 * The new stop-loss must be strictly better than (higher for long / lower for short)
 * the current stop-loss, otherwise returns null (no move).
 *
 * @param side            Position direction
 * @param entryPrice      Entry price
 * @param currentStopLoss Current stop-loss price
 * @param profitRatio     Current profit ratio (positive = profit, e.g. 0.03 = +3%)
 * @param breakEvenProfit Activation threshold (e.g. 0.03 = activate when profit >= 3%)
 * @param breakEvenStop   Break-even offset (e.g. 0.001 = entry price +0.1%)
 * @returns New stop-loss price, or null (no move needed)
 */
export function calcBreakEvenStop(
  side: "long" | "short",
  entryPrice: number,
  currentStopLoss: number,
  profitRatio: number,
  breakEvenProfit: number,
  breakEvenStop: number
): number | null {
  // Trigger condition not met
  if (profitRatio < breakEvenProfit) return null;

  // Calculate new stop-loss price
  const newStopLoss =
    side === "long"
      ? entryPrice * (1 + breakEvenStop)   // Long: above entry price
      : entryPrice * (1 - breakEvenStop);  // Short: below entry price

  // New stop-loss must be strictly better than current (can only move in favorable direction)
  if (side === "long") {
    if (newStopLoss <= currentStopLoss) return null;
  } else {
    if (newStopLoss >= currentStopLoss) return null;
  }

  return newStopLoss;
}

/**
 * Combine break-even + customStoploss strategy callback, return final stop-loss price.
 *
 * Priority: customStoploss() > break_even logic > existing stop-loss (unchanged)
 *
 * Hard floor protection: new stop-loss must not breach the hard floor set by stop_loss_percent:
 *   - Long: must not be lower than entryPrice * (1 - stopLossPercent)
 *   - Short: must not be higher than entryPrice * (1 + stopLossPercent)
 *
 * @param side            Position direction
 * @param entryPrice      Entry price
 * @param currentStopLoss Current stop-loss price
 * @param currentPrice    Current market price
 * @param profitRatio     Current profit ratio (positive = profit)
 * @param holdMs          Hold duration (milliseconds)
 * @param symbol          Trading pair name
 * @param riskCfg         Risk config (includes break_even_profit / break_even_stop)
 * @param strategy        Strategy plugin (optional, provides customStoploss callback)
 * @param ctx             Strategy context (optional, passed to customStoploss)
 * @returns New stop-loss price, or null (no update needed)
 */
export function resolveNewStopLoss(
  side: "long" | "short",
  entryPrice: number,
  currentStopLoss: number,
  currentPrice: number,
  profitRatio: number,
  holdMs: number,
  symbol: string,
  riskCfg: RiskConfig,
  strategy?: Strategy,
  ctx?: StrategyContext
): number | null {
  let candidateStop: number | null = null;

  // ── 1. customStoploss takes priority (only called when both strategy and ctx exist) ──
  if (strategy?.customStoploss !== undefined && ctx !== undefined) {
    const custom = strategy.customStoploss(
      {
        symbol,
        side,
        entryPrice,
        currentPrice,
        currentStopLoss,
        profitRatio,
        holdMs,
      },
      ctx
    );
    if (custom !== null) {
      candidateStop = custom;
    }
  }

  // ── 2. If customStoploss didn't provide a new stop-loss, try break-even logic ──
  if (candidateStop === null) {
    const bep = riskCfg.break_even_profit;
    const bes = riskCfg.break_even_stop ?? 0.001;
    if (bep !== undefined) {
      candidateStop = calcBreakEvenStop(
        side,
        entryPrice,
        currentStopLoss,
        profitRatio,
        bep,
        bes
      );
    }
  }

  // No candidate stop-loss -> no update
  if (candidateStop === null) return null;

  // ── 3. Hard floor protection: stop-loss must not breach the original stop_loss_percent line ──
  const stopLossDecimal = riskCfg.stop_loss_percent / 100;
  if (side === "long") {
    // Long: stop-loss must not be lower than entryPrice * (1 - stopLossPercent)
    const hardFloor = entryPrice * (1 - stopLossDecimal);
    candidateStop = Math.max(candidateStop, hardFloor);
  } else {
    // Short: stop-loss must not be higher than entryPrice * (1 + stopLossPercent)
    const hardCeiling = entryPrice * (1 + stopLossDecimal);
    candidateStop = Math.min(candidateStop, hardCeiling);
  }

  // ── 4. Final check: new stop-loss must be strictly better than current (can only move in favorable direction) ──
  if (side === "long") {
    if (candidateStop <= currentStopLoss) return null;
  } else {
    if (candidateStop >= currentStopLoss) return null;
  }

  return candidateStop;
}

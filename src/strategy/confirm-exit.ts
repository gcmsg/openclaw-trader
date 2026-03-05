/**
 * P8.2 confirm_trade_exit — Exit confirmation hook
 *
 * Provides two utility functions:
 * 1. shouldConfirmExit: Decide whether to allow this exit
 * 2. isExitRejectionCoolingDown: Cooldown tracking to avoid repetitive logging
 */

import type { Strategy, StrategyContext } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Position type (aligned with Strategy.confirmExit parameters)
// ─────────────────────────────────────────────────────

export interface ConfirmExitPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  profitRatio: number;
  holdMs: number;
}

// ─────────────────────────────────────────────────────
// shouldConfirmExit
// ─────────────────────────────────────────────────────

/**
 * Default exit confirmation logic (works without a strategy plugin):
 *
 * Priority:
 *  1. force_exit is never rejected (cannot be blocked)
 *  2. Strategy confirmExit() callback (if available)
 *  3. Default price deviation check:
 *     |profitRatio| > maxDeviation and exitReason === "stop_loss" -> reject
 *     (Abnormal stop-loss caused by flash crash, likely due to lack of liquidity; wait for recovery)
 */
export function shouldConfirmExit(
  position: ConfirmExitPosition,
  exitReason: string,
  maxDeviation: number,
  strategy?: Strategy,
  ctx?: StrategyContext
): { confirmed: boolean; reason?: string } {
  // force_exit is never rejected
  if (exitReason === "force_exit" || exitReason === "force_exit_timeout" || exitReason === "force_exit_manual") {
    return { confirmed: true };
  }

  // Strategy custom confirmExit callback (takes priority over default logic)
  if (strategy?.confirmExit !== undefined && ctx !== undefined) {
    const ok = strategy.confirmExit(position, exitReason, ctx);
    if (!ok) {
      return { confirmed: false, reason: "strategy_rejected" };
    }
    return { confirmed: true };
  }

  // Default: price deviation check (only applies to stop_loss)
  if (exitReason === "stop_loss") {
    const absDeviation = Math.abs(position.profitRatio);
    if (absDeviation > maxDeviation) {
      return {
        confirmed: false,
        reason: "flash_crash_protection",
      };
    }
  }

  return { confirmed: true };
}

// ─────────────────────────────────────────────────────
// isExitRejectionCoolingDown
// ─────────────────────────────────────────────────────

/**
 * Cooldown tracking: records the timestamp of the last exit rejection to avoid logging every round.
 *
 * @param symbol        Trading pair (e.g. BTCUSDT)
 * @param cooldownMs    Cooldown duration (milliseconds)
 * @param rejectionLog  Shared rejection log Map (symbol -> last rejection timestamp)
 * @returns true = still in cooldown (skip logging), false = not in cooldown (should log and update Map)
 */
export function isExitRejectionCoolingDown(
  symbol: string,
  cooldownMs: number,
  rejectionLog: Map<string, number>
): boolean {
  const lastRejectedAt = rejectionLog.get(symbol);
  if (lastRejectedAt === undefined) {
    return false;
  }
  return Date.now() - lastRejectedAt < cooldownMs;
}

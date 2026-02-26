/**
 * P8.2 confirm_trade_exit — 出场确认钩子
 *
 * 提供两个工具函数：
 * 1. shouldConfirmExit：决定是否允许本次出场
 * 2. isExitRejectionCoolingDown：冷却追踪，避免重复打日志
 */

import type { Strategy, StrategyContext } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Position 类型（与 Strategy.confirmExit 参数对齐）
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
 * 默认出场确认逻辑（不依赖策略插件也能用）：
 *
 * 优先级：
 *  1. force_exit 永不拒绝（不可阻止）
 *  2. 策略 confirmExit() 回调（如果有的话）
 *  3. 默认价格偏离检查：
 *     |profitRatio| > maxDeviation 且 exitReason === "stop_loss" → 拒绝
 *     （闪崩导致的异常止损，很可能是流动性缺失，等恢复后再出）
 */
export function shouldConfirmExit(
  position: ConfirmExitPosition,
  exitReason: string,
  maxDeviation: number,
  strategy?: Strategy,
  ctx?: StrategyContext
): { confirmed: boolean; reason?: string } {
  // force_exit 永不拒绝
  if (exitReason === "force_exit" || exitReason === "force_exit_timeout" || exitReason === "force_exit_manual") {
    return { confirmed: true };
  }

  // 策略自定义 confirmExit 回调（优先于默认逻辑）
  if (strategy?.confirmExit !== undefined && ctx !== undefined) {
    const ok = strategy.confirmExit(position, exitReason, ctx);
    if (!ok) {
      return { confirmed: false, reason: "strategy_rejected" };
    }
    return { confirmed: true };
  }

  // 默认：价格偏离检查（仅对 stop_loss 有效）
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
 * 冷却追踪：记录上次被拒绝出场的时间戳，避免每轮都打日志。
 *
 * @param symbol        交易对（如 BTCUSDT）
 * @param cooldownMs    冷却时间（毫秒）
 * @param rejectionLog  共享的拒绝记录 Map（symbol → 上次拒绝时间戳）
 * @returns true = 仍在冷却中（跳过日志），false = 不在冷却中（应该打日志并更新 Map）
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

/**
 * Break-Even Stop + Custom Stoploss 工具函数 (P8.1)
 *
 * 提供两个核心函数：
 *   - calcBreakEvenStop: 计算保本止损价格
 *   - resolveNewStopLoss: 综合 break-even + customStoploss 策略回调，返回最终止损价
 */

import type { RiskConfig } from "../types.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";

/**
 * 计算 break-even 止损价格。
 *
 * 逻辑：当 profitRatio >= breakEvenProfit 时，将止损线移到：
 *   - 多头：entryPrice * (1 + breakEvenStop)
 *   - 空头：entryPrice * (1 - breakEvenStop)
 *
 * 新止损必须严格高于（多头）/ 低于（空头）当前止损价，否则返回 null（不移动）。
 *
 * @param side            持仓方向
 * @param entryPrice      入场价格
 * @param currentStopLoss 当前止损价
 * @param profitRatio     当前盈利比率（正 = 盈利，如 0.03 = +3%）
 * @param breakEvenProfit 触发阈值（如 0.03 = 盈利 ≥ 3% 后激活）
 * @param breakEvenStop   保本偏移（如 0.001 = 入场价 +0.1%）
 * @returns 新的止损价，或 null（无需移动）
 */
export function calcBreakEvenStop(
  side: "long" | "short",
  entryPrice: number,
  currentStopLoss: number,
  profitRatio: number,
  breakEvenProfit: number,
  breakEvenStop: number
): number | null {
  // 未达到触发条件
  if (profitRatio < breakEvenProfit) return null;

  // 计算新止损价
  const newStopLoss =
    side === "long"
      ? entryPrice * (1 + breakEvenStop)   // 多头：高于入场价
      : entryPrice * (1 - breakEvenStop);  // 空头：低于入场价

  // 新止损必须严格优于当前止损（只能往有利方向移动）
  if (side === "long") {
    if (newStopLoss <= currentStopLoss) return null;
  } else {
    if (newStopLoss >= currentStopLoss) return null;
  }

  return newStopLoss;
}

/**
 * 综合 break-even + customStoploss 策略回调，返回最终止损价。
 *
 * 优先级：customStoploss() > break_even 逻辑 > 现有止损（不变）
 *
 * 硬底线保护：新止损不得突破原始 stop_loss_percent 配置的硬底线：
 *   - 多头：不得低于 entryPrice * (1 - stopLossPercent)
 *   - 空头：不得高于 entryPrice * (1 + stopLossPercent)
 *
 * @param side            持仓方向
 * @param entryPrice      入场价格
 * @param currentStopLoss 当前止损价
 * @param currentPrice    当前市场价格
 * @param profitRatio     当前盈利比率（正 = 盈利）
 * @param holdMs          持仓时长（毫秒）
 * @param symbol          交易对名称
 * @param riskCfg         风险配置（含 break_even_profit / break_even_stop）
 * @param strategy        策略插件（可选，提供 customStoploss 回调）
 * @param ctx             策略上下文（可选，传给 customStoploss）
 * @returns 新的止损价，或 null（无需更新）
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

  // ── 1. customStoploss 优先（仅当 strategy 和 ctx 均存在时调用）──
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

  // ── 2. 若 customStoploss 未给出新止损，尝试 break-even 逻辑 ──
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

  // 没有候选止损 → 不更新
  if (candidateStop === null) return null;

  // ── 3. 硬底线保护：止损不得突破 stop_loss_percent 配置的原始止损线 ──
  const stopLossDecimal = riskCfg.stop_loss_percent / 100;
  if (side === "long") {
    // 多头：止损不得低于 entryPrice * (1 - stopLossPercent)
    const hardFloor = entryPrice * (1 - stopLossDecimal);
    candidateStop = Math.max(candidateStop, hardFloor);
  } else {
    // 空头：止损不得高于 entryPrice * (1 + stopLossPercent)
    const hardCeiling = entryPrice * (1 + stopLossDecimal);
    candidateStop = Math.min(candidateStop, hardCeiling);
  }

  // ── 4. 最终检查：新止损必须严格优于当前止损（只能往有利方向移动）──
  if (side === "long") {
    if (candidateStop <= currentStopLoss) return null;
  } else {
    if (candidateStop >= currentStopLoss) return null;
  }

  return candidateStop;
}

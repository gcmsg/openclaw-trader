/**
 * 风险/回报比检查（Risk-Reward Filter）
 *
 * 逻辑：
 *   distance_to_resistance / distance_to_support < min_rr → 拒绝信号
 *
 * 用最近 N 根 K 线的高低点估算支撑/阻力区间。
 * 当 Pivot Point 数据可用时可从外部传入，否则退化为近期高低点。
 *
 * 默认 min_rr = 1.5：盈利空间必须至少是止损空间的 1.5 倍。
 */

import type { Kline } from "../types.js";

// ─── 类型 ──────────────────────────────────────────────

export interface RrCheckResult {
  ratio: number;       // 实际 R:R（多头=距阻力/距支撑，空头=距支撑/距阻力）
  passed: boolean;
  support: number;
  resistance: number;
  reason: string;
}

// ─── 核心检查函数 ───────────────────────────────────────

/**
 * 检查买入/开空信号的风险/回报比是否满足最低要求
 *
 * @param klines 已取 K 线（建议 20-60 根）
 * @param price  当前价格
 * @param side   "long" | "short"
 * @param minRr  最低可接受 R:R，0 = 禁用（默认 1.5）
 * @param lookback 估算 S/R 的 K 线数（默认 20）
 * @param pivotSupport  可选外部支撑位（优先于近期低点）
 * @param pivotResistance 可选外部阻力位（优先于近期高点）
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
  // 禁用时直接通过
  if (minRr <= 0) {
    return {
      ratio: Infinity,
      passed: true,
      support: pivotSupport ?? price * 0.95,
      resistance: pivotResistance ?? price * 1.05,
      reason: "R:R 过滤已禁用（min_rr=0）",
    };
  }

  const window = klines.slice(-lookback);

  // 数据不足时，跳过检查（宁可放行也不误杀）
  if (window.length < 5) {
    return {
      ratio: Infinity,
      passed: true,
      support: price * 0.95,
      resistance: price * 1.05,
      reason: "K 线不足，跳过 R:R 检查",
    };
  }

  // 使用 Pivot 或近期高低点作为 S/R
  const support = pivotSupport ?? Math.min(...window.map((k) => k.low));
  const resistance = pivotResistance ?? Math.max(...window.map((k) => k.high));

  const distUp = resistance - price;   // 距阻力（潜在盈利空间）
  const distDown = price - support;    // 距支撑（潜在止损空间）

  if (distDown <= 0 || distUp <= 0) {
    return {
      ratio: 0,
      passed: false,
      support,
      resistance,
      reason: `价格 $${price.toFixed(2)} 已超出近期区间（支撑 $${support.toFixed(2)}–阻力 $${resistance.toFixed(2)}）`,
    };
  }

  const ratio = side === "long" ? distUp / distDown : distDown / distUp;
  const passed = ratio >= minRr;
  const dirLabel = side === "long" ? "多" : "空";

  const reason = passed
    ? `R:R=${ratio.toFixed(2)} ≥ ${minRr}（${dirLabel}），阻力 $${resistance.toFixed(0)} / 支撑 $${support.toFixed(0)}`
    : `R:R=${ratio.toFixed(2)} < ${minRr}（${dirLabel}），盈利空间不足（距阻力 $${distUp.toFixed(0)} / 距支撑 $${distDown.toFixed(0)}）`;

  return { ratio, passed, support, resistance, reason };
}

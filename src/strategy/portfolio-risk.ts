/**
 * 组合暴露度管理
 *
 * 核心问题：
 *   当前相关性过滤是"二值判断"——相关 > 0.7 直接拒绝。
 *   这太粗糙：BTC/ETH 相关性 0.85，但 ETH 已持仓 10% 时风险远低于持仓 40% 时。
 *
 * 改进：相关性加权仓位缩放
 *   heat = Σ (correlation_i × weight_i)   ← 所有已持仓资产的相关性贡献
 *   adjusted_size = base_size × (1 - heat)
 *
 * 例：
 *   ETH 已持仓 30%，BTC/ETH 相关 0.85
 *   → heat = 0.85 × 0.30 = 0.255
 *   → 新开 BTC 仓位 = base × 0.745 ≈ 减仓约 25%
 *
 *   ETH + SOL 各持仓 30%（与新信号相关 0.85）
 *   → heat = 0.85×0.30 + 0.85×0.30 = 0.51
 *   → 新仓位 = base × 0.49 ≈ 减仓 51%
 *
 *   如果 heat ≥ 1.0 → 拒绝开仓（组合已经严重同向集中）
 */

import { pearsonCorrelation, calcReturns } from "./correlation.js";
import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface PositionWeight {
  symbol: string;
  side: "long" | "short";
  notionalUsdt: number;   // 仓位名义价值
  weight: number;         // 占总权益的比例（0-1）
}

export interface PortfolioHeat {
  /** 新仓位相对于组合的相关性热度（0 = 无关联，1 = 完全相关） */
  heat: number;
  /** 各已持仓资产对热度的贡献 */
  contributions: {
    symbol: string;
    correlation: number;
    weight: number;
    contribution: number;  // correlation × weight
  }[];
  /** 调整后的仓位比例（相对于 base_ratio） */
  sizeMultiplier: number;
  /** 建议的最终仓位比例 */
  adjustedPositionRatio: number;
  /** 决策描述 */
  decision: "normal" | "reduced" | "blocked";
  reason: string;
}

export interface PortfolioExposureSummary {
  totalNotionalUsdt: number;
  totalEquityUsdt: number;
  netExposureRatio: number;       // 净暴露（多头-空头）/ 权益
  grossExposureRatio: number;     // 总暴露（多头+空头）/ 权益
  longExposureRatio: number;
  shortExposureRatio: number;
  numLong: number;
  numShort: number;
  /** 组合内各币种对的相关性（≥3个仓位时才计算） */
  avgPairwiseCorrelation: number | null;
  /** 风险评级 */
  riskLevel: "low" | "medium" | "high" | "extreme";
  riskLabel: string;
}

// ─────────────────────────────────────────────────────
// 核心计算
// ─────────────────────────────────────────────────────

/**
 * 计算新仓位对现有组合的"相关性热度"
 * 并返回调整后的仓位比例
 *
 * @param newSymbol         新开仓标的
 * @param newSide           新仓方向（long/short）
 * @param baseRatio         基础仓位比例（来自 cfg.risk.position_ratio）
 * @param existingPositions 当前持仓列表（含权重）
 * @param klinesBySymbol    历史 K 线（用于计算相关系数）
 * @param lookback          相关性计算的 K 线数量（默认 60 根）
 * @param maxHeat           热度上限，超过则拒绝（默认 0.85）
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
      reason: "组合为空，正常仓位",
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
      reason: "数据不足，跳过相关性调整",
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

    // 方向调整：
    //   如果新仓和已仓方向相反（一多一空），相关性为负贡献（实际上起对冲作用）
    //   如果新仓和已仓方向相同，相关性为正贡献（加剧集中度）
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

  // heat 限制在 [0, 1]（负 heat 意味着对冲效果，视为 0）
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
    reason = `组合热度 ${(heat * 100).toFixed(0)}% ≥ ${(maxHeat * 100).toFixed(0)}%（${topContrib}），拒绝开仓`;
  } else if (sizeMultiplier < 0.95) {
    decision = "reduced";
    const reduction = ((1 - sizeMultiplier) * 100).toFixed(0);
    reason = `相关性热度 ${(heat * 100).toFixed(0)}%，仓位缩减 ${reduction}%（${topContrib}）`;
  } else {
    decision = "normal";
    reason = `组合热度 ${(heat * 100).toFixed(0)}%，低相关，正常仓位`;
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
// 组合暴露度汇总
// ─────────────────────────────────────────────────────

/**
 * 计算当前组合的总体暴露度
 * @param positions    持仓列表（含 notionalUsdt 和 side）
 * @param totalEquity  总权益（USDT）
 * @param klinesBySymbol  K 线数据（用于计算两两相关性）
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

  // 两两相关性（仅在有 K 线数据且持仓 ≥ 2 时计算）
  let avgPairwiseCorrelation: number | null = null;
  if (klinesBySymbol && positions.length >= 2) {
    const pairs: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const aKlines = klinesBySymbol[positions[i]!.symbol];
        const bKlines = klinesBySymbol[positions[j]!.symbol];
        if (!aKlines || !bKlines) continue;
        const corr = pearsonCorrelation(calcReturns(aKlines.slice(-61)), calcReturns(bKlines.slice(-61)));
        if (!isNaN(corr)) pairs.push(Math.abs(corr));
      }
    }
    if (pairs.length > 0) {
      avgPairwiseCorrelation = pairs.reduce((s, c) => s + c, 0) / pairs.length;
    }
  }

  // 风险评级
  let riskLevel: PortfolioExposureSummary["riskLevel"];
  let riskLabel: string;

  const isHighCorr = avgPairwiseCorrelation !== null && avgPairwiseCorrelation > 0.75;

  if (grossExposureRatio > 0.8 && isHighCorr) {
    riskLevel = "extreme";
    riskLabel = `🔴 极高风险：杠杆 ${(grossExposureRatio * 100).toFixed(0)}% + 高相关（${(avgPairwiseCorrelation! * 100).toFixed(0)}%）`;
  } else if (grossExposureRatio > 0.6 || isHighCorr) {
    riskLevel = "high";
    riskLabel = `🟠 较高风险：仓位 ${(grossExposureRatio * 100).toFixed(0)}%` + (isHighCorr ? `，相关 ${(avgPairwiseCorrelation! * 100).toFixed(0)}%` : "");
  } else if (grossExposureRatio > 0.3) {
    riskLevel = "medium";
    riskLabel = `🟡 中等风险：仓位 ${(grossExposureRatio * 100).toFixed(0)}%`;
  } else {
    riskLevel = "low";
    riskLabel = `🟢 低风险：仓位 ${(grossExposureRatio * 100).toFixed(0)}%`;
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
// 格式化
// ─────────────────────────────────────────────────────

export function formatPortfolioExposure(summary: PortfolioExposureSummary): string {
  const lines = [
    `📊 **组合暴露度**`,
    `多头 ${(summary.longExposureRatio * 100).toFixed(1)}%  空头 ${(summary.shortExposureRatio * 100).toFixed(1)}%  净 ${summary.netExposureRatio >= 0 ? "+" : ""}${(summary.netExposureRatio * 100).toFixed(1)}%`,
  ];

  if (summary.avgPairwiseCorrelation !== null) {
    lines.push(`两两相关系数均值: ${(summary.avgPairwiseCorrelation * 100).toFixed(0)}%`);
  }

  lines.push(summary.riskLabel);
  return lines.join("\n");
}

/**
 * 相关性过滤模块
 *
 * 用于在开仓前检查新信号与已持仓资产的价格相关性。
 * BTC/ETH/BNB/SOL 等主流币相关性通常 > 0.8，同时持有分散化效果极差。
 *
 * 判断逻辑：
 *   计算新 symbol 与已持仓 symbol 的近 N 根 K 线收益率的皮尔逊相关系数
 *   若相关性 > threshold（默认 0.7），跳过新买入信号
 */

import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// 计算工具
// ─────────────────────────────────────────────────────

/** 从 K 线数组计算逐根对数收益率（ln(close_t / close_{t-1})） */
export function calcReturns(klines: Kline[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1]!;
    const curr = klines[i]!;
    if (prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  return returns;
}

/**
 * 皮尔逊相关系数
 * @returns -1 到 1 之间的相关系数，NaN 表示数据不足
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
    const da = aSlice[i]! - meanA;
    const db = bSlice[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? NaN : cov / denom;
}

// ─────────────────────────────────────────────────────
// 持仓相关性检查
// ─────────────────────────────────────────────────────

export interface CorrelationResult {
  /** 是否发现高相关持仓 */
  correlated: boolean;
  /** 最高相关系数 */
  maxCorrelation: number;
  /** 相关性最高的已持仓 symbol */
  correlatedWith: string | null;
  /** 跳过理由（correlated=true 时有值） */
  reason: string | null;
}

/**
 * 检查新 symbol 的 K 线与已持仓各 symbol 的 K 线是否高度相关
 *
 * @param newSymbol   新信号的 symbol
 * @param newKlines   新 symbol 最近 N 根 K 线
 * @param heldKlines  已持仓各 symbol 的 K 线 Map（symbol → Kline[]）
 * @param threshold   相关系数阈值，超过则视为高度相关（默认 0.7）
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
    // 数据不足，跳过相关性检查（允许交易）
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
      reason: `${newSymbol} 与已持仓 ${maxCorrSymbol} 相关系数=${maxCorr.toFixed(3)}（阈值=${threshold}），分散化效果差，跳过`,
    };
  }

  return {
    correlated: false,
    maxCorrelation: maxCorr,
    correlatedWith: maxCorrSymbol,
    reason: null,
  };
}

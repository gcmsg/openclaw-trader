/**
 * Kelly 公式动态仓位
 *
 * ## 原理
 * Kelly% = W - (1 - W) / R
 *   W = 近期胜率（盈利笔 / 总平仓笔）
 *   R = 盈亏比（平均盈利% / 平均亏损%）
 *
 * 半 Kelly（× 0.5）降低方差，适合实盘使用。
 *
 * ## 使用方式（strategy.yaml）
 * ```yaml
 * risk:
 *   position_sizing: "kelly"  # "fixed"（默认）| "kelly"
 *   kelly_lookback: 30        # 参考最近 N 笔平仓（默认 30）
 *   kelly_half: true          # 是否使用半 Kelly（默认 true）
 *   kelly_min_ratio: 0.05     # Kelly 结果下限（默认 5%）
 *   kelly_max_ratio: 0.4      # Kelly 结果上限（默认 40%）
 * ```
 *
 * ## 注意
 * - 样本 < 10 笔时退化到 fixed position_ratio（样本不足，不可靠）
 * - Kelly < 0 时（负期望值策略）返回 0（建议暂停）
 * - 回测中使用 fixed 比例（历史数据不滚动，Kelly 无意义）
 */

// ─── 类型 ──────────────────────────────────────────────

export interface KellyInput {
  pnlPercent: number; // 每笔平仓的盈亏百分比
}

export interface KellyResult {
  ratio: number;         // 最终仓位比例（经过半 Kelly 和上下限约束）
  rawKelly: number;      // 原始 Kelly%（未约束）
  winRate: number;       // 胜率
  rrRatio: number;       // 盈亏比 R
  sampleSize: number;    // 参考样本数量
  reliable: boolean;     // 样本 ≥ 10 才可靠
  reason: string;        // 说明（用于日志）
}

export interface KellyOptions {
  lookback?: number;    // 参考最近 N 笔（默认 30）
  half?: boolean;       // 是否使用半 Kelly（默认 true）
  minRatio?: number;    // 下限（默认 0.05）
  maxRatio?: number;    // 上限（默认 0.40）
  fallback?: number;    // 样本不足时的回退比例（默认 0.2）
  minSamples?: number;  // 最少样本数（默认 10）
}

// ─── 核心计算 ─────────────────────────────────────────

/**
 * 根据历史交易记录计算 Kelly 仓位比例
 *
 * @param trades   已平仓交易列表（pnlPercent 字段）
 * @param opts     Kelly 参数
 */
export function calcKellyRatio(trades: KellyInput[], opts: KellyOptions = {}): KellyResult {
  const lookback = opts.lookback ?? 30;
  const half = opts.half ?? true;
  const minRatio = opts.minRatio ?? 0.05;
  const maxRatio = opts.maxRatio ?? 0.40;
  const fallback = opts.fallback ?? 0.2;
  const minSamples = opts.minSamples ?? 10;

  // 只取最近 lookback 笔
  const recent = trades.slice(-lookback);
  const sampleSize = recent.length;

  // 样本不足 → 退化
  if (sampleSize < minSamples) {
    return {
      ratio: fallback,
      rawKelly: 0,
      winRate: 0,
      rrRatio: 0,
      sampleSize,
      reliable: false,
      reason: `样本不足（${sampleSize}/${minSamples}），使用固定仓位 ${fallback * 100}%`,
    };
  }

  const wins = recent.filter((t) => t.pnlPercent > 0);
  const losses = recent.filter((t) => t.pnlPercent <= 0);

  const W = wins.length / sampleSize;

  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length)
    : 0;

  // 无亏损时 R → Infinity，Kelly → W（仓位 = 胜率）
  const R = avgLoss > 0 ? avgWin / avgLoss : avgWin;

  // Kelly 公式
  let rawKelly = R > 0 ? W - (1 - W) / R : 0;

  // 负期望值（rawKelly < 0）→ 建议暂停
  if (rawKelly < 0) {
    return {
      ratio: 0,
      rawKelly,
      winRate: W,
      rrRatio: R,
      sampleSize,
      reliable: true,
      reason: `负期望值策略 (Kelly=${(rawKelly * 100).toFixed(1)}%)，建议暂停开仓`,
    };
  }

  // 半 Kelly
  if (half) rawKelly *= 0.5;

  // 约束到 [minRatio, maxRatio]
  const ratio = Math.min(maxRatio, Math.max(minRatio, rawKelly));

  return {
    ratio,
    rawKelly,
    winRate: W,
    rrRatio: R,
    sampleSize,
    reliable: true,
    reason: `Kelly${half ? "(半)" : ""} = ${(rawKelly * 100).toFixed(1)}% → 约束后 ${(ratio * 100).toFixed(1)}%`,
  };
}

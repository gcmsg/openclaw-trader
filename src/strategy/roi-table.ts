/**
 * ROI Table 时间衰减止盈
 *
 * 参考 Freqtrade 的 minimal_roi 设计：持仓时间越长，止盈目标越低。
 * 策略：让利润"落袋"，避免"看着涨又全跌回来"。
 *
 * 配置示例（strategy.yaml）：
 *   minimal_roi:
 *     "0":   0.08   # 刚开仓：等 8% 再走
 *     "60":  0.04   # 持仓 1h：4% 就走
 *     "120": 0.02   # 持仓 2h：2% 就走
 *     "480": 0.00   # 持仓 8h：保本就走（0 = 任意有盈利即出）
 */

/**
 * 根据持仓时长查找当前适用的 ROI 阈值。
 *
 * @param roiTable  minimal_roi 配置（key = 最小持仓分钟数，value = 最低盈利比率）
 * @param holdMs    当前持仓时长（毫秒）
 * @returns 当前阶段的盈利阈值（0.05 = 5%），若 roiTable 为空或尚未进入任何阶段则返回 null
 */
export function getMinimalRoiThreshold(
  roiTable: Record<string, number>,
  holdMs: number
): number | null {
  const holdMinutes = holdMs / 60_000;
  const keys = Object.keys(roiTable).map(Number);
  if (keys.length === 0) return null;

  // 找到所有 key ≤ 当前持仓时长的条目，取最大 key（最近的档位）
  const applicableKeys = keys.filter((k) => k <= holdMinutes);
  if (applicableKeys.length === 0) return null; // 还未进入第一档

  const latestKey = Math.max(...applicableKeys);
  return roiTable[String(latestKey)] ?? null;
}

/**
 * 检查当前盈利是否达到 ROI Table 的当前阶段目标。
 *
 * @param roiTable      minimal_roi 配置
 * @param holdMs        当前持仓时长（毫秒）
 * @param profitRatio   当前盈利比率（0.05 = +5%，正数为盈利）
 * @returns true = 应该出场（ROI 触发），false = 继续持有
 */
export function checkMinimalRoi(
  roiTable: Record<string, number>,
  holdMs: number,
  profitRatio: number
): boolean {
  const threshold = getMinimalRoiThreshold(roiTable, holdMs);
  if (threshold === null) return false;
  // threshold = 0 时：任何正盈利即出场
  return profitRatio >= threshold;
}

/**
 * 格式化 ROI Table 为可读字符串（用于日志 / 通知）。
 *
 * @example
 * formatRoiTable({ "0": 0.08, "60": 0.04, "120": 0.02 })
 * // → "0min→8.0%  60min→4.0%  120min→2.0%"
 */
export function formatRoiTable(roiTable: Record<string, number>): string {
  const sorted = Object.keys(roiTable)
    .map(Number)
    .sort((a, b) => a - b);
  return sorted
    .map((k) => `${k}min→${((roiTable[String(k)] ?? 0) * 100).toFixed(1)}%`)
    .join("  ");
}

/**
 * 计算多头当前盈利比率（不含手续费，用于 ROI 检查）。
 * live/executor.ts 中已有含手续费版本；本函数用于 paper engine 的实时 tick 检查。
 */
export function calcLongProfitRatio(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (currentPrice - entryPrice) / entryPrice;
}

/**
 * 计算空头当前盈利比率（入场价 > 当前价时为正盈利）。
 */
export function calcShortProfitRatio(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (entryPrice - currentPrice) / entryPrice;
}

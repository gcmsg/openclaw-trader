/**
 * ROI Table Time-Decay Take-Profit
 *
 * Inspired by Freqtrade's minimal_roi design: the longer a position is held, the lower the take-profit target.
 * Strategy: Lock in profits, avoid "watching gains evaporate".
 *
 * Configuration example (strategy.yaml):
 *   minimal_roi:
 *     "0":   0.08   # Just opened: wait for 8% before exiting
 *     "60":  0.04   # Held 1h: exit at 4%
 *     "120": 0.02   # Held 2h: exit at 2%
 *     "480": 0.00   # Held 8h: break-even exit (0 = any profit triggers exit)
 */

/**
 * Find the applicable ROI threshold based on holding duration.
 *
 * @param roiTable  minimal_roi config (key = minimum holding minutes, value = minimum profit ratio)
 * @param holdMs    Current holding duration (milliseconds)
 * @returns Current stage's profit threshold (0.05 = 5%), returns null if roiTable is empty or not yet in any stage
 */
export function getMinimalRoiThreshold(
  roiTable: Record<string, number>,
  holdMs: number
): number | null {
  const holdMinutes = holdMs / 60_000;
  const keys = Object.keys(roiTable).map(Number);
  if (keys.length === 0) return null;

  // Find all keys <= current holding duration, take the largest key (most recent tier)
  const applicableKeys = keys.filter((k) => k <= holdMinutes);
  if (applicableKeys.length === 0) return null; // Not yet in the first tier

  const latestKey = Math.max(...applicableKeys);
  return roiTable[String(latestKey)] ?? null;
}

/**
 * Check whether current profit has reached the ROI Table's current stage target.
 *
 * @param roiTable      minimal_roi config
 * @param holdMs        Current holding duration (milliseconds)
 * @param profitRatio   Current profit ratio (0.05 = +5%, positive = profit)
 * @returns true = should exit (ROI triggered), false = continue holding
 */
export function checkMinimalRoi(
  roiTable: Record<string, number>,
  holdMs: number,
  profitRatio: number
): boolean {
  const threshold = getMinimalRoiThreshold(roiTable, holdMs);
  if (threshold === null) return false;
  // When threshold = 0: any positive profit triggers exit
  return profitRatio >= threshold;
}

/**
 * Format ROI Table as a human-readable string (for logs / notifications).
 *
 * @example
 * formatRoiTable({ "0": 0.08, "60": 0.04, "120": 0.02 })
 * // -> "0min->8.0%  60min->4.0%  120min->2.0%"
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
 * Calculate long position's current profit ratio (excluding fees, for ROI checks).
 * live/executor.ts already has a fee-inclusive version; this function is for paper engine's real-time tick checks.
 */
export function calcLongProfitRatio(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (currentPrice - entryPrice) / entryPrice;
}

/**
 * Calculate short position's current profit ratio (positive when entry price > current price).
 */
export function calcShortProfitRatio(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (entryPrice - currentPrice) / entryPrice;
}

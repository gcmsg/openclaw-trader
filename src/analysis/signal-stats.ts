/**
 * 信号统计分析
 *
 * 按信号条件组合（signalCombo）汇总交易记录，
 * 计算胜率、盈亏比、期望收益等核心指标。
 */

import type { TradeRecord } from "./types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface SignalStat {
  signalCombo: string; // 如 "ma_bullish+rsi_bullish+macd_bullish"
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1
  avgWinPercent: number; // 平均盈利 %
  avgLossPercent: number; // 平均亏损 %（负数）
  avgRR: number; // 平均盈亏比 = |avgWin| / |avgLoss|
  expectancy: number; // 期望收益 = winRate * avgWin + (1-winRate) * avgLoss
  avgHoldMinutes: number; // 平均持仓时间（分钟）
  profitFactor: number; // 总盈利 / |总亏损|（总亏损=0 时为 Infinity）
  bestTrade: number; // 最佳单笔 %
  worstTrade: number; // 最差单笔 %
  exitReasons: Record<string, number>; // 各出场原因计数
}

// ─────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────

/**
 * 将 signalConditions 数组转换为规范化的 combo 字符串。
 * 排序后用 "+" 连接，使顺序不同但内容相同的组合映射到同一 key。
 */
function toComboKey(conditions: string[]): string {
  if (conditions.length === 0) return "(no_signals)";
  return [...conditions].sort().join("+");
}

// ─────────────────────────────────────────────────────
// 核心 API
// ─────────────────────────────────────────────────────

/**
 * 从交易记录中统计各信号组合的表现。
 *
 * @param trades     交易记录数组
 * @param minTrades  最少交易次数才纳入统计（默认 5）
 * @returns          按期望收益降序排列的统计数组
 */
export function calcSignalStats(trades: TradeRecord[], minTrades = 5): SignalStat[] {
  if (trades.length === 0) return [];

  // 按 signalCombo 分组
  const groups = new Map<string, TradeRecord[]>();
  for (const trade of trades) {
    const key = toComboKey(trade.signalConditions);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(trade);
    } else {
      groups.set(key, [trade]);
    }
  }

  const stats: SignalStat[] = [];

  for (const [combo, group] of groups) {
    if (group.length < minTrades) continue;

    const wins = group.filter((t) => t.pnlPercent > 0);
    const losses = group.filter((t) => t.pnlPercent <= 0);

    const winRate = wins.length / group.length;

    const avgWinPercent =
      wins.length > 0
        ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length
        : 0;

    const avgLossPercent =
      losses.length > 0
        ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length
        : 0;

    // 盈亏比 = |avgWin| / |avgLoss|
    const avgRR =
      avgLossPercent !== 0 ? Math.abs(avgWinPercent) / Math.abs(avgLossPercent) : Infinity;

    // 期望收益
    const expectancy = winRate * avgWinPercent + (1 - winRate) * avgLossPercent;

    // 平均持仓时间（分钟）
    const avgHoldMinutes =
      group.reduce((s, t) => s + t.holdMs, 0) / group.length / 60_000;

    // 利润因子
    const totalWin = wins.reduce((s, t) => s + t.pnlPercent, 0);
    const totalLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPercent), 0);
    const profitFactor = totalLoss === 0 ? (totalWin > 0 ? Infinity : 1) : totalWin / totalLoss;

    // 最佳/最差单笔
    const allPnl = group.map((t) => t.pnlPercent);
    const bestTrade = Math.max(...allPnl);
    const worstTrade = Math.min(...allPnl);

    // 出场原因计数
    const exitReasons: Record<string, number> = {};
    for (const t of group) {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    }

    stats.push({
      signalCombo: combo,
      totalTrades: group.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWinPercent,
      avgLossPercent,
      avgRR,
      expectancy,
      avgHoldMinutes,
      profitFactor,
      bestTrade,
      worstTrade,
      exitReasons,
    });
  }

  // 按期望收益降序排列
  stats.sort((a, b) => b.expectancy - a.expectancy);

  return stats;
}

/**
 * 按期望收益排序，输出 Top N 和 Bottom N 信号组合。
 *
 * @param stats  calcSignalStats() 的结果（已降序排列）
 * @param topN   取前/后 N 个（默认 5）
 */
export function rankSignals(
  stats: SignalStat[],
  topN = 5
): { best: SignalStat[]; worst: SignalStat[] } {
  if (stats.length === 0) return { best: [], worst: [] };

  const sorted = [...stats].sort((a, b) => b.expectancy - a.expectancy);
  const best = sorted.slice(0, topN);
  const worst = sorted.slice(-topN).reverse();

  return { best, worst };
}

/**
 * 格式化统计结果为可读文本（Telegram / CLI 输出）。
 */
export function formatSignalStats(stats: SignalStat[]): string {
  if (stats.length === 0) {
    return "📊 **信号统计** — 暂无符合条件的信号组合数据";
  }

  const lines: string[] = ["📊 **信号组合统计**\n"];

  for (const s of stats) {
    const wr = (s.winRate * 100).toFixed(1);
    const exp = s.expectancy >= 0 ? `+${(s.expectancy * 100).toFixed(2)}%` : `${(s.expectancy * 100).toFixed(2)}%`;
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    const rr = s.avgRR === Infinity ? "∞" : s.avgRR.toFixed(2);

    lines.push(`**${s.signalCombo}**`);
    lines.push(
      `  交易: ${s.totalTrades} | 胜率: ${wr}% | 期望: ${exp}`
    );
    lines.push(
      `  均盈: +${(s.avgWinPercent * 100).toFixed(2)}% | 均亏: ${(s.avgLossPercent * 100).toFixed(2)}% | RR: ${rr}`
    );
    lines.push(
      `  利润因子: ${pf} | 持仓: ${s.avgHoldMinutes.toFixed(0)}min | 最佳: +${(s.bestTrade * 100).toFixed(2)}% | 最差: ${(s.worstTrade * 100).toFixed(2)}%`
    );

    // 出场原因汇总（仅前 3 个）
    const reasonEntries = Object.entries(s.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r}(${c})`)
      .join(" ");
    if (reasonEntries) {
      lines.push(`  出场: ${reasonEntries}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

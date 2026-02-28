/**
 * 信号归因分析（Signal Attribution）— 领域模块
 *
 * 按信号组合（triggeredRules）分组，统计各组合的历史胜率、
 * 盈亏比、期望收益等核心指标，输出归因排行榜。
 *
 * 注意：pnlPercent 存储为比例格式（0.038 = +3.8%），与
 * signal-history.ts 保持一致。展示时需 ×100。
 *
 * CLI 入口：src/scripts/signal-attribution.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 生产环境路径（scripts/signal-attribution.ts 直接使用）
export const ATTRIBUTION_HISTORY_PATH = path.resolve(
  __dirname,
  "../../logs/signal-history.jsonl"
);
export const ATTRIBUTION_REPORT_PATH = path.resolve(
  __dirname,
  "../../reports/signal-attribution.json"
);

// ─── 类型 ──────────────────────────────────────────────

export interface AttributionSignalRecord {
  id: string;
  symbol: string;
  type: "buy" | "short";
  entryPrice: number;
  entryTime: number;
  entryConditions: {
    triggeredRules?: string[];
    maShort?: number;
    maLong?: number;
    rsi?: number;
  };
  status: "open" | "closed";
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  pnl?: number;
  /** 盈亏比例（比例格式，0.038 = +3.8%，与 signal-history.ts 一致） */
  pnlPercent?: number;
  holdingHours?: number;
  scenarioId?: string;
}

export interface GroupStats {
  key: string;           // 信号组合标识（rules 排序后拼接）
  rules: string[];       // 触发的信号条件
  signalType: string;    // "buy" | "short" | "mixed"
  total: number;         // 总信号数
  closed: number;        // 已平仓数
  open: number;          // 还在持仓中
  wins: number;          // 盈利笔
  losses: number;        // 亏损笔
  winRate: number;       // 胜率（closed > 0 时有值）
  /** 平均盈亏（比例格式，×100 显示为百分比） */
  avgPnlPct: number;
  /** 平均盈利（比例格式） */
  avgWinPct: number;
  /** 平均亏损（比例格式，取绝对值） */
  avgLossPct: number;
  rrRatio: number;       // 盈亏比 = |avgWin| / |avgLoss|
  avgHoldHours: number;  // 平均持仓小时
  /** 累计盈亏（比例格式，×100 显示为百分比） */
  totalPnlPct: number;
  symbols: string[];     // 涉及币种
  stopLossCount: number; // 止损触发次数
}

// ─── 读取数据 ──────────────────────────────────────────

/**
 * 从 signal-history.jsonl 加载所有信号记录。
 * @param historyPath 可选自定义路径（默认 logs/signal-history.jsonl）
 */
export function loadAttributionHistory(
  historyPath?: string
): AttributionSignalRecord[] {
  const filePath = historyPath ?? ATTRIBUTION_HISTORY_PATH;
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  const records: AttributionSignalRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as AttributionSignalRecord);
    } catch { /* 跳过损坏行 */ }
  }
  return records;
}

// ─── 分组统计 ─────────────────────────────────────────

/**
 * 按信号组合（triggeredRules + type）分组，计算每组的统计指标。
 * 返回按累计盈亏降序排列的统计数组。
 */
export function analyzeGroups(records: AttributionSignalRecord[]): GroupStats[] {
  const groups = new Map<string, AttributionSignalRecord[]>();

  for (const rec of records) {
    const rules = (rec.entryConditions.triggeredRules ?? ["unknown"]).slice().sort();
    const key = `${rec.type}:${rules.join("+")}`;
    const existing = groups.get(key) ?? [];
    existing.push(rec);
    groups.set(key, existing);
  }

  const stats: GroupStats[] = [];

  for (const [key, recs] of groups) {
    const firstRec = recs[0];
    if (!firstRec) continue;

    const rules = (firstRec.entryConditions.triggeredRules ?? ["unknown"]).slice().sort();
    const closed = recs.filter((r) => r.status === "closed");
    const open = recs.filter((r) => r.status === "open");

    const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
    const losses = closed.filter((r) => (r.pnlPercent ?? 0) <= 0);

    const avgPnlPct = closed.length > 0
      ? closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / closed.length
      : 0;

    const avgWinPct = wins.length > 0
      ? wins.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / wins.length
      : 0;

    const avgLossPct = losses.length > 0
      ? Math.abs(losses.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / losses.length)
      : 0;

    const rrRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : 0;

    const withHours = closed.filter((r) => r.holdingHours !== undefined);
    const avgHoldHours = withHours.length > 0
      ? withHours.reduce((s, r) => s + (r.holdingHours ?? 0), 0) / withHours.length
      : 0;

    const totalPnlPct = closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);
    const symbols = [...new Set(recs.map((r) => r.symbol))];
    const stopLossCount = closed.filter((r) => r.exitReason === "stop_loss").length;

    const types = [...new Set(recs.map((r) => r.type))];
    const signalType = types.length === 1 ? (types[0] ?? "mixed") : "mixed";

    stats.push({
      key,
      rules,
      signalType,
      total: recs.length,
      closed: closed.length,
      open: open.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      avgPnlPct,
      avgWinPct,
      avgLossPct,
      rrRatio,
      avgHoldHours,
      totalPnlPct,
      symbols,
      stopLossCount,
    });
  }

  // 按累计盈亏（比例）降序排列
  return stats.sort((a, b) => b.totalPnlPct - a.totalPnlPct);
}

// ─── 报告格式化 ───────────────────────────────────────

/**
 * 格式化归因报告为可读文本。
 * pnlPercent 存储为比例（0.038 = +3.8%），展示时 ×100。
 */
export function formatAttributionReport(
  stats: GroupStats[],
  records: AttributionSignalRecord[]
): string {
  const total = records.length;
  const closed = records.filter((r) => r.status === "closed");
  const wins = closed.filter((r) => (r.pnlPercent ?? 0) > 0);
  const totalPnl = closed.reduce((s, r) => s + (r.pnlPercent ?? 0), 0);

  const lines: string[] = [
    "═".repeat(56),
    "📊 信号归因分析报告（Signal Attribution）",
    "═".repeat(56),
    `总信号数: ${total} | 已平仓: ${closed.length} | 待平仓: ${total - closed.length}`,
    `整体胜率: ${closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "--"}%`,
    // totalPnl 是比例之和，×100 转为百分比显示
    `累计盈亏: ${totalPnl >= 0 ? "+" : ""}${(totalPnl * 100).toFixed(2)}%`,
    "",
    "─".repeat(56),
    "🏆 信号组合排行榜（按累计盈亏）",
    "─".repeat(56),
  ];

  if (stats.length === 0) {
    lines.push("  （暂无数据，需要更多交易记录）");
  }

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (!s) continue;
    const rank = i + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
    // totalPnlPct 是比例，×100 转为百分比显示
    const pnlStr = `${s.totalPnlPct >= 0 ? "+" : ""}${(s.totalPnlPct * 100).toFixed(2)}%`;
    const wrStr = s.closed > 0 ? `${(s.winRate * 100).toFixed(0)}%` : "--";
    const rrStr = s.rrRatio > 0 ? s.rrRatio.toFixed(2) : "--";

    lines.push(`${medal} [${s.signalType.toUpperCase()}] ${s.rules.join(" + ")}`);
    lines.push(
      `   累计${pnlStr} | 胜率${wrStr} | R:R ${rrStr} | ${s.closed}笔平仓 | 持仓均${s.avgHoldHours.toFixed(1)}h`
    );
    if (s.stopLossCount > 0) {
      lines.push(`   ⚠ 止损 ${s.stopLossCount} 次 / ${s.closed} 笔`);
    }
    if (s.symbols.length > 0 && s.symbols.length <= 4) {
      lines.push(`   币种: ${s.symbols.join(", ")}`);
    }
    lines.push("");
  }

  // 建议
  const bestGroup = stats[0];
  const worstGroup = stats[stats.length - 1];

  if (bestGroup && worstGroup && stats.length > 1) {
    lines.push("─".repeat(56));
    lines.push("💡 Mia 归因建议");
    lines.push("─".repeat(56));
    if (bestGroup.winRate >= 0.6 && bestGroup.rrRatio >= 1.5) {
      lines.push(`✅ 强化: [${bestGroup.rules.join("+")}] — 胜率+盈亏比双优`);
    } else if (bestGroup.totalPnlPct > 0) {
      lines.push(`📌 继续观察: [${bestGroup.rules.join("+")}] — 累计盈利但样本偏少`);
    }
    if (worstGroup.totalPnlPct < -0.05 || worstGroup.winRate < 0.4) {
      lines.push(`❌ 考虑下架: [${worstGroup.rules.join("+")}] — 持续亏损或胜率低`);
    }
  }

  lines.push("═".repeat(56));
  return lines.join("\n");
}

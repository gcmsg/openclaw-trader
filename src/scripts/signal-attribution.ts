/**
 * 信号归因分析（Signal Attribution）
 *
 * 读取 logs/signal-history.jsonl，分析每种信号组合的历史表现：
 * - 胜率（盈利笔 / 已平仓笔）
 * - 平均盈亏（%）
 * - 平均持仓时长（小时）
 * - 盈亏比（avgWin / avgLoss）
 * - 在哪种 Regime 下表现最好
 *
 * 输出排行榜：告诉你该强化什么信号组合、砍掉什么
 *
 * 使用：npm run attribution
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../logs/signal-history.jsonl");
const REPORT_PATH = path.resolve(__dirname, "../../reports/signal-attribution.json");

// ─── 类型 ──────────────────────────────────────────────

interface SignalRecord {
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
  avgPnlPct: number;     // 平均盈亏%
  avgWinPct: number;     // 平均盈利%
  avgLossPct: number;    // 平均亏损%（取绝对值）
  rrRatio: number;       // 盈亏比 = avgWin / avgLoss
  avgHoldHours: number;  // 平均持仓小时
  totalPnlPct: number;   // 累计盈亏%
  symbols: string[];     // 涉及币种
  stopLossCount: number; // 止损触发次数
}

// ─── 读取数据 ──────────────────────────────────────────

export function loadSignalHistory(): SignalRecord[] {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.log(`[attribution] 未找到 ${HISTORY_PATH}，请先运行 monitor`);
    return [];
  }
  const lines = fs.readFileSync(HISTORY_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  const records: SignalRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as SignalRecord);
    } catch { /* 跳过损坏行 */ }
  }
  return records;
}

// ─── 分组统计 ─────────────────────────────────────────

export function analyzeGroups(records: SignalRecord[]): GroupStats[] {
  const groups = new Map<string, SignalRecord[]>();

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

  // 按累计盈亏排序（降序）
  return stats.sort((a, b) => b.totalPnlPct - a.totalPnlPct);
}

// ─── 报告格式化 ───────────────────────────────────────

export function formatAttributionReport(stats: GroupStats[], records: SignalRecord[]): string {
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
    if (worstGroup.totalPnlPct < -5 || worstGroup.winRate < 0.4) {
      lines.push(`❌ 考虑下架: [${worstGroup.rules.join("+")}] — 持续亏损或胜率低`);
    }
  }

  lines.push("═".repeat(56));
  return lines.join("\n");
}

// ─── 主入口 ───────────────────────────────────────────

function main(): void {
  const records = loadSignalHistory();
  console.log(`[attribution] 加载 ${records.length} 条信号记录`);

  const stats = analyzeGroups(records);
  const report = formatAttributionReport(stats, records);

  console.log("\n" + report);

  // 保存 JSON 报告
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), stats }, null, 2));
  console.log(`\n[attribution] JSON 报告已写入: ${REPORT_PATH}`);
}

main();

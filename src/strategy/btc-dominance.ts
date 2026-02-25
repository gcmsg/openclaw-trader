/**
 * BTC 主导率趋势追踪
 *
 * ## 为什么重要
 * - BTC 主导率 = BTC 市值 / 全加密市值
 * - 主导率上升 → 资金从山寨流向 BTC（"避险"）→ 山寨减仓信号
 * - 主导率下降（且 BTC 稳）→ 山寨季节 → 可加大山寨敞口
 *
 * ## 数据来源
 * - `market-analysis.ts` 每次分析后调用 `trackBtcDominance()` 追加记录
 * - 文件存储：`logs/btc-dominance-history.json`（保留 30 天）
 *
 * ## 信号
 * - 7 日趋势 > +threshold%  → `btc_dominance_rising` （山寨风险高）
 * - 7 日趋势 < -threshold%  → `btc_dominance_falling`（山寨机会）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, "../../logs/btc-dominance-history.json");
const MAX_DAYS = 30;

// ─── 类型 ──────────────────────────────────────────────

export interface DominanceRecord {
  date: string;   // 'YYYY-MM-DD'（UTC）
  dom: number;    // 百分比，如 54.3
  ts: number;     // 记录时间戳（ms）
}

export interface DominanceTrend {
  latest: number;          // 最新主导率
  oldest: number;          // N 天前主导率（可能为 NaN 若数据不足）
  change: number;          // 变化量（latest - oldest）
  days: number;            // 实际跨越天数
  direction: "rising" | "falling" | "neutral";
  records: DominanceRecord[];
}

// ─── 文件 IO ──────────────────────────────────────────

function loadHistory(): DominanceRecord[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as DominanceRecord[];
  } catch {
    return [];
  }
}

function saveHistory(records: DominanceRecord[]): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(records, null, 2));
}

// ─── 公共 API ─────────────────────────────────────────

/**
 * 追加一条主导率记录（每日一条，同日重复则覆盖最新）
 */
export function trackBtcDominance(dom: number): void {
  const records = loadHistory();
  const today = new Date().toISOString().slice(0, 10); // UTC date
  const now = Date.now();

  // 移除同日旧记录（用最新覆盖，保留日内最后一次分析）
  const filtered = records.filter((r) => r.date !== today);
  filtered.push({ date: today, dom, ts: now });

  // 按日期排序，只保留最近 MAX_DAYS 天
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  saveHistory(filtered.slice(-MAX_DAYS));
}

/**
 * 计算 BTC 主导率趋势
 * @param windowDays 分析窗口（默认 7 天）
 * @param neutralThreshold 判定"上升/下降"的最小变化量（默认 0.5%）
 */
export function getBtcDominanceTrend(
  windowDays = 7,
  neutralThreshold = 0.5
): DominanceTrend {
  const records = loadHistory();

  if (records.length === 0) {
    return { latest: NaN, oldest: NaN, change: 0, days: 0, direction: "neutral", records: [] };
  }

  const latest = records.at(-1);
  if (!latest) return { latest: NaN, oldest: NaN, change: 0, days: 0, direction: "neutral", records: [] };
  const cutoffDate = new Date(latest.date);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - windowDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // 最接近 windowDays 前的记录
  const windowRecords = records.filter((r) => r.date >= cutoff);
  const oldest = windowRecords[0] ?? latest;

  const latestDom = latest.dom;
  const oldestDom = oldest.dom;
  const change = latestDom - oldestDom;
  const daySpan = windowRecords.length;

  let direction: DominanceTrend["direction"] = "neutral";
  if (change > neutralThreshold) direction = "rising";
  else if (change < -neutralThreshold) direction = "falling";

  return {
    latest: latestDom,
    oldest: oldestDom,
    change,
    days: daySpan,
    direction,
    records: windowRecords,
  };
}

/**
 * 获取最新一条主导率记录（无记录返回 undefined）
 */
export function getLatestDominance(): DominanceRecord | undefined {
  const records = loadHistory();
  return records[records.length - 1];
}

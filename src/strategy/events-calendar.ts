/**
 * P6.5 — 宏观事件日历 + 风险控制
 *
 * 在重要宏观事件（Fed 会议、CPI、期权到期、ETF 审批）前后，
 * 自动调整仓位限制，避免事件驱动的异常波动。
 *
 * 风险窗口：
 *   pre:    事件前 24h         → positionRatioMultiplier: 0.5
 *   during: 事件前 2h ~ 事件后 2h → positionRatioMultiplier: 0  （暂停开仓）
 *   post:   事件后 2h ~ 事件后 6h → positionRatioMultiplier: 0.7
 *   none:   无风险窗口          → positionRatioMultiplier: 1.0
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CALENDAR_PATH = path.resolve(__dirname, "../data/economic-calendar.json");

// ─── 类型定义 ──────────────────────────────────────────

export interface EconomicEvent {
  id: string;
  name: string;
  date: string;         // YYYY-MM-DD
  time?: string;        // HH:MM UTC（可选，缺省为 00:00）
  impact: "high" | "medium" | "low";
  category: "fed" | "cpi" | "options_expiry" | "etf" | "other";
  description?: string;
}

export interface EventRiskState {
  active: boolean;
  eventName: string;
  phase: "pre" | "during" | "post" | "none";
  positionRatioMultiplier: number; // pre: 0.5, during: 0, post: 0.7, none: 1.0
  expiresAt: number;               // 当前窗口到期时间（Unix ms）
}

// ─── 窗口常量（ms）──────────────────────────────────────

const PRE_WINDOW_MS    = 24 * 60 * 60 * 1000; // 24h
const DURING_START_MS  =  2 * 60 * 60 * 1000; // 事件前 2h
const DURING_END_MS    =  2 * 60 * 60 * 1000; // 事件后 2h
const POST_END_MS      =  6 * 60 * 60 * 1000; // 事件后 6h

// ─── 加载日历 ──────────────────────────────────────────

/**
 * 从 JSON 文件加载事件日历
 * @param calendarPath 可选自定义路径，默认读取内置文件
 */
export function loadCalendar(calendarPath?: string): EconomicEvent[] {
  const filePath = calendarPath ?? DEFAULT_CALENDAR_PATH;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as EconomicEvent[];
  } catch {
    return [];
  }
}

// ─── 核心风险检查 ──────────────────────────────────────────

/**
 * 将事件的 date + time（UTC）转换为 Unix ms 时间戳
 */
export function eventToTimestampMs(event: EconomicEvent): number {
  const timeStr = event.time ?? "00:00";
  const [hourStr, minStr] = timeStr.split(":") as [string, string];
  const hour = parseInt(hourStr, 10) || 0;
  const min  = parseInt(minStr, 10)  || 0;

  // 解析 date（YYYY-MM-DD），在 UTC 时间设置时分
  const [yearStr, monthStr, dayStr] = event.date.split("-") as [string, string, string];
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1; // Date months are 0-indexed
  const day   = parseInt(dayStr, 10);

  return Date.UTC(year, month, day, hour, min, 0, 0);
}

/**
 * 检查当前时间是否处于任意事件的风险窗口
 * 返回最高优先级的风险状态（during > pre > post > none）
 * 优先匹配 high impact 事件
 */
export function checkEventRisk(
  events: EconomicEvent[],
  now?: Date
): EventRiskState {
  const nowMs = (now ?? new Date()).getTime();

  // 按优先级排序：during > pre > post（先找最近的高危状态）
  const candidates: { state: EventRiskState; priority: number }[] = [];

  for (const event of events) {
    const eventMs = eventToTimestampMs(event);
    const diff = nowMs - eventMs; // 正值 = 事件已过

    // "during" 窗口：事件前 2h 到事件后 2h
    if (diff >= -DURING_START_MS && diff <= DURING_END_MS) {
      const expiresAt = eventMs + DURING_END_MS;
      candidates.push({
        state: {
          active: true,
          eventName: event.name,
          phase: "during",
          positionRatioMultiplier: 0,
          expiresAt,
        },
        priority: 3,
      });
      continue; // during 是最高优先级，仍收集其他事件
    }

    // "post" 窗口：事件后 2h 到事件后 6h
    if (diff > DURING_END_MS && diff <= POST_END_MS) {
      const expiresAt = eventMs + POST_END_MS;
      candidates.push({
        state: {
          active: true,
          eventName: event.name,
          phase: "post",
          positionRatioMultiplier: 0.7,
          expiresAt,
        },
        priority: 1,
      });
      continue;
    }

    // "pre" 窗口：事件前 24h 到事件前 2h
    if (diff < -DURING_START_MS && diff >= -PRE_WINDOW_MS) {
      const expiresAt = eventMs - DURING_START_MS; // pre 窗口到 during 开始时结束
      candidates.push({
        state: {
          active: true,
          eventName: event.name,
          phase: "pre",
          positionRatioMultiplier: 0.5,
          expiresAt,
        },
        priority: 2,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      active: false,
      eventName: "",
      phase: "none",
      positionRatioMultiplier: 1.0,
      expiresAt: 0,
    };
  }

  // 返回优先级最高的（during=3 > pre=2 > post=1）
  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0];
  if (!best) {
    return {
      active: false,
      eventName: "",
      phase: "none",
      positionRatioMultiplier: 1.0,
      expiresAt: 0,
    };
  }
  return best.state;
}

// ─── 工具函数 ──────────────────────────────────────────

/**
 * 获取未来 N 天内的事件列表
 * @param events 全量事件
 * @param days 未来天数，默认 7
 */
export function getUpcomingEvents(events: EconomicEvent[], days = 7): EconomicEvent[] {
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => {
      const ts = eventToTimestampMs(event);
      return ts >= now && ts <= now + windowMs;
    })
    .sort((a, b) => eventToTimestampMs(a) - eventToTimestampMs(b));
}

// ─── 格式化报告 ──────────────────────────────────────────

const IMPACT_EMOJI: Record<string, string> = {
  high:   "🔴",
  medium: "🟡",
  low:    "🟢",
};

const CATEGORY_EMOJI: Record<string, string> = {
  fed:             "🏦",
  cpi:             "📈",
  options_expiry:  "📋",
  etf:             "🏢",
  other:           "📅",
};

export function formatEventReport(state: EventRiskState, upcoming: EconomicEvent[]): string {
  const lines: string[] = [];

  // 当前风险状态
  if (state.active && state.phase !== "none") {
    const phaseLabel = {
      during: "⛔ 事件窗口期（暂停开仓）",
      pre:    "⚠️ 事件前哨期（缩减仓位 50%）",
      post:   "⚡ 事件后消化期（缩减仓位 30%）",
      none:   "",
    }[state.phase];

    lines.push(`🗓️ **宏观事件风险状态**`);
    lines.push(phaseLabel);
    lines.push(`→ ${state.eventName}`);
    lines.push(`→ 仓位系数: ×${state.positionRatioMultiplier.toFixed(1)}`);
    if (state.expiresAt > 0) {
      const expiresIn = Math.round((state.expiresAt - Date.now()) / 60000);
      if (expiresIn > 0) {
        lines.push(`→ 窗口剩余: ${expiresIn} 分钟`);
      }
    }
  } else {
    lines.push(`🗓️ **宏观事件风险** ✅ 当前无活跃风险窗口`);
  }

  // 即将到来的事件
  if (upcoming.length > 0) {
    lines.push(`\n📋 **未来 7 天事件**`);
    for (const event of upcoming.slice(0, 5)) {
      const impactEmoji = IMPACT_EMOJI[event.impact] ?? "⚪";
      const catEmoji = CATEGORY_EMOJI[event.category] ?? "📅";
      const timeStr = event.time ? ` ${event.time} UTC` : "";
      lines.push(`${impactEmoji} ${catEmoji} ${event.date}${timeStr} — ${event.name}`);
    }
    if (upcoming.length > 5) {
      lines.push(`...及另外 ${upcoming.length - 5} 个事件`);
    }
  } else {
    lines.push("\n✅ 未来 7 天无重要事件");
  }

  return lines.join("\n");
}

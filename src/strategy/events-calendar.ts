/**
 * P6.5 — Macro Event Calendar + Risk Control
 *
 * Automatically adjust position limits around major macro events
 * (Fed meetings, CPI, options expiry, ETF approvals) to avoid event-driven abnormal volatility.
 *
 * Risk windows:
 *   pre:    24h before event       -> positionRatioMultiplier: 0.5
 *   during: 2h before ~ 2h after   -> positionRatioMultiplier: 0  (pause opening positions)
 *   post:   2h after ~ 6h after    -> positionRatioMultiplier: 0.7
 *   none:   no risk window          -> positionRatioMultiplier: 1.0
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CALENDAR_PATH = path.resolve(__dirname, "../data/economic-calendar.json");

// ─── Type Definitions ──────────────────────────────────────────

export interface EconomicEvent {
  id: string;
  name: string;
  date: string;         // YYYY-MM-DD
  time?: string;        // HH:MM UTC (optional, defaults to 00:00)
  impact: "high" | "medium" | "low";
  category: "fed" | "cpi" | "options_expiry" | "etf" | "other";
  description?: string;
}

export interface EventRiskState {
  active: boolean;
  eventName: string;
  phase: "pre" | "during" | "post" | "none";
  positionRatioMultiplier: number; // pre: 0.5, during: 0, post: 0.7, none: 1.0
  expiresAt: number;               // Current window expiry time (Unix ms)
}

// ─── Window Constants (ms) ──────────────────────────────────────

const PRE_WINDOW_MS    = 24 * 60 * 60 * 1000; // 24h
const DURING_START_MS  =  2 * 60 * 60 * 1000; // 2h before event
const DURING_END_MS    =  2 * 60 * 60 * 1000; // 2h after event
const POST_END_MS      =  6 * 60 * 60 * 1000; // 6h after event

// ─── Load Calendar ──────────────────────────────────────────

/**
 * Load event calendar from JSON file
 * @param calendarPath Optional custom path, defaults to built-in file
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

// ─── Core Risk Check ──────────────────────────────────────────

/**
 * Convert event date + time (UTC) to Unix ms timestamp
 */
export function eventToTimestampMs(event: EconomicEvent): number {
  const timeStr = event.time ?? "00:00";
  const [hourStr, minStr] = timeStr.split(":") as [string, string];
  const hour = parseInt(hourStr, 10) || 0;
  const min  = parseInt(minStr, 10)  || 0;

  // Parse date (YYYY-MM-DD), set hour and minute in UTC
  const [yearStr, monthStr, dayStr] = event.date.split("-") as [string, string, string];
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1; // Date months are 0-indexed
  const day   = parseInt(dayStr, 10);

  return Date.UTC(year, month, day, hour, min, 0, 0);
}

/**
 * Check if current time falls within any event's risk window.
 * Returns the highest priority risk state (during > pre > post > none).
 * Prioritizes high impact events.
 */
export function checkEventRisk(
  events: EconomicEvent[],
  now?: Date
): EventRiskState {
  const nowMs = (now ?? new Date()).getTime();

  // Sort by priority: during > pre > post (find the most critical state first)
  const candidates: { state: EventRiskState; priority: number }[] = [];

  for (const event of events) {
    const eventMs = eventToTimestampMs(event);
    const diff = nowMs - eventMs; // Positive = event has passed

    // "during" window: 2h before to 2h after event
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
      continue; // during is highest priority, still collect other events
    }

    // "post" window: 2h to 6h after event
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

    // "pre" window: 24h to 2h before event
    if (diff < -DURING_START_MS && diff >= -PRE_WINDOW_MS) {
      const expiresAt = eventMs - DURING_START_MS; // pre window ends when during starts
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

  // Return the highest priority (during=3 > pre=2 > post=1)
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

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Get list of events within the next N days
 * @param events All events
 * @param days Number of days ahead, default 7
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

// ─── Format Report ──────────────────────────────────────────

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

  // Current risk state
  if (state.active && state.phase !== "none") {
    const phaseLabel = {
      during: "⛔ Event window (positions paused)",
      pre:    "⚠️ Pre-event period (positions reduced 50%)",
      post:   "⚡ Post-event digestion (positions reduced 30%)",
      none:   "",
    }[state.phase];

    lines.push(`🗓️ **Macro Event Risk Status**`);
    lines.push(phaseLabel);
    lines.push(`→ ${state.eventName}`);
    lines.push(`→ Position multiplier: ×${state.positionRatioMultiplier.toFixed(1)}`);
    if (state.expiresAt > 0) {
      const expiresIn = Math.round((state.expiresAt - Date.now()) / 60000);
      if (expiresIn > 0) {
        lines.push(`→ Window remaining: ${expiresIn} min`);
      }
    }
  } else {
    lines.push(`🗓️ **Macro Event Risk** ✅ No active risk window`);
  }

  // Upcoming events
  if (upcoming.length > 0) {
    lines.push(`\n📋 **Events in Next 7 Days**`);
    for (const event of upcoming.slice(0, 5)) {
      const impactEmoji = IMPACT_EMOJI[event.impact] ?? "⚪";
      const catEmoji = CATEGORY_EMOJI[event.category] ?? "📅";
      const timeStr = event.time ? ` ${event.time} UTC` : "";
      lines.push(`${impactEmoji} ${catEmoji} ${event.date}${timeStr} — ${event.name}`);
    }
    if (upcoming.length > 5) {
      lines.push(`...and ${upcoming.length - 5} more events`);
    }
  } else {
    lines.push("\n✅ No significant events in the next 7 days");
  }

  return lines.join("\n");
}

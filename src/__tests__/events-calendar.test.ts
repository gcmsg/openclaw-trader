/**
 * P6.5 — 宏观事件日历测试
 *
 * 覆盖：loadCalendar、checkEventRisk (各 phase)、getUpcomingEvents、
 *       positionRatioMultiplier 值、边界条件、formatEventReport
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadCalendar,
  checkEventRisk,
  getUpcomingEvents,
  formatEventReport,
  eventToTimestampMs,
} from "../strategy/events-calendar.js";
import type { EconomicEvent, EventRiskState } from "../strategy/events-calendar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 工具 helpers ──────────────────────────────────────

/** 创建相对于 now 偏移指定毫秒的事件（time=00:00 UTC，date 计算到天） */
function makeEventAtOffset(offsetMs: number, overrides: Partial<EconomicEvent> = {}): EconomicEvent {
  const ts = Date.now() + offsetMs;
  const d = new Date(ts);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return {
    id: "test-event",
    name: "Test Event",
    date,
    time,
    impact: "high",
    category: "fed",
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── loadCalendar 测试 ──────────────────────────────────────

describe("loadCalendar", () => {
  it("从内置 JSON 加载事件列表", () => {
    const calendarPath = path.resolve(__dirname, "../data/economic-calendar.json");
    const events = loadCalendar(calendarPath);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("每个事件包含必需字段", () => {
    const calendarPath = path.resolve(__dirname, "../data/economic-calendar.json");
    const events = loadCalendar(calendarPath);
    for (const event of events) {
      expect(event.id).toBeTruthy();
      expect(event.name).toBeTruthy();
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["high", "medium", "low"]).toContain(event.impact);
      expect(["fed", "cpi", "options_expiry", "etf", "other"]).toContain(event.category);
    }
  });

  it("内置日历至少有 20 个事件", () => {
    const calendarPath = path.resolve(__dirname, "../data/economic-calendar.json");
    const events = loadCalendar(calendarPath);
    expect(events.length).toBeGreaterThanOrEqual(20);
  });

  it("文件不存在时返回空数组", () => {
    const events = loadCalendar("/nonexistent/path/calendar.json");
    expect(events).toEqual([]);
  });
});

// ─── checkEventRisk - phase 判断 ──────────────────────────────────────

describe("checkEventRisk - none phase", () => {
  it("无事件时返回 none", () => {
    const state = checkEventRisk([]);
    expect(state.phase).toBe("none");
    expect(state.active).toBe(false);
    expect(state.positionRatioMultiplier).toBe(1.0);
  });

  it("事件超过 24h 后返回 none", () => {
    const event = makeEventAtOffset(-25 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("none");
    expect(state.positionRatioMultiplier).toBe(1.0);
  });

  it("事件超过 24h 前（未进入窗口）返回 none", () => {
    const event = makeEventAtOffset(25 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("none");
  });
});

describe("checkEventRisk - pre phase", () => {
  it("事件前 12h 处于 pre 窗口", () => {
    const event = makeEventAtOffset(12 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("pre");
    expect(state.active).toBe(true);
    expect(state.positionRatioMultiplier).toBe(0.5);
  });

  it("事件前 23h 处于 pre 窗口", () => {
    const event = makeEventAtOffset(23 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("pre");
    expect(state.positionRatioMultiplier).toBe(0.5);
  });

  it("pre phase 的 eventName 正确", () => {
    const event = makeEventAtOffset(10 * HOUR, { name: "Fed 利率决议" });
    const state = checkEventRisk([event]);
    expect(state.eventName).toBe("Fed 利率决议");
  });
});

describe("checkEventRisk - during phase", () => {
  it("事件前 1h 处于 during 窗口", () => {
    const event = makeEventAtOffset(1 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("事件正在发生时（offset=0）处于 during 窗口", () => {
    const event = makeEventAtOffset(0);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("事件后 1h 处于 during 窗口", () => {
    const event = makeEventAtOffset(-1 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("during 窗口内 active=true", () => {
    const event = makeEventAtOffset(0);
    const state = checkEventRisk([event]);
    expect(state.active).toBe(true);
  });
});

describe("checkEventRisk - post phase", () => {
  it("事件后 3h 处于 post 窗口", () => {
    const event = makeEventAtOffset(-3 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("post");
    expect(state.positionRatioMultiplier).toBe(0.7);
  });

  it("事件后 5h 处于 post 窗口", () => {
    const event = makeEventAtOffset(-5 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("post");
    expect(state.positionRatioMultiplier).toBe(0.7);
  });
});

describe("checkEventRisk - 边界条件", () => {
  it("多个事件时 during 优先于 pre", () => {
    const duringEvent = makeEventAtOffset(0, { name: "During Event" });
    const preEvent    = makeEventAtOffset(12 * HOUR, { name: "Pre Event" });
    const state = checkEventRisk([preEvent, duringEvent]);
    expect(state.phase).toBe("during");
    expect(state.eventName).toBe("During Event");
  });

  it("多个 pre 事件时返回其中一个（不报错）", () => {
    const event1 = makeEventAtOffset(5 * HOUR, { name: "Event A" });
    const event2 = makeEventAtOffset(10 * HOUR, { name: "Event B" });
    const state = checkEventRisk([event1, event2]);
    expect(state.phase).toBe("pre");
    expect(state.active).toBe(true);
  });
});

// ─── getUpcomingEvents 测试 ──────────────────────────────────────

describe("getUpcomingEvents", () => {
  it("过滤过去的事件", () => {
    const past   = makeEventAtOffset(-2 * DAY, { id: "past" });
    const future = makeEventAtOffset(2 * DAY, { id: "future" });
    const result = getUpcomingEvents([past, future]);
    expect(result.some((e) => e.id === "past")).toBe(false);
    expect(result.some((e) => e.id === "future")).toBe(true);
  });

  it("默认 7 天窗口过滤超出范围的事件", () => {
    const near = makeEventAtOffset(3 * DAY, { id: "near" });
    const far  = makeEventAtOffset(10 * DAY, { id: "far" });
    const result = getUpcomingEvents([near, far]);
    expect(result.some((e) => e.id === "near")).toBe(true);
    expect(result.some((e) => e.id === "far")).toBe(false);
  });

  it("自定义 days 参数", () => {
    const event14d = makeEventAtOffset(13 * DAY, { id: "d14" });
    const result = getUpcomingEvents([event14d], 14);
    expect(result.some((e) => e.id === "d14")).toBe(true);
  });

  it("按时间升序排列", () => {
    const e1 = makeEventAtOffset(5 * DAY, { id: "e5d" });
    const e2 = makeEventAtOffset(2 * DAY, { id: "e2d" });
    const result = getUpcomingEvents([e1, e2]);
    if (result.length >= 2) {
      const ts0 = eventToTimestampMs(result[0]!);
      const ts1 = eventToTimestampMs(result[1]!);
      expect(ts0).toBeLessThanOrEqual(ts1);
    }
  });

  it("无事件时返回空数组", () => {
    expect(getUpcomingEvents([])).toEqual([]);
  });
});

// ─── formatEventReport 测试 ──────────────────────────────────────

describe("formatEventReport", () => {
  const noneState: EventRiskState = {
    active: false,
    eventName: "",
    phase: "none",
    positionRatioMultiplier: 1.0,
    expiresAt: 0,
  };

  it("none 状态输出包含无活跃风险", () => {
    const report = formatEventReport(noneState, []);
    expect(report).toContain("无活跃风险");
  });

  it("during 状态输出包含暂停开仓", () => {
    const state: EventRiskState = {
      active: true,
      eventName: "Fed 利率决议",
      phase: "during",
      positionRatioMultiplier: 0,
      expiresAt: Date.now() + HOUR,
    };
    const report = formatEventReport(state, []);
    expect(report).toContain("暂停开仓");
    expect(report).toContain("Fed 利率决议");
  });

  it("upcoming 事件列表展示", () => {
    const upcoming: EconomicEvent[] = [
      { id: "e1", name: "CPI 公布", date: "2026-03-12", impact: "high", category: "cpi" },
    ];
    const report = formatEventReport(noneState, upcoming);
    expect(report).toContain("CPI 公布");
  });
});

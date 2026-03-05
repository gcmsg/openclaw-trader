/**
 * P6.5 — Macroeconomic event calendar tests
 *
 * Covers: loadCalendar, checkEventRisk (each phase), getUpcomingEvents,
 *         positionRatioMultiplier values, boundary conditions, formatEventReport
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

// ─── Utility helpers ──────────────────────────────────────

/** Create an event offset by the specified milliseconds from now (time=00:00 UTC, date calculated to day) */
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

// ─── loadCalendar tests ──────────────────────────────────────

describe("loadCalendar", () => {
  it("loads event list from built-in JSON", () => {
    const calendarPath = path.resolve(__dirname, "../data/economic-calendar.json");
    const events = loadCalendar(calendarPath);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("each event contains required fields", () => {
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

  it("built-in calendar has at least 20 events", () => {
    const calendarPath = path.resolve(__dirname, "../data/economic-calendar.json");
    const events = loadCalendar(calendarPath);
    expect(events.length).toBeGreaterThanOrEqual(20);
  });

  it("returns empty array when file does not exist", () => {
    const events = loadCalendar("/nonexistent/path/calendar.json");
    expect(events).toEqual([]);
  });
});

// ─── checkEventRisk - phase determination ──────────────────────────────────────

describe("checkEventRisk - none phase", () => {
  it("returns none when no events", () => {
    const state = checkEventRisk([]);
    expect(state.phase).toBe("none");
    expect(state.active).toBe(false);
    expect(state.positionRatioMultiplier).toBe(1.0);
  });

  it("returns none when event is more than 24h ago", () => {
    const event = makeEventAtOffset(-25 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("none");
    expect(state.positionRatioMultiplier).toBe(1.0);
  });

  it("returns none when event is more than 24h in the future (not in window)", () => {
    const event = makeEventAtOffset(25 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("none");
  });
});

describe("checkEventRisk - pre phase", () => {
  it("12h before event is in pre window", () => {
    const event = makeEventAtOffset(12 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("pre");
    expect(state.active).toBe(true);
    expect(state.positionRatioMultiplier).toBe(0.5);
  });

  it("23h before event is in pre window", () => {
    const event = makeEventAtOffset(23 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("pre");
    expect(state.positionRatioMultiplier).toBe(0.5);
  });

  it("pre phase eventName is correct", () => {
    const event = makeEventAtOffset(10 * HOUR, { name: "Fed Rate Decision" });
    const state = checkEventRisk([event]);
    expect(state.eventName).toBe("Fed Rate Decision");
  });
});

describe("checkEventRisk - during phase", () => {
  it("1h before event is in during window", () => {
    const event = makeEventAtOffset(1 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("event happening right now (offset=0) is in during window", () => {
    const event = makeEventAtOffset(0);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("1h after event is in during window", () => {
    const event = makeEventAtOffset(-1 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("during");
    expect(state.positionRatioMultiplier).toBe(0);
  });

  it("active=true within during window", () => {
    const event = makeEventAtOffset(0);
    const state = checkEventRisk([event]);
    expect(state.active).toBe(true);
  });
});

describe("checkEventRisk - post phase", () => {
  it("3h after event is in post window", () => {
    const event = makeEventAtOffset(-3 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("post");
    expect(state.positionRatioMultiplier).toBe(0.7);
  });

  it("5h after event is in post window", () => {
    const event = makeEventAtOffset(-5 * HOUR);
    const state = checkEventRisk([event]);
    expect(state.phase).toBe("post");
    expect(state.positionRatioMultiplier).toBe(0.7);
  });
});

describe("checkEventRisk - boundary conditions", () => {
  it("multiple events: during takes priority over pre", () => {
    const duringEvent = makeEventAtOffset(0, { name: "During Event" });
    const preEvent    = makeEventAtOffset(12 * HOUR, { name: "Pre Event" });
    const state = checkEventRisk([preEvent, duringEvent]);
    expect(state.phase).toBe("during");
    expect(state.eventName).toBe("During Event");
  });

  it("multiple pre events: returns one of them (no error)", () => {
    const event1 = makeEventAtOffset(5 * HOUR, { name: "Event A" });
    const event2 = makeEventAtOffset(10 * HOUR, { name: "Event B" });
    const state = checkEventRisk([event1, event2]);
    expect(state.phase).toBe("pre");
    expect(state.active).toBe(true);
  });
});

// ─── getUpcomingEvents tests ──────────────────────────────────────

describe("getUpcomingEvents", () => {
  it("filters past events", () => {
    const past   = makeEventAtOffset(-2 * DAY, { id: "past" });
    const future = makeEventAtOffset(2 * DAY, { id: "future" });
    const result = getUpcomingEvents([past, future]);
    expect(result.some((e) => e.id === "past")).toBe(false);
    expect(result.some((e) => e.id === "future")).toBe(true);
  });

  it("default 7-day window filters events beyond range", () => {
    const near = makeEventAtOffset(3 * DAY, { id: "near" });
    const far  = makeEventAtOffset(10 * DAY, { id: "far" });
    const result = getUpcomingEvents([near, far]);
    expect(result.some((e) => e.id === "near")).toBe(true);
    expect(result.some((e) => e.id === "far")).toBe(false);
  });

  it("custom days parameter", () => {
    const event14d = makeEventAtOffset(13 * DAY, { id: "d14" });
    const result = getUpcomingEvents([event14d], 14);
    expect(result.some((e) => e.id === "d14")).toBe(true);
  });

  it("sorted by time ascending", () => {
    const e1 = makeEventAtOffset(5 * DAY, { id: "e5d" });
    const e2 = makeEventAtOffset(2 * DAY, { id: "e2d" });
    const result = getUpcomingEvents([e1, e2]);
    if (result.length >= 2) {
      const ts0 = eventToTimestampMs(result[0]!);
      const ts1 = eventToTimestampMs(result[1]!);
      expect(ts0).toBeLessThanOrEqual(ts1);
    }
  });

  it("returns empty array when no events", () => {
    expect(getUpcomingEvents([])).toEqual([]);
  });
});

// ─── formatEventReport tests ──────────────────────────────────────

describe("formatEventReport", () => {
  const noneState: EventRiskState = {
    active: false,
    eventName: "",
    phase: "none",
    positionRatioMultiplier: 1.0,
    expiresAt: 0,
  };

  it("none state output contains no active risk", () => {
    const report = formatEventReport(noneState, []);
    expect(report).toContain("No active risk");
  });

  it("during state output contains halt opening", () => {
    const state: EventRiskState = {
      active: true,
      eventName: "Fed Rate Decision",
      phase: "during",
      positionRatioMultiplier: 0,
      expiresAt: Date.now() + HOUR,
    };
    const report = formatEventReport(state, []);
    expect(report).toContain("positions paused");
    expect(report).toContain("Fed Rate Decision");
  });

  it("upcoming events list display", () => {
    const upcoming: EconomicEvent[] = [
      { id: "e1", name: "CPI Release", date: "2026-03-12", impact: "high", category: "cpi" },
    ];
    const report = formatEventReport(noneState, upcoming);
    expect(report).toContain("CPI Release");
  });
});

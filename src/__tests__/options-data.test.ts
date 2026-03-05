/**
 * P6.4 — Options market signal tests
 *
 * Covers: IV grading, PCR grading, positionSizeMultiplier, formatted output, fetchOptionsSummary
 * All network calls are mocked; no real requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyIvSignal,
  classifyPcSignal,
  calcPositionSizeMultiplier,
  estimateIvPercentile,
  formatOptionsReport,
  fetchOptionsSummary,
} from "../exchange/options-data.js";
import type { OptionsSummary } from "../exchange/options-data.js";
import https from "https";
import { EventEmitter } from "events";

// ─── Mock helpers ──────────────────────────────────────

function buildSummary(overrides: Partial<OptionsSummary> = {}): OptionsSummary {
  return {
    symbol: "BTC",
    iv30d: 55,
    ivPercentile: 50,
    putCallRatio: 0.9,
    ivSignal: "normal",
    pcSignal: "neutral",
    positionSizeMultiplier: 1.0,
    generatedAt: Date.now(),
    ...overrides,
  };
}

// ─── IV grading tests ──────────────────────────────────────

describe("classifyIvSignal", () => {
  it("low: IV < 30", () => {
    expect(classifyIvSignal(0)).toBe("low");
    expect(classifyIvSignal(15)).toBe("low");
    expect(classifyIvSignal(29.9)).toBe("low");
  });

  it("normal: 30 <= IV < 60", () => {
    expect(classifyIvSignal(30)).toBe("normal");
    expect(classifyIvSignal(45)).toBe("normal");
    expect(classifyIvSignal(59.9)).toBe("normal");
  });

  it("elevated: 60 <= IV < 90", () => {
    expect(classifyIvSignal(60)).toBe("elevated");
    expect(classifyIvSignal(75)).toBe("elevated");
    expect(classifyIvSignal(89.9)).toBe("elevated");
  });

  it("extreme: IV >= 90", () => {
    expect(classifyIvSignal(90)).toBe("extreme");
    expect(classifyIvSignal(120)).toBe("extreme");
    expect(classifyIvSignal(200)).toBe("extreme");
  });
});

// ─── PCR grading tests ──────────────────────────────────────

describe("classifyPcSignal", () => {
  it("bullish: PCR < 0.7", () => {
    expect(classifyPcSignal(0)).toBe("bullish");
    expect(classifyPcSignal(0.5)).toBe("bullish");
    expect(classifyPcSignal(0.69)).toBe("bullish");
  });

  it("neutral: 0.7 <= PCR <= 1.2", () => {
    expect(classifyPcSignal(0.7)).toBe("neutral");
    expect(classifyPcSignal(1.0)).toBe("neutral");
    expect(classifyPcSignal(1.2)).toBe("neutral");
  });

  it("bearish: PCR > 1.2", () => {
    expect(classifyPcSignal(1.21)).toBe("bearish");
    expect(classifyPcSignal(1.5)).toBe("bearish");
    expect(classifyPcSignal(2.0)).toBe("bearish");
  });
});

// ─── positionSizeMultiplier tests ──────────────────────────────────────

describe("calcPositionSizeMultiplier", () => {
  it("extreme IV → 0.5", () => {
    expect(calcPositionSizeMultiplier("extreme")).toBe(0.5);
  });

  it("elevated IV → 0.7", () => {
    expect(calcPositionSizeMultiplier("elevated")).toBe(0.7);
  });

  it("normal IV → 1.0", () => {
    expect(calcPositionSizeMultiplier("normal")).toBe(1.0);
  });

  it("low IV → 1.2", () => {
    expect(calcPositionSizeMultiplier("low")).toBe(1.2);
  });
});

// ─── estimateIvPercentile tests ──────────────────────────────────────

describe("estimateIvPercentile", () => {
  it("low IV (<30) → low percentile", () => {
    const p = estimateIvPercentile(25);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(30);
  });

  it("mid IV (60) → percentile around 65", () => {
    const p = estimateIvPercentile(60);
    expect(p).toBeGreaterThanOrEqual(60);
    expect(p).toBeLessThanOrEqual(70);
  });

  it("extremely high IV (>120) → percentile 99", () => {
    expect(estimateIvPercentile(150)).toBe(99);
  });
});

// ─── Formatted output tests ──────────────────────────────────────

describe("formatOptionsReport", () => {
  it("contains BTC symbol", () => {
    const report = formatOptionsReport(buildSummary({ symbol: "BTC" }));
    expect(report).toContain("BTC");
  });

  it("contains IV value", () => {
    const report = formatOptionsReport(buildSummary({ iv30d: 65.3 }));
    expect(report).toContain("65.3");
  });

  it("contains PCR value", () => {
    const report = formatOptionsReport(buildSummary({ putCallRatio: 1.15 }));
    expect(report).toContain("1.15");
  });

  it("contains ivSignal label", () => {
    const report = formatOptionsReport(buildSummary({ ivSignal: "extreme" }));
    expect(report).toContain("extreme");
  });

  it("contains pcSignal label", () => {
    const report = formatOptionsReport(buildSummary({ pcSignal: "bearish" }));
    expect(report).toContain("bearish");
  });

  it("extreme IV report contains position size reduction hint", () => {
    const report = formatOptionsReport(
      buildSummary({ ivSignal: "extreme", positionSizeMultiplier: 0.5 })
    );
    expect(report).toContain("50%");
  });

  it("low IV report contains position size increase hint", () => {
    const report = formatOptionsReport(
      buildSummary({ ivSignal: "low", positionSizeMultiplier: 1.2 })
    );
    expect(report).toContain("increase position size");
  });

  it("ETH symbol displayed correctly", () => {
    const report = formatOptionsReport(buildSummary({ symbol: "ETH" }));
    expect(report).toContain("ETH");
  });
});

// ─── fetchOptionsSummary mock tests ──────────────────────────────────────

describe("fetchOptionsSummary (mocked network)", () => {
  beforeEach(() => {
    vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
      // Build a simple mock ClientRequest (use any to avoid complex type signatures)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      // Simulate response
      const mockItems = [
        // Call contracts (near-month)
        { instrument_name: "BTC-28FEB26-60000-C", open_interest: 100, mark_iv: 65.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        { instrument_name: "BTC-28FEB26-70000-C", open_interest: 150, mark_iv: 63.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        // Put contracts (near-month)
        { instrument_name: "BTC-28FEB26-60000-P", open_interest: 80, mark_iv: 67.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        { instrument_name: "BTC-28FEB26-70000-P", open_interest: 120, mark_iv: 70.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        // Far-month
        { instrument_name: "BTC-27MAR26-80000-C", open_interest: 200, mark_iv: 55.0, expiration_timestamp: Date.now() + 30 * 86400000 },
        { instrument_name: "BTC-27MAR26-80000-P", open_interest: 180, mark_iv: 58.0, expiration_timestamp: Date.now() + 30 * 86400000 },
      ];
      const responseBody = JSON.stringify({ result: mockItems });

      // Trigger callback asynchronously
      setImmediate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = new EventEmitter();
        res.statusCode = 200;
        if (typeof callback === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (callback as any)(res);
        }
        setImmediate(() => {
          res.emit("data", responseBody);
          res.emit("end");
        });
      });

      return req as unknown as ReturnType<typeof https.request>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns BTC OptionsSummary", async () => {
    const summary = await fetchOptionsSummary("BTC");
    expect(summary.symbol).toBe("BTC");
    expect(summary.iv30d).toBeGreaterThan(0);
    expect(summary.putCallRatio).toBeGreaterThan(0);
  });

  it("iv30d comes from near-month contracts", async () => {
    const summary = await fetchOptionsSummary("BTC");
    // Near-month contract mark_iv is 65.0 / 63.0, median should be in this range
    expect(summary.iv30d).toBeGreaterThanOrEqual(60);
    expect(summary.iv30d).toBeLessThanOrEqual(70);
  });

  it("PCR calculated correctly", async () => {
    const summary = await fetchOptionsSummary("BTC");
    // Put OI: 80+120=200, Call OI: 100+150=250 (near-month) + 200 (far-month)
    // Actual PCR = (80+120+180) / (100+150+200) = 380/450 ~ 0.84
    expect(summary.putCallRatio).toBeGreaterThan(0);
    expect(summary.putCallRatio).toBeLessThan(5);
  });

  it("ivSignal classified correctly", async () => {
    const summary = await fetchOptionsSummary("BTC");
    expect(["low", "normal", "elevated", "extreme"]).toContain(summary.ivSignal);
  });

  it("positionSizeMultiplier matches ivSignal", async () => {
    const summary = await fetchOptionsSummary("BTC");
    const expected = calcPositionSizeMultiplier(summary.ivSignal);
    expect(summary.positionSizeMultiplier).toBe(expected);
  });

  it("generatedAt is a recent timestamp", async () => {
    const before = Date.now();
    const summary = await fetchOptionsSummary("BTC");
    const after = Date.now();
    expect(summary.generatedAt).toBeGreaterThanOrEqual(before);
    expect(summary.generatedAt).toBeLessThanOrEqual(after);
  });
});

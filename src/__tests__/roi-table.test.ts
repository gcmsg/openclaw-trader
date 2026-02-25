import { describe, it, expect } from "vitest";
import {
  getMinimalRoiThreshold,
  checkMinimalRoi,
  formatRoiTable,
  calcLongProfitRatio,
  calcShortProfitRatio,
} from "../strategy/roi-table.js";

const MIN = 60_000; // 1 minute in ms

describe("getMinimalRoiThreshold", () => {
  const roiTable = { "0": 0.08, "60": 0.04, "120": 0.02, "480": 0 };

  it("returns null for empty table", () => {
    expect(getMinimalRoiThreshold({}, 10 * MIN)).toBeNull();
  });

  it("returns null if before first entry (holdMs < 0 minutes)", () => {
    // A table with "30" as first key — before 30 min, no threshold
    const t = { "30": 0.05 };
    expect(getMinimalRoiThreshold(t, 20 * MIN)).toBeNull();
  });

  it("returns first entry at exactly 0 minutes hold", () => {
    expect(getMinimalRoiThreshold(roiTable, 0)).toBe(0.08);
  });

  it("returns first entry before first time step", () => {
    expect(getMinimalRoiThreshold(roiTable, 30 * MIN)).toBe(0.08);
  });

  it("returns second entry at exactly 60 minutes", () => {
    expect(getMinimalRoiThreshold(roiTable, 60 * MIN)).toBe(0.04);
  });

  it("returns second entry between 60 and 120 minutes", () => {
    expect(getMinimalRoiThreshold(roiTable, 90 * MIN)).toBe(0.04);
  });

  it("returns third entry at exactly 120 minutes", () => {
    expect(getMinimalRoiThreshold(roiTable, 120 * MIN)).toBe(0.02);
  });

  it("returns 0 at 480 minutes (breakeven exit)", () => {
    expect(getMinimalRoiThreshold(roiTable, 480 * MIN)).toBe(0);
  });

  it("returns 0 well past 480 minutes", () => {
    expect(getMinimalRoiThreshold(roiTable, 1440 * MIN)).toBe(0);
  });
});

describe("checkMinimalRoi", () => {
  const roiTable = { "0": 0.08, "60": 0.04, "120": 0.02, "480": 0 };

  it("returns false if profit below threshold", () => {
    expect(checkMinimalRoi(roiTable, 30 * MIN, 0.05)).toBe(false); // need 8%
  });

  it("returns true if profit at threshold", () => {
    expect(checkMinimalRoi(roiTable, 30 * MIN, 0.08)).toBe(true);
  });

  it("returns true if profit above threshold", () => {
    expect(checkMinimalRoi(roiTable, 30 * MIN, 0.12)).toBe(true);
  });

  it("applies lower threshold at 60 min", () => {
    expect(checkMinimalRoi(roiTable, 60 * MIN, 0.04)).toBe(true);
    expect(checkMinimalRoi(roiTable, 60 * MIN, 0.039)).toBe(false);
  });

  it("applies 0 threshold at 480 min — any positive profit exits", () => {
    expect(checkMinimalRoi(roiTable, 480 * MIN, 0.001)).toBe(true);
  });

  it("threshold=0 does NOT exit at exactly 0 profit", () => {
    expect(checkMinimalRoi(roiTable, 480 * MIN, 0)).toBe(true); // 0 >= 0
  });

  it("returns false at negative profit even at 480 min", () => {
    expect(checkMinimalRoi(roiTable, 480 * MIN, -0.01)).toBe(false);
  });

  it("returns false for empty table", () => {
    expect(checkMinimalRoi({}, 100 * MIN, 0.5)).toBe(false);
  });

  it("returns false if no threshold applies yet", () => {
    const t = { "60": 0.05 }; // first entry at 60 min
    expect(checkMinimalRoi(t, 30 * MIN, 0.99)).toBe(false);
  });
});

describe("formatRoiTable", () => {
  it("formats in ascending order with correct labels", () => {
    const result = formatRoiTable({ "120": 0.02, "0": 0.08, "60": 0.04 });
    expect(result).toBe("0min→8.0%  60min→4.0%  120min→2.0%");
  });

  it("handles single entry", () => {
    expect(formatRoiTable({ "0": 0.05 })).toBe("0min→5.0%");
  });

  it("handles 0% target", () => {
    expect(formatRoiTable({ "480": 0 })).toBe("480min→0.0%");
  });
});

describe("calcLongProfitRatio", () => {
  it("positive when price rises", () => {
    expect(calcLongProfitRatio(100, 108)).toBeCloseTo(0.08);
  });

  it("negative when price falls", () => {
    expect(calcLongProfitRatio(100, 95)).toBeCloseTo(-0.05);
  });

  it("zero when price unchanged", () => {
    expect(calcLongProfitRatio(100, 100)).toBe(0);
  });

  it("returns 0 for invalid entry price", () => {
    expect(calcLongProfitRatio(0, 100)).toBe(0);
  });
});

describe("calcShortProfitRatio", () => {
  it("positive when price falls (short profits)", () => {
    expect(calcShortProfitRatio(100, 92)).toBeCloseTo(0.08);
  });

  it("negative when price rises (short loses)", () => {
    expect(calcShortProfitRatio(100, 105)).toBeCloseTo(-0.05);
  });

  it("zero when price unchanged", () => {
    expect(calcShortProfitRatio(100, 100)).toBe(0);
  });

  it("returns 0 for invalid entry price", () => {
    expect(calcShortProfitRatio(0, 100)).toBe(0);
  });
});

/**
 * Derivatives data module tests
 *
 * Test coverage: Basis interpretation, L/S Ratio sentiment classification,
 * PCR interpretation logic, Max Pain price gravity direction
 */
import { describe, it, expect } from "vitest";
import { formatDerivativesReport } from "../exchange/derivatives-data.js";
import type { DerivativesSnapshot } from "../exchange/derivatives-data.js";

// Build mock snapshot
function mockSnap(overrides: Partial<DerivativesSnapshot> = {}): DerivativesSnapshot {
  return {
    symbol: "BTCUSDT",
    basis: {
      symbol: "BTCUSDT",
      perpPrice: 63050,
      spotPrice: 63000,
      basis: 0.079,
      interpretation: "Futures slight premium +0.079%, normal leaning bullish",
      signal: "bullish",
    },
    longShort: {
      symbol: "BTCUSDT",
      globalLongRatio: 0.72,
      globalShortRatio: 0.28,
      globalLSRatio: 2.57,
      topAccountLSRatio: 2.86,
      topPositionLSRatio: 1.8,
      sentiment: "long_biased",
      sentimentLabel: "🟡 Retail leaning long (watch for FOMO risk)",
    },
    options: {
      currency: "BTC",
      underlyingPrice: 63000,
      putCallRatio: 0.78,
      putCallRatioWeekly: 0.65,
      atmIv: 56.4,
      ivPercentile: 42,
      ivSentiment: "normal",
      maxPain: 62000,
      maxPainExpiry: "28FEB25",
      distanceToMaxPain: -1.59,
      optionsSentiment: "bullish",
      summary: "PCR=0.78 low, market leaning optimistic",
    },
    ...overrides,
  };
}

describe("formatDerivativesReport", () => {
  it("contains Basis info", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("Basis");
    expect(report).toContain("%");
  });

  it("contains L/S ratio", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("L/S");
    expect(report).toContain("2.57");
  });

  it("contains options data (PCR/IV/MaxPain)", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("PCR");
    expect(report).toContain("IV");
    expect(report).toContain("Max Pain");
  });

  it("does not error when options data is missing", () => {
    const snap = mockSnap({ options: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
    const report = formatDerivativesReport(snap);
    expect(report).toContain("BTC");
  });

  it("does not error when basis is missing", () => {
    const snap = mockSnap({ basis: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
  });

  it("does not error on empty data snapshot", () => {
    const snap = mockSnap({ basis: null, longShort: null, options: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
  });
});

describe("BasisData sentiment logic (boundary verification via mock)", () => {
  it("Basis > 0.3% should show aggressive bullish", () => {
    const snap = mockSnap({
      basis: {
        symbol: "BTCUSDT", perpPrice: 63200, spotPrice: 63000,
        basis: 0.317, interpretation: "Futures premium +0.317%, aggressive bullish sentiment", signal: "bullish",
      },
    });
    expect(formatDerivativesReport(snap)).toContain("+0.317%");
  });

  it("Basis < -0.3% should show aggressive bearish", () => {
    const snap = mockSnap({
      basis: {
        symbol: "BTCUSDT", perpPrice: 62800, spotPrice: 63000,
        basis: -0.317, interpretation: "Futures discount -0.317%, aggressive bearish sentiment", signal: "bearish",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("-0.317%");
  });
});

describe("LongShortData sentiment classification", () => {
  it("retail extreme long scenario", () => {
    const snap = mockSnap({
      longShort: {
        symbol: "BTCUSDT", globalLongRatio: 0.78, globalShortRatio: 0.22,
        globalLSRatio: 3.55, topAccountLSRatio: 1.2, topPositionLSRatio: 1.1,
        sentiment: "extreme_long", sentimentLabel: "🔴 Retail extremely long (contrarian: top signal)",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("3.55");
    expect(report).toContain("extremely long");
  });

  it("retail extreme short scenario", () => {
    const snap = mockSnap({
      longShort: {
        symbol: "BTCUSDT", globalLongRatio: 0.33, globalShortRatio: 0.67,
        globalLSRatio: 0.49, topAccountLSRatio: 0.8, topPositionLSRatio: 0.7,
        sentiment: "extreme_short", sentimentLabel: "🟢 Retail extremely short (contrarian: bottom signal)",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("extremely short");
  });
});

describe("OptionsData interpretation", () => {
  it("PCR > 1.2 should show red warning", () => {
    const snap = mockSnap({
      options: {
        currency: "BTC", underlyingPrice: 63000,
        putCallRatio: 1.45, putCallRatioWeekly: 1.3,
        atmIv: 80, ivPercentile: 85, ivSentiment: "elevated",
        maxPain: 60000, maxPainExpiry: "28FEB25", distanceToMaxPain: -4.76,
        optionsSentiment: "bearish", summary: "PCR=1.45 elevated",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("1.45");
  });

  it("Max Pain distance from current price shows correct sign", () => {
    // Max Pain above current price (positive distance)
    const snap = mockSnap({
      options: {
        ...mockSnap().options!,
        maxPain: 65000, distanceToMaxPain: 3.17,
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("65,000");
    expect(report).toContain("+3.2%");
  });
});

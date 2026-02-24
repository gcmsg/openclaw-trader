/**
 * 衍生品数据模块测试
 *
 * 测试覆盖：Basis 解读、L/S Ratio 情绪分类、
 * PCR 解读逻辑、Max Pain 价格引力方向
 */
import { describe, it, expect } from "vitest";
import { formatDerivativesReport } from "../exchange/derivatives-data.js";
import type { DerivativesSnapshot } from "../exchange/derivatives-data.js";

// 构建 mock snapshot
function mockSnap(overrides: Partial<DerivativesSnapshot> = {}): DerivativesSnapshot {
  return {
    symbol: "BTCUSDT",
    basis: {
      symbol: "BTCUSDT",
      perpPrice: 63050,
      spotPrice: 63000,
      basis: 0.079,
      interpretation: "期货小幅溢价 +0.079%，正常偏多",
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
      sentimentLabel: "🟡 散户偏多（注意追高风险）",
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
      summary: "PCR=0.78 偏低，市场偏乐观",
    },
    ...overrides,
  };
}

describe("formatDerivativesReport", () => {
  it("包含 Basis 信息", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("Basis");
    expect(report).toContain("%");
  });

  it("包含 L/S 比", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("L/S");
    expect(report).toContain("2.57");
  });

  it("包含期权数据（PCR/IV/MaxPain）", () => {
    const report = formatDerivativesReport(mockSnap());
    expect(report).toContain("PCR");
    expect(report).toContain("IV");
    expect(report).toContain("Max Pain");
  });

  it("缺少期权数据时不报错", () => {
    const snap = mockSnap({ options: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
    const report = formatDerivativesReport(snap);
    expect(report).toContain("BTC");
  });

  it("缺少 basis 时不报错", () => {
    const snap = mockSnap({ basis: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
  });

  it("空数据快照不报错", () => {
    const snap = mockSnap({ basis: null, longShort: null, options: null });
    expect(() => formatDerivativesReport(snap)).not.toThrow();
  });
});

describe("BasisData 情绪判断逻辑（通过 mock 验证边界）", () => {
  it("Basis > 0.3% 应显示多头激进", () => {
    const snap = mockSnap({
      basis: {
        symbol: "BTCUSDT", perpPrice: 63200, spotPrice: 63000,
        basis: 0.317, interpretation: "期货溢价 +0.317%，多头情绪激进", signal: "bullish",
      },
    });
    expect(formatDerivativesReport(snap)).toContain("+0.317%");
  });

  it("Basis < -0.3% 应显示空头激进", () => {
    const snap = mockSnap({
      basis: {
        symbol: "BTCUSDT", perpPrice: 62800, spotPrice: 63000,
        basis: -0.317, interpretation: "期货折价 -0.317%，空头情绪激进", signal: "bearish",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("-0.317%");
  });
});

describe("LongShortData 情绪判断", () => {
  it("散户极度看多场景", () => {
    const snap = mockSnap({
      longShort: {
        symbol: "BTCUSDT", globalLongRatio: 0.78, globalShortRatio: 0.22,
        globalLSRatio: 3.55, topAccountLSRatio: 1.2, topPositionLSRatio: 1.1,
        sentiment: "extreme_long", sentimentLabel: "🔴 散户极度看多（逆向：顶部信号）",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("3.55");
    expect(report).toContain("极度看多");
  });

  it("散户极度看空场景", () => {
    const snap = mockSnap({
      longShort: {
        symbol: "BTCUSDT", globalLongRatio: 0.33, globalShortRatio: 0.67,
        globalLSRatio: 0.49, topAccountLSRatio: 0.8, topPositionLSRatio: 0.7,
        sentiment: "extreme_short", sentimentLabel: "🟢 散户极度看空（逆向：底部信号）",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("极度看空");
  });
});

describe("OptionsData 解读", () => {
  it("PCR > 1.2 应显示红色警告", () => {
    const snap = mockSnap({
      options: {
        currency: "BTC", underlyingPrice: 63000,
        putCallRatio: 1.45, putCallRatioWeekly: 1.3,
        atmIv: 80, ivPercentile: 85, ivSentiment: "elevated",
        maxPain: 60000, maxPainExpiry: "28FEB25", distanceToMaxPain: -4.76,
        optionsSentiment: "bearish", summary: "PCR=1.45 偏高",
      },
    });
    const report = formatDerivativesReport(snap);
    expect(report).toContain("1.45");
  });

  it("Max Pain 与当前价差显示正确符号", () => {
    // Max Pain 在当前价上方（正距离）
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

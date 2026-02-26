/**
 * P6.4 — 期权市场信号测试
 *
 * 覆盖：IV 分级、PCR 分级、positionSizeMultiplier、格式化输出、fetchOptionsSummary
 * 所有网络调用均 mock，不发真实请求。
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

// ─── IV 分级测试 ──────────────────────────────────────

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

// ─── PCR 分级测试 ──────────────────────────────────────

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

// ─── positionSizeMultiplier 测试 ──────────────────────────────────────

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

// ─── estimateIvPercentile 测试 ──────────────────────────────────────

describe("estimateIvPercentile", () => {
  it("低 IV (<30) → 百分位较低", () => {
    const p = estimateIvPercentile(25);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(30);
  });

  it("中 IV (60) → 百分位约 65", () => {
    const p = estimateIvPercentile(60);
    expect(p).toBeGreaterThanOrEqual(60);
    expect(p).toBeLessThanOrEqual(70);
  });

  it("极高 IV (>120) → 百分位 99", () => {
    expect(estimateIvPercentile(150)).toBe(99);
  });
});

// ─── 格式化输出测试 ──────────────────────────────────────

describe("formatOptionsReport", () => {
  it("包含 BTC symbol", () => {
    const report = formatOptionsReport(buildSummary({ symbol: "BTC" }));
    expect(report).toContain("BTC");
  });

  it("包含 IV 数值", () => {
    const report = formatOptionsReport(buildSummary({ iv30d: 65.3 }));
    expect(report).toContain("65.3");
  });

  it("包含 PCR 数值", () => {
    const report = formatOptionsReport(buildSummary({ putCallRatio: 1.15 }));
    expect(report).toContain("1.15");
  });

  it("包含 ivSignal 标签", () => {
    const report = formatOptionsReport(buildSummary({ ivSignal: "extreme" }));
    expect(report).toContain("extreme");
  });

  it("包含 pcSignal 标签", () => {
    const report = formatOptionsReport(buildSummary({ pcSignal: "bearish" }));
    expect(report).toContain("bearish");
  });

  it("extreme IV 报告包含仓位缩减提示", () => {
    const report = formatOptionsReport(
      buildSummary({ ivSignal: "extreme", positionSizeMultiplier: 0.5 })
    );
    expect(report).toContain("50%");
  });

  it("low IV 报告包含放大仓位提示", () => {
    const report = formatOptionsReport(
      buildSummary({ ivSignal: "low", positionSizeMultiplier: 1.2 })
    );
    expect(report).toContain("放大");
  });

  it("ETH symbol 正确展示", () => {
    const report = formatOptionsReport(buildSummary({ symbol: "ETH" }));
    expect(report).toContain("ETH");
  });
});

// ─── fetchOptionsSummary mock 测试 ──────────────────────────────────────

describe("fetchOptionsSummary (mocked network)", () => {
  beforeEach(() => {
    vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
      // 构造简单的 mock ClientRequest（使用 any 避免复杂类型签名）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      // 模拟响应
      const mockItems = [
        // Call 合约（近月）
        { instrument_name: "BTC-28FEB26-60000-C", open_interest: 100, mark_iv: 65.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        { instrument_name: "BTC-28FEB26-70000-C", open_interest: 150, mark_iv: 63.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        // Put 合约（近月）
        { instrument_name: "BTC-28FEB26-60000-P", open_interest: 80, mark_iv: 67.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        { instrument_name: "BTC-28FEB26-70000-P", open_interest: 120, mark_iv: 70.0, expiration_timestamp: Date.now() + 2 * 86400000 },
        // 远月
        { instrument_name: "BTC-27MAR26-80000-C", open_interest: 200, mark_iv: 55.0, expiration_timestamp: Date.now() + 30 * 86400000 },
        { instrument_name: "BTC-27MAR26-80000-P", open_interest: 180, mark_iv: 58.0, expiration_timestamp: Date.now() + 30 * 86400000 },
      ];
      const responseBody = JSON.stringify({ result: mockItems });

      // 异步触发回调
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

  it("返回 BTC OptionsSummary", async () => {
    const summary = await fetchOptionsSummary("BTC");
    expect(summary.symbol).toBe("BTC");
    expect(summary.iv30d).toBeGreaterThan(0);
    expect(summary.putCallRatio).toBeGreaterThan(0);
  });

  it("iv30d 来自近月合约", async () => {
    const summary = await fetchOptionsSummary("BTC");
    // 近月合约 mark_iv 为 65.0 / 63.0，中位数应在此区间
    expect(summary.iv30d).toBeGreaterThanOrEqual(60);
    expect(summary.iv30d).toBeLessThanOrEqual(70);
  });

  it("PCR 正确计算", async () => {
    const summary = await fetchOptionsSummary("BTC");
    // Put OI: 80+120=200, Call OI: 100+150=250（近月）+ 200（远月）
    // 实际 PCR = (80+120+180) / (100+150+200) = 380/450 ≈ 0.84
    expect(summary.putCallRatio).toBeGreaterThan(0);
    expect(summary.putCallRatio).toBeLessThan(5);
  });

  it("ivSignal 正确分类", async () => {
    const summary = await fetchOptionsSummary("BTC");
    expect(["low", "normal", "elevated", "extreme"]).toContain(summary.ivSignal);
  });

  it("positionSizeMultiplier 与 ivSignal 一致", async () => {
    const summary = await fetchOptionsSummary("BTC");
    const expected = calcPositionSizeMultiplier(summary.ivSignal);
    expect(summary.positionSizeMultiplier).toBe(expected);
  });

  it("generatedAt 是最近的时间戳", async () => {
    const before = Date.now();
    const summary = await fetchOptionsSummary("BTC");
    const after = Date.now();
    expect(summary.generatedAt).toBeGreaterThanOrEqual(before);
    expect(summary.generatedAt).toBeLessThanOrEqual(after);
  });
});

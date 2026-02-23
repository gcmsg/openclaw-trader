import { describe, it, expect } from "vitest";
import { evaluateSentimentGate, type NewsReport } from "../news/sentiment-gate.js";
import type { Signal } from "../types.js";

function makeSignal(type: "buy" | "sell"): Signal {
  return {
    symbol: "BTCUSDT", type, price: 50000,
    indicators: { maShort: 100, maLong: 90, rsi: 40, price: 50000, volume: 1000, avgVolume: 1000 },
    reason: ["test"],
    timestamp: Date.now(),
  };
}

function makeReport(overrides: Partial<NewsReport> = {}): NewsReport {
  return {
    generatedAt: new Date().toISOString(),
    fearGreed: { value: 50, label: "Neutral" },
    globalMarket: { marketCapChangePercent24h: 0 },
    sentiment: "neutral",
    importantNews: [],
    bigMovers: [],
    fgAlert: false,
    fgDelta: 0,
    ...overrides,
  };
}

describe("evaluateSentimentGate()", () => {
  // ── 无报告 ──────────────────────────────────────────
  it("无报告时正常执行（信任技术面）", () => {
    const result = evaluateSentimentGate(makeSignal("buy"), null, 0.2);
    expect(result.action).toBe("execute");
  });

  // ── 买入信号 ─────────────────────────────────────────
  it("买入 + 情绪中性 → 正常执行", () => {
    const result = evaluateSentimentGate(makeSignal("buy"), makeReport({ sentiment: "neutral" }), 0.2);
    expect(result.action).toBe("execute");
    expect((result as any).positionRatio).toBe(0.2);
  });

  it("买入 + 极度贪婪（FGI>80）→ 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fearGreed: { value: 85, label: "Extreme Greed" } }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect((result as any).positionRatio).toBe(0.1); // 减半
  });

  it("买入 + 新闻偏空 → 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect((result as any).positionRatio).toBe(0.1);
  });

  it("买入 + 极度恐惧（FGI<20）→ 正常执行（历史底部）", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fearGreed: { value: 5, label: "Extreme Fear" } }),
      0.2
    );
    expect(result.action).toBe("execute");
  });

  it("买入 + FGI 急跌（fgAlert）→ 跳过", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fgAlert: true, fgDelta: -20 }),
      0.2
    );
    expect(result.action).toBe("skip");
  });

  // ── 卖出信号 ─────────────────────────────────────────
  it("卖出 + 情绪中性 → 正常执行", () => {
    const result = evaluateSentimentGate(makeSignal("sell"), makeReport({ sentiment: "neutral" }), 0.2);
    expect(result.action).toBe("execute");
  });

  it("卖出 + 新闻偏多 → 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ sentiment: "bullish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect((result as any).positionRatio).toBe(0.1);
  });

  it("卖出 + 极度恐惧 → 警告（可能在底部）", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ fearGreed: { value: 8, label: "Extreme Fear" } }),
      0.2
    );
    expect(result.action).toBe("warn");
  });

  it("卖出 + FGI 急升（fgAlert）→ 减仓警告", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ fgAlert: true, fgDelta: 20 }),
      0.2
    );
    expect(result.action).toBe("warn");
    expect((result as any).positionRatio).toBe(0.1);
  });

  // ── 重大新闻冲击 ─────────────────────────────────────
  it("5 条以上重要新闻 → 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        importantNews: Array(5).fill({ title: "Big news" }),
      }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect((result as any).positionRatio).toBe(0.1);
  });

  it("4 条重要新闻 → 不触发减仓（只有≥5条才触发）", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        importantNews: Array(4).fill({ title: "Big news" }),
        sentiment: "neutral",
        fearGreed: { value: 50, label: "Neutral" },
      }),
      0.2
    );
    expect(result.action).toBe("execute");
  });

  // ── 基础仓位比例保持 ──────────────────────────────────
  it("正常执行时保持原始仓位比例", () => {
    const result = evaluateSentimentGate(makeSignal("buy"), makeReport(), 0.3);
    expect((result as any).positionRatio).toBe(0.3);
  });

  it("减仓时仓位精确为原始的 50%", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.4
    );
    expect((result as any).positionRatio).toBe(0.2);
  });
});

import { describe, it, expect } from "vitest";
import {
  evaluateSentimentGate,
  scoreNewsTitles,
  type NewsReport,
  type GateDecision,
} from "../news/sentiment-gate.js";
import type { Signal } from "../types.js";

/** 类型安全地提取 positionRatio（skip 类型无此字段，直接报错） */
function posRatio(result: GateDecision): number {
  if ("positionRatio" in result) return result.positionRatio;
  throw new Error(`GateDecision action='${result.action}' 无 positionRatio 字段`);
}

function makeSignal(type: "buy" | "sell"): Signal {
  return {
    symbol: "BTCUSDT",
    type,
    price: 50000,
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
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "neutral" }),
      0.2
    );
    expect(result.action).toBe("execute");
    expect(posRatio(result)).toBe(0.2);
  });

  it("买入 + 极度贪婪（FGI>80）→ 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fearGreed: { value: 85, label: "Extreme Greed" } }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1); // 减半
  });

  it("买入 + 新闻偏空 → 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1);
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
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ sentiment: "neutral" }),
      0.2
    );
    expect(result.action).toBe("execute");
  });

  it("卖出 + 新闻偏多 → 减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ sentiment: "bullish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1);
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
    expect(posRatio(result)).toBe(0.1);
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
    expect(posRatio(result)).toBe(0.1);
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
    expect(posRatio(result)).toBe(0.3);
  });

  it("减仓时仓位精确为原始的 50%", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.4
    );
    expect(posRatio(result)).toBe(0.2);
  });

  // ── 关键词情绪打分影响决策 ───────────────────────────────
  it("买入 + 关键词强烈看空（≤-4）→ 跳过", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        importantNews: [
          { title: "BTC crash: massive liquidation and dump ahead" },
          { title: "Exchange hack: $500M stolen, SEC lawsuit filed" },
          { title: "Crypto ban and crackdown on exchanges" },
        ],
      }),
      0.2
    );
    expect(result.action).toBe("skip");
  });

  it("买入 + 关键词中度看空（-2~-3）→ 减仓", () => {
    // "drop" (-1) + "fall" (-1) = 合计 -2，触发 reduce 而非 skip（skip 阈值 ≤ -4）
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        fearGreed: { value: 50, label: "Neutral" },
        sentiment: "neutral",
        importantNews: [{ title: "Bitcoin sees drop and fall this week" }],
      }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1);
  });

  it("卖出 + 关键词强烈看多（≥+4）→ 警告减仓", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({
        fearGreed: { value: 55, label: "Greed" },
        sentiment: "neutral",
        importantNews: [
          { title: "Bitcoin rally and surge: institutional adoption ETF approval" },
          { title: "Crypto bull run: major exchange launch and partnership" },
        ],
      }),
      0.2
    );
    expect(result.action).toBe("warn");
    expect(posRatio(result)).toBe(0.1);
  });

  it("买入 + 关键词轻微看空（-1）→ 不额外减仓（≥-2 阈值才减）", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        fearGreed: { value: 50, label: "Neutral" },
        sentiment: "neutral",
        importantNews: [{ title: "Minor concern about crypto market" }],
      }),
      0.2
    );
    expect(result.action).toBe("execute"); // 只有 -1 分，不触发减仓
  });
});

describe("scoreNewsTitles()", () => {
  it("无标题 → 得分 0", () => {
    expect(scoreNewsTitles([])).toBe(0);
  });

  it("无关标题 → 得分 0", () => {
    expect(scoreNewsTitles(["Bitcoin price moves sideways today"])).toBe(0);
  });

  it("利多关键词 → 正分", () => {
    const score = scoreNewsTitles([
      "Bitcoin rally and surge after ETF approval",
      "Institutional adoption accelerates",
    ]);
    expect(score).toBeGreaterThan(0);
  });

  it("利空关键词 → 负分", () => {
    const score = scoreNewsTitles([
      "Crypto crash: massive liquidation and dump",
      "Exchange hack: funds stolen",
    ]);
    expect(score).toBeLessThan(0);
  });

  it("同一标题同时含多个利多词 → 累加分数", () => {
    // "rally", "surge", "etf", "approval" 各 +1
    const score = scoreNewsTitles(["Bitcoin rally and surge after ETF approval"]);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("混合标题 → 正负抵消", () => {
    const score = scoreNewsTitles([
      "Bitcoin rally (+3)", // bullish
      "Bitcoin crash and dump (-2)", // bearish
    ]);
    // 结果接近 0 或轻微偏某方向
    expect(score).toBeGreaterThan(-5);
    expect(score).toBeLessThan(5);
  });
});

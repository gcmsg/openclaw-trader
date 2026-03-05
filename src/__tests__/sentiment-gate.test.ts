import { describe, it, expect } from "vitest";
import {
  evaluateSentimentGate,
  scoreNewsTitles,
  type NewsReport,
  type GateDecision,
} from "../news/sentiment-gate.js";
import type { Signal } from "../types.js";

/** Type-safe extraction of positionRatio (skip type has no such field, throw error directly) */
function posRatio(result: GateDecision): number {
  if ("positionRatio" in result) return result.positionRatio;
  throw new Error(`GateDecision action='${result.action}' has no positionRatio field`);
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
  // ── No report ──────────────────────────────────────────
  it("executes normally when no report (trust technicals)", () => {
    const result = evaluateSentimentGate(makeSignal("buy"), null, 0.2);
    expect(result.action).toBe("execute");
  });

  // ── Buy signal ─────────────────────────────────────────
  it("buy + neutral sentiment → execute normally", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "neutral" }),
      0.2
    );
    expect(result.action).toBe("execute");
    expect(posRatio(result)).toBe(0.2);
  });

  it("buy + extreme greed (FGI>80) → reduce size", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fearGreed: { value: 85, label: "Extreme Greed" } }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1); // halved
  });

  it("buy + bearish news → reduce size", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1);
  });

  it("buy + extreme fear (FGI<20) → execute normally (historical bottom)", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fearGreed: { value: 5, label: "Extreme Fear" } }),
      0.2
    );
    expect(result.action).toBe("execute");
  });

  it("buy + FGI sharp drop (fgAlert) → skip", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ fgAlert: true, fgDelta: -20 }),
      0.2
    );
    expect(result.action).toBe("skip");
  });

  // ── Sell signal ─────────────────────────────────────────
  it("sell + neutral sentiment → execute normally", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ sentiment: "neutral" }),
      0.2
    );
    expect(result.action).toBe("execute");
  });

  it("sell + bullish news → reduce size", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ sentiment: "bullish" }),
      0.2
    );
    expect(result.action).toBe("reduce");
    expect(posRatio(result)).toBe(0.1);
  });

  it("sell + extreme fear → warn (possibly at bottom)", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ fearGreed: { value: 8, label: "Extreme Fear" } }),
      0.2
    );
    expect(result.action).toBe("warn");
  });

  it("sell + FGI sharp rise (fgAlert) → reduce with warning", () => {
    const result = evaluateSentimentGate(
      makeSignal("sell"),
      makeReport({ fgAlert: true, fgDelta: 20 }),
      0.2
    );
    expect(result.action).toBe("warn");
    expect(posRatio(result)).toBe(0.1);
  });

  // ── Major news impact ─────────────────────────────────────
  it("more than 5 important news → reduce size", () => {
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

  it("4 important news → does not trigger reduce (only >=5 triggers)", () => {
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

  // ── Base position ratio preservation ──────────────────────────────────
  it("preserves original position ratio on normal execution", () => {
    const result = evaluateSentimentGate(makeSignal("buy"), makeReport(), 0.3);
    expect(posRatio(result)).toBe(0.3);
  });

  it("position is exactly 50% of original when reducing", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({ sentiment: "bearish" }),
      0.4
    );
    expect(posRatio(result)).toBe(0.2);
  });

  // ── Keyword sentiment scoring affects decisions ───────────────────────────────
  it("buy + strongly bearish keywords (score <= -4) → skip", () => {
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

  it("buy + moderately bearish keywords (-2~-3) → reduce size", () => {
    // "drop" (-1) + "fall" (-1) = total -2, triggers reduce not skip (skip threshold <= -4)
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

  it("sell + strongly bullish keywords (score >= +4) → warn with reduce", () => {
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

  it("buy + slightly bearish keywords (-1) → no extra reduce (threshold >= -2 to reduce)", () => {
    const result = evaluateSentimentGate(
      makeSignal("buy"),
      makeReport({
        fearGreed: { value: 50, label: "Neutral" },
        sentiment: "neutral",
        importantNews: [{ title: "Minor concern about crypto market" }],
      }),
      0.2
    );
    expect(result.action).toBe("execute"); // only -1 score, does not trigger reduce
  });
});

describe("scoreNewsTitles()", () => {
  it("no titles → score 0", () => {
    expect(scoreNewsTitles([])).toBe(0);
  });

  it("irrelevant titles → score 0", () => {
    expect(scoreNewsTitles(["Bitcoin price moves sideways today"])).toBe(0);
  });

  it("bullish keywords → positive score", () => {
    const score = scoreNewsTitles([
      "Bitcoin rally and surge after ETF approval",
      "Institutional adoption accelerates",
    ]);
    expect(score).toBeGreaterThan(0);
  });

  it("bearish keywords → negative score", () => {
    const score = scoreNewsTitles([
      "Crypto crash: massive liquidation and dump",
      "Exchange hack: funds stolen",
    ]);
    expect(score).toBeLessThan(0);
  });

  it("single title with multiple bullish keywords → cumulative score", () => {
    // "rally", "surge", "etf", "approval" each +1
    const score = scoreNewsTitles(["Bitcoin rally and surge after ETF approval"]);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("mixed titles → positive and negative cancel out", () => {
    const score = scoreNewsTitles([
      "Bitcoin rally (+3)", // bullish
      "Bitcoin crash and dump (-2)", // bearish
    ]);
    // result close to 0 or slightly biased in one direction
    expect(score).toBeGreaterThan(-5);
    expect(score).toBeLessThan(5);
  });
});

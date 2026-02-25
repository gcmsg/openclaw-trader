/**
 * Tests for LLM sentiment analyzer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";

// Mock axios before importing the module
vi.mock("axios");
const mockedAxios = vi.mocked(axios);

import { analyzeSentimentWithLLM, llmResultToEntry, formatLLMSentimentReport } from "../news/llm-sentiment.js";

const MOCK_PARAMS = {
  headlines: ["Bitcoin surges to new high", "ETF approval boosts market", "Fed holds rates steady"],
  fearGreed: 65,
  btcDominance: 55.5,
  marketCapChange: 2.3,
};

describe("analyzeSentimentWithLLM", () => {
  beforeEach(() => {
    // Provide gateway token for tests
    process.env["OPENCLAW_GATEWAY_TOKEN"] = "test-token";
  });

  afterEach(() => {
    vi.resetAllMocks();
    delete process.env["OPENCLAW_GATEWAY_TOKEN"];
  });

  it("returns parsed result on successful LLM response", async () => {
    const mockLLMResponse = JSON.stringify({
      score: 6,
      label: "bullish",
      bullishReasons: ["ETF 获批", "价格创高"],
      bearishReasons: ["FED 不确定性"],
      confidence: "high",
      summary: "整体偏多，机构资金流入明显",
    });

    mockedAxios.post = vi.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: mockLLMResponse } }],
      },
    });

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(6);
    expect(result?.label).toBe("bullish");
    expect(result?.bullishReasons).toHaveLength(2);
    expect(result?.bearishReasons).toHaveLength(1);
    expect(result?.confidence).toBe("high");
  });

  it("returns null when LLM response is not valid JSON", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: "I cannot analyze this right now." } }],
      },
    });

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result).toBeNull();
  });

  it("returns null on network error (graceful degradation)", async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result).toBeNull();
  });

  it("returns null when no gateway token configured", async () => {
    delete process.env["OPENCLAW_GATEWAY_TOKEN"];

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result).toBeNull();
  });

  it("clamps score to [-10, +10] range", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify({ score: 999, label: "very_bullish", bullishReasons: [], bearishReasons: [], confidence: "high", summary: "test" }) } }],
      },
    });

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result?.score).toBe(10);
  });

  it("extracts JSON even when LLM wraps it in prose", async () => {
    const wrapped = `Here is my analysis:\n${JSON.stringify({ score: -3, label: "bearish", bullishReasons: [], bearishReasons: ["市场下行"], confidence: "medium", summary: "偏空" })}\nThis concludes my analysis.`;
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: { choices: [{ message: { content: wrapped } }] },
    });

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result?.score).toBe(-3);
    expect(result?.label).toBe("bearish");
  });

  it("limits reasons to 3 items", async () => {
    const payload = {
      score: 5, label: "bullish",
      bullishReasons: ["a", "b", "c", "d", "e"],
      bearishReasons: ["x", "y", "z", "w"],
      confidence: "high", summary: "test",
    };
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: { choices: [{ message: { content: JSON.stringify(payload) } }] },
    });

    const result = await analyzeSentimentWithLLM(MOCK_PARAMS);
    expect(result?.bullishReasons).toHaveLength(3);
    expect(result?.bearishReasons).toHaveLength(3);
  });
});

describe("llmResultToEntry", () => {
  it("converts LLM result to SentimentEntry shape", () => {
    const llmResult = {
      score: 4,
      label: "bullish" as const,
      bullishReasons: ["机构买入"],
      bearishReasons: [],
      confidence: "medium" as const,
      summary: "偏多",
    };

    const entry = llmResultToEntry(llmResult, 20);
    expect(entry.score).toBe(4);
    expect(entry.label).toBe("bullish");
    expect(entry.headlineCount).toBe(20);
    expect(entry.analyzedBy).toContain("LLM");
    expect(entry.analyzedBy).toContain("medium");
  });
});

describe("formatLLMSentimentReport", () => {
  it("formats report with all sections", () => {
    const result = {
      score: 7,
      label: "bullish" as const,
      bullishReasons: ["ETF 通过", "机构买入"],
      bearishReasons: ["监管风险"],
      confidence: "high" as const,
      summary: "市场整体偏多",
    };

    const report = formatLLMSentimentReport(result);
    expect(report).toContain("+7");
    expect(report).toContain("🤖");
    expect(report).toContain("🎯"); // high confidence emoji
    expect(report).toContain("ETF 通过");
    expect(report).toContain("监管风险");
    expect(report).toContain("市场整体偏多");
  });

  it("shows different emoji for each confidence level", () => {
    const base = { score: 0, label: "neutral" as const, bullishReasons: [], bearishReasons: [], summary: "" };
    expect(formatLLMSentimentReport({ ...base, confidence: "high" })).toContain("🎯");
    expect(formatLLMSentimentReport({ ...base, confidence: "medium" })).toContain("🤔");
    expect(formatLLMSentimentReport({ ...base, confidence: "low" })).toContain("❓");
  });
});

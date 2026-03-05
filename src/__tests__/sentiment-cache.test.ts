/**
 * Sentiment cache module tests
 *
 * Coverage: readSentimentCache / writeSentimentCache / writeKeywordSentimentCache
 *           evaluateCachedSentiment / sentimentLabelZh / formatSentimentCacheSummary
 *
 * All file I/O is mocked via vi.spyOn(fs, ...), no real disk read/write.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

import {
  readSentimentCache,
  writeSentimentCache,
  writeKeywordSentimentCache,
  evaluateCachedSentiment,
  sentimentLabelZh,
  formatSentimentCacheSummary,
} from "../news/sentiment-cache.js";
import type { SentimentCache, SentimentEntry } from "../news/sentiment-cache.js";

// ─── helpers ──────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SentimentEntry> = {}): SentimentEntry {
  return {
    score: 3,
    label: "bullish",
    bullishReasons: ["BTC ETF", "institutional buying"],
    bearishReasons: [],
    headlineCount: 10,
    updatedAt: Date.now(),
    source: "llm",
    ...overrides,
  };
}

function makeCache(overrides: Partial<SentimentCache> = {}): SentimentCache {
  return {
    overall: makeEntry(),
    version: 2,
    ...overrides,
  };
}

// ─── readSentimentCache ────────────────────────────────────────────

describe("readSentimentCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when cache file does not exist", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readSentimentCache()).toBeNull();
  });

  it("returns SentimentCache when cache is within validity period", () => {
    const cache = makeCache({ overall: makeEntry({ updatedAt: Date.now() - 1000 }) });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    const result = readSentimentCache();
    expect(result).not.toBeNull();
    expect(result?.overall.label).toBe("bullish");
  });

  it("returns null when cache exceeds TTL", () => {
    // updatedAt set to 7 hours ago, default TTL 6h
    const old = makeEntry({ updatedAt: Date.now() - 7 * 3600 * 1000 });
    const cache = makeCache({ overall: old });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    expect(readSentimentCache()).toBeNull();
  });

  it("custom maxAgeMs can extend validity period", () => {
    // cache written 8 hours ago, but we pass 10h TTL
    const old = makeEntry({ updatedAt: Date.now() - 8 * 3600 * 1000 });
    const cache = makeCache({ overall: old });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    const result = readSentimentCache(10 * 3600 * 1000);
    expect(result).not.toBeNull();
  });

  it("returns null when JSON format is corrupted", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ broken json >>><<");
    expect(readSentimentCache()).toBeNull();
  });
});

// ─── writeSentimentCache ───────────────────────────────────────────

describe("writeSentimentCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls writeFileSync to write JSON", () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: 5, label: "bullish" });

    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();

    // verify written content is valid JSON
    const rawCall = writeSpy.mock.calls[0];
    const written = rawCall?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(5);
    expect(parsed.overall.label).toBe("bullish");
    expect(parsed.overall.source).toBe("llm");
  });

  it("score auto-clamps to 10 when exceeding 10", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: 999, label: "very_bullish" });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(10);
  });

  it("score auto-clamps to -10 when below -10", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: -999, label: "very_bearish" });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(-10);
  });

  it("bullishReasons truncated to 3 entries when exceeding 3", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({
      score: 4,
      label: "bullish",
      bullishReasons: ["a", "b", "c", "d", "e"],
    });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.bullishReasons).toHaveLength(3);
  });

  it("correctly merges byAsset into cache when writing", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({
      score: 2,
      label: "bullish",
      byAsset: {
        BTC: {
          score: 5,
          label: "very_bullish",
          bullishReasons: ["ETF"],
          bearishReasons: [],
          headlineCount: 3,
        },
      },
    });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.byAsset?.["BTC"]?.score).toBe(5);
  });
});

// ─── writeKeywordSentimentCache ───────────────────────────────────

describe("writeKeywordSentimentCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keyword score >= 4 writes very_bullish label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(4, 5);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("very_bullish");
    expect(parsed.overall.source).toBe("keywords");
  });

  it("keyword score <= -4 writes very_bearish label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(-4, 8);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("very_bearish");
  });

  it("keyword score 0 writes neutral label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(0, 2);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("neutral");
  });

  it("write failure does not throw exception (silent failure)", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(() => writeKeywordSentimentCache(2, 3)).not.toThrow();
  });
});

// ─── evaluateCachedSentiment ──────────────────────────────────────

describe("evaluateCachedSentiment", () => {
  it("buy + score ≤ -5 → skip", () => {
    const cache = makeCache({ overall: makeEntry({ score: -6, label: "very_bearish" }) });
    const result = evaluateCachedSentiment("buy", cache);
    expect(result.action).toBe("skip");
  });

  it("buy + score <= -3 -> reduce_size (ratio 0.5)", () => {
    const cache = makeCache({ overall: makeEntry({ score: -3, label: "bearish" }) });
    const result = evaluateCachedSentiment("buy", cache);
    expect(result.action).toBe("reduce_size");
    if (result.action === "reduce_size") {
      expect(result.ratio).toBe(0.5);
    }
  });

  it("buy + score 0 → proceed", () => {
    const cache = makeCache({ overall: makeEntry({ score: 0, label: "neutral" }) });
    const result = evaluateCachedSentiment("buy", cache);
    expect(result.action).toBe("proceed");
  });

  it("short + score ≥ 5 → skip", () => {
    const cache = makeCache({ overall: makeEntry({ score: 7, label: "very_bullish" }) });
    const result = evaluateCachedSentiment("short", cache);
    expect(result.action).toBe("skip");
  });

  it("short + score ≥ 3 → reduce_size", () => {
    const cache = makeCache({ overall: makeEntry({ score: 3, label: "bullish" }) });
    const result = evaluateCachedSentiment("short", cache);
    expect(result.action).toBe("reduce_size");
  });

  it("sell signal is not restricted by sentiment", () => {
    const cache = makeCache({ overall: makeEntry({ score: -8, label: "very_bearish" }) });
    const result = evaluateCachedSentiment("sell", cache);
    expect(result.action).toBe("proceed");
  });

  it("cover signal is not restricted by sentiment", () => {
    const cache = makeCache({ overall: makeEntry({ score: 9, label: "very_bullish" }) });
    const result = evaluateCachedSentiment("cover", cache);
    expect(result.action).toBe("proceed");
  });

  it("reason contains score information", () => {
    const cache = makeCache({ overall: makeEntry({ score: -6, label: "very_bearish", source: "llm" }) });
    const result = evaluateCachedSentiment("buy", cache);
    expect(result.reason).toContain("-6");
    expect(result.reason).toContain("LLM");
  });
});

// ─── sentimentLabelZh ─────────────────────────────────────────────

describe("sentimentLabelZh", () => {
  it("very_bullish → Very Bullish 🚀", () => {
    expect(sentimentLabelZh("very_bullish")).toContain("Very Bullish");
  });

  it("bullish → Bullish 📈", () => {
    expect(sentimentLabelZh("bullish")).toContain("Bullish");
  });

  it("neutral → Neutral ➡️", () => {
    expect(sentimentLabelZh("neutral")).toContain("Neutral");
  });

  it("bearish → Bearish 📉", () => {
    expect(sentimentLabelZh("bearish")).toContain("Bearish");
  });

  it("very_bearish → Very Bearish 💀", () => {
    expect(sentimentLabelZh("very_bearish")).toContain("Very Bearish");
  });
});

// ─── formatSentimentCacheSummary ─────────────────────────────────

describe("formatSentimentCacheSummary", () => {
  it("contains sentiment score", () => {
    const cache = makeCache({ overall: makeEntry({ score: 7 }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("+7");
  });

  it("contains bullish reasons", () => {
    const cache = makeCache({
      overall: makeEntry({ bullishReasons: ["ETF approved", "institutional buying"] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("ETF approved");
    expect(report).toContain("institutional buying");
  });

  it("contains bearish reasons", () => {
    const cache = makeCache({
      overall: makeEntry({ score: -2, label: "bearish", bearishReasons: ["regulatory risk"] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("regulatory risk");
  });

  it("no bullish/bearish reason lines when none exist", () => {
    const cache = makeCache({
      overall: makeEntry({ bullishReasons: [], bearishReasons: [] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).not.toContain("🟢");
    expect(report).not.toContain("🔴");
  });

  it("LLM source shows 🤖 LLM label", () => {
    const cache = makeCache({ overall: makeEntry({ source: "llm" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("🤖 LLM");
  });

  it("keyword source shows 🔤 keyword label", () => {
    const cache = makeCache({ overall: makeEntry({ source: "keywords" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("🔤 Keywords");
  });

  it("negative score shows minus sign instead of plus sign", () => {
    const cache = makeCache({ overall: makeEntry({ score: -4, label: "bearish" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("-4");
  });
});

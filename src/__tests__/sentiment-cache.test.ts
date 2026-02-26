/**
 * 情绪缓存模块测试
 *
 * 覆盖：readSentimentCache / writeSentimentCache / writeKeywordSentimentCache
 *       evaluateCachedSentiment / sentimentLabelZh / formatSentimentCacheSummary
 *
 * 所有文件 I/O 均通过 vi.spyOn(fs, ...) mock，不读写真实磁盘。
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
    bullishReasons: ["BTC ETF", "机构买入"],
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

  it("缓存文件不存在时返回 null", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readSentimentCache()).toBeNull();
  });

  it("缓存在有效期内返回 SentimentCache", () => {
    const cache = makeCache({ overall: makeEntry({ updatedAt: Date.now() - 1000 }) });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    const result = readSentimentCache();
    expect(result).not.toBeNull();
    expect(result?.overall.label).toBe("bullish");
  });

  it("缓存超过 TTL 时返回 null", () => {
    // updatedAt 设置为 7 小时前，默认 TTL 6h
    const old = makeEntry({ updatedAt: Date.now() - 7 * 3600 * 1000 });
    const cache = makeCache({ overall: old });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    expect(readSentimentCache()).toBeNull();
  });

  it("自定义 maxAgeMs 可延长有效期", () => {
    // 缓存 8 小时前写入，但我们传入 10h 的 TTL
    const old = makeEntry({ updatedAt: Date.now() - 8 * 3600 * 1000 });
    const cache = makeCache({ overall: old });
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));
    const result = readSentimentCache(10 * 3600 * 1000);
    expect(result).not.toBeNull();
  });

  it("JSON 格式损坏时返回 null", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ broken json >>><<");
    expect(readSentimentCache()).toBeNull();
  });
});

// ─── writeSentimentCache ───────────────────────────────────────────

describe("writeSentimentCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("调用 writeFileSync 写入 JSON", () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: 5, label: "bullish" });

    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();

    // 验证写入的内容是合法 JSON
    const rawCall = writeSpy.mock.calls[0];
    const written = rawCall?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(5);
    expect(parsed.overall.label).toBe("bullish");
    expect(parsed.overall.source).toBe("llm");
  });

  it("score 超过 10 时自动截断到 10", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: 999, label: "very_bullish" });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(10);
  });

  it("score 低于 -10 时自动截断到 -10", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeSentimentCache({ score: -999, label: "very_bearish" });

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.score).toBe(-10);
  });

  it("bullishReasons 超过 3 条时截断到 3 条", () => {
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

  it("写入 byAsset 时正确合并到缓存", () => {
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

  it("关键词分 >= 4 写入 very_bullish label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(4, 5);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("very_bullish");
    expect(parsed.overall.source).toBe("keywords");
  });

  it("关键词分 <= -4 写入 very_bearish label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(-4, 8);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("very_bearish");
  });

  it("关键词分 0 写入 neutral label", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeKeywordSentimentCache(0, 2);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as SentimentCache;
    expect(parsed.overall.label).toBe("neutral");
  });

  it("写入失败不抛出异常（静默失败）", () => {
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

  it("buy + score ≤ -3 → reduce_size（ratio 0.5）", () => {
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

  it("sell 信号不受情绪限制", () => {
    const cache = makeCache({ overall: makeEntry({ score: -8, label: "very_bearish" }) });
    const result = evaluateCachedSentiment("sell", cache);
    expect(result.action).toBe("proceed");
  });

  it("cover 信号不受情绪限制", () => {
    const cache = makeCache({ overall: makeEntry({ score: 9, label: "very_bullish" }) });
    const result = evaluateCachedSentiment("cover", cache);
    expect(result.action).toBe("proceed");
  });

  it("reason 中包含分数信息", () => {
    const cache = makeCache({ overall: makeEntry({ score: -6, label: "very_bearish", source: "llm" }) });
    const result = evaluateCachedSentiment("buy", cache);
    expect(result.reason).toContain("-6");
    expect(result.reason).toContain("LLM");
  });
});

// ─── sentimentLabelZh ─────────────────────────────────────────────

describe("sentimentLabelZh", () => {
  it("very_bullish → 极度看多 🚀", () => {
    expect(sentimentLabelZh("very_bullish")).toContain("极度看多");
  });

  it("bullish → 看多 📈", () => {
    expect(sentimentLabelZh("bullish")).toContain("看多");
  });

  it("neutral → 中性 ➡️", () => {
    expect(sentimentLabelZh("neutral")).toContain("中性");
  });

  it("bearish → 看空 📉", () => {
    expect(sentimentLabelZh("bearish")).toContain("看空");
  });

  it("very_bearish → 极度看空 💀", () => {
    expect(sentimentLabelZh("very_bearish")).toContain("极度看空");
  });
});

// ─── formatSentimentCacheSummary ─────────────────────────────────

describe("formatSentimentCacheSummary", () => {
  it("包含情绪分数", () => {
    const cache = makeCache({ overall: makeEntry({ score: 7 }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("+7");
  });

  it("包含利多理由", () => {
    const cache = makeCache({
      overall: makeEntry({ bullishReasons: ["ETF 获批", "机构买入"] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("ETF 获批");
    expect(report).toContain("机构买入");
  });

  it("包含利空理由", () => {
    const cache = makeCache({
      overall: makeEntry({ score: -2, label: "bearish", bearishReasons: ["监管风险"] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("监管风险");
  });

  it("无利多/利空理由时不包含对应行", () => {
    const cache = makeCache({
      overall: makeEntry({ bullishReasons: [], bearishReasons: [] }),
    });
    const report = formatSentimentCacheSummary(cache);
    expect(report).not.toContain("🟢");
    expect(report).not.toContain("🔴");
  });

  it("LLM 来源显示 🤖 LLM 标签", () => {
    const cache = makeCache({ overall: makeEntry({ source: "llm" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("🤖 LLM");
  });

  it("关键词来源显示 🔤 关键词 标签", () => {
    const cache = makeCache({ overall: makeEntry({ source: "keywords" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("🔤 关键词");
  });

  it("负分数显示负号而非加号", () => {
    const cache = makeCache({ overall: makeEntry({ score: -4, label: "bearish" }) });
    const report = formatSentimentCacheSummary(cache);
    expect(report).toContain("-4");
  });
});

/**
 * Reddit 社交情绪模块测试（P5.4）
 *
 * 所有网络调用均 mock，不发真实请求。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import https from "https";
import type { ClientRequest, IncomingMessage } from "http";
import { EventEmitter } from "events";

// ── 测试辅助 ────────────────────────────────────────────

interface RedditChild {
  data: {
    title: string;
    score: number;
    num_comments: number;
    created_utc: number;
    url: string;
    permalink: string;
  };
}

function makeRedditListing(posts: Partial<RedditChild["data"]>[]): unknown {
  return {
    data: {
      children: posts.map((p) => ({
        data: {
          title: "Default title",
          score: 100,
          num_comments: 20,
          created_utc: Math.floor(Date.now() / 1000),
          url: "https://example.com",
          permalink: "/r/CryptoCurrency/comments/abc/test",
          ...p,
        },
      })),
    },
  };
}

function mockHttpsRequest(responseBody: unknown) {
   
  return vi.spyOn(https, "request").mockImplementation(
    ((_opts: unknown, callback?: ((res: IncomingMessage) => void)  ) => {
      const res = new EventEmitter() as IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = 200;
      setTimeout(() => {
        res.emit("data", JSON.stringify(responseBody));
        res.emit("end");
      }, 0);
      if (callback) callback(res);

      const req = new EventEmitter() as ClientRequest;
      (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).end = () => {};
      (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).setTimeout = () => {};
      return req;
    }) as unknown as typeof https.request
  );
}

// ── 导入被测模块 ────────────────────────────────────────
import {
  fetchRedditPosts,
  analyzeRedditSentiment,
  formatRedditReport,
} from "../news/reddit-sentiment.js";
import type { RedditPost, RedditSentimentResult } from "../news/reddit-sentiment.js";

// ── 辅助：构造帖子列表 ──────────────────────────────────
function makePost(overrides: Partial<RedditPost> = {}): RedditPost {
  return {
    title: "Neutral headline",
    score: 100,
    numComments: 20,
    created: Math.floor(Date.now() / 1000),
    url: "https://www.reddit.com/r/CryptoCurrency/comments/abc/",
    sentiment: "neutral",
    ...overrides,
  };
}

function makeSentimentResult(overrides: Partial<RedditSentimentResult> = {}): RedditSentimentResult {
  return {
    bullishCount: 10,
    bearishCount: 3,
    neutralCount: 5,
    avgScore: 250,
    sentimentLabel: "bullish",
    confidence: 0.39,
    topPosts: [],
    generatedAt: Date.now(),
    ...overrides,
  };
}

// ─── fetchRedditPosts 测试 ──────────────────────────────

describe("fetchRedditPosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常解析帖子列表", async () => {
    mockHttpsRequest(
      makeRedditListing([
        { title: "Bitcoin rally to new highs!", score: 500 },
        { title: "ETH merge update", score: 300 },
      ])
    );
    const posts = await fetchRedditPosts("CryptoCurrency");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.title).toBe("Bitcoin rally to new highs!");
    expect(posts[0]!.score).toBe(500);
  });

  it("帖子含 sentiment 字段（关键词分类）", async () => {
    mockHttpsRequest(
      makeRedditListing([{ title: "Bitcoin surges to ATH! Rally continues" }])
    );
    const posts = await fetchRedditPosts("Bitcoin");
    expect(["bullish", "bearish", "neutral"]).toContain(posts[0]!.sentiment);
  });

  it("利多关键词触发 bullish", async () => {
    mockHttpsRequest(
      makeRedditListing([{ title: "Bitcoin surges after ETF approval and institutional buy" }])
    );
    const posts = await fetchRedditPosts("Bitcoin");
    expect(posts[0]!.sentiment).toBe("bullish");
  });

  it("利空关键词触发 bearish", async () => {
    mockHttpsRequest(
      makeRedditListing([{ title: "Market crash and liquidation wave hits crypto" }])
    );
    const posts = await fetchRedditPosts("CryptoCurrency");
    expect(posts[0]!.sentiment).toBe("bearish");
  });

  it("空结果时返回空数组", async () => {
    mockHttpsRequest(makeRedditListing([]));
    const posts = await fetchRedditPosts("CryptoCurrency", ["nonexistent"]);
    expect(posts).toHaveLength(0);
  });

  it("HTTP 4xx 时抛出异常", async () => {
     
    vi.spyOn(https, "request").mockImplementation(
      ((_opts: unknown, callback?: ((res: IncomingMessage) => void)  ) => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 429;
        setTimeout(() => res.emit("end"), 0);
        if (callback) callback(res);
        const req = new EventEmitter() as ClientRequest;
        (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).end = () => {};
        (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).setTimeout = () => {};
        return req;
      }) as unknown as typeof https.request
    );
    await expect(fetchRedditPosts("CryptoCurrency")).rejects.toThrow(/429/);
  });

  it("带关键词时使用 search 接口（URL 含 q= 参数）", async () => {
    const spy = mockHttpsRequest(makeRedditListing([]));
    await fetchRedditPosts("CryptoCurrency", ["bitcoin", "eth"]);
    const callArg = spy.mock.calls[0]![0] as { path?: string };
    expect(callArg?.path ?? "").toContain("search.json");
  });
});

// ─── analyzeRedditSentiment 测试 ───────────────────────

describe("analyzeRedditSentiment", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("全部 bullish 帖子 → sentimentLabel = bullish", () => {
    const posts = [
      makePost({ sentiment: "bullish" }),
      makePost({ sentiment: "bullish" }),
      makePost({ sentiment: "bullish" }),
    ];
    const result = analyzeRedditSentiment(posts);
    expect(result.sentimentLabel).toBe("bullish");
    expect(result.bullishCount).toBe(3);
  });

  it("全部 bearish 帖子 → sentimentLabel = bearish", () => {
    const posts = [
      makePost({ sentiment: "bearish" }),
      makePost({ sentiment: "bearish" }),
    ];
    const result = analyzeRedditSentiment(posts);
    expect(result.sentimentLabel).toBe("bearish");
    expect(result.bearishCount).toBe(2);
  });

  it("空列表 → 全部为 0，confidence = 0", () => {
    const result = analyzeRedditSentiment([]);
    expect(result.bullishCount).toBe(0);
    expect(result.bearishCount).toBe(0);
    expect(result.neutralCount).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.avgScore).toBe(0);
  });

  it("topPosts 最多 5 条，按 score 降序", () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      makePost({ score: i * 10, sentiment: "neutral" })
    );
    const result = analyzeRedditSentiment(posts);
    expect(result.topPosts).toHaveLength(5);
    expect(result.topPosts[0]!.score).toBe(90);
    expect(result.topPosts[4]!.score).toBe(50);
  });

  it("avgScore 计算正确", () => {
    const posts = [
      makePost({ score: 100, sentiment: "neutral" }),
      makePost({ score: 200, sentiment: "neutral" }),
      makePost({ score: 300, sentiment: "neutral" }),
    ];
    const result = analyzeRedditSentiment(posts);
    expect(result.avgScore).toBeCloseTo(200, 1);
  });

  it("confidence 正确 = |bull-bear| / total", () => {
    const posts = [
      makePost({ sentiment: "bullish" }),
      makePost({ sentiment: "bullish" }),
      makePost({ sentiment: "bearish" }),
      makePost({ sentiment: "neutral" }),
    ];
    const result = analyzeRedditSentiment(posts);
    // |2-1| / 4 = 0.25
    expect(result.confidence).toBeCloseTo(0.25, 2);
  });

  it("generatedAt 是合理时间戳", () => {
    const before = Date.now();
    const result = analyzeRedditSentiment([]);
    const after = Date.now();
    expect(result.generatedAt).toBeGreaterThanOrEqual(before);
    expect(result.generatedAt).toBeLessThanOrEqual(after);
  });
});

// ─── formatRedditReport 纯函数测试 ────────────────────

describe("formatRedditReport", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("包含整体情绪标签", () => {
    const report = formatRedditReport(makeSentimentResult({ sentimentLabel: "bullish" }));
    expect(report).toContain("BULLISH");
  });

  it("包含 bearish 标签", () => {
    const report = formatRedditReport(makeSentimentResult({ sentimentLabel: "bearish" }));
    expect(report).toContain("BEARISH");
  });

  it("包含中性标签", () => {
    const report = formatRedditReport(makeSentimentResult({ sentimentLabel: "neutral" }));
    expect(report).toContain("NEUTRAL");
  });

  it("显示帖子数量统计", () => {
    const report = formatRedditReport(
      makeSentimentResult({ bullishCount: 10, bearishCount: 3, neutralCount: 5 })
    );
    expect(report).toContain("10");
    expect(report).toContain("3");
    expect(report).toContain("5");
  });

  it("显示 top 帖子标题", () => {
    const result = makeSentimentResult({
      topPosts: [makePost({ title: "This is the top post", score: 999 })],
    });
    const report = formatRedditReport(result);
    expect(report).toContain("Top5");
    expect(report).toContain("This is the top post");
  });

  it("置信度格式化为百分比", () => {
    const report = formatRedditReport(makeSentimentResult({ confidence: 0.39 }));
    expect(report).toContain("%");
  });

  it("长标题被截断（超过 60 字符加 ...）", () => {
    const longTitle = "A".repeat(80);
    const result = makeSentimentResult({
      topPosts: [makePost({ title: longTitle })],
    });
    const report = formatRedditReport(result);
    expect(report).toContain("...");
  });
});

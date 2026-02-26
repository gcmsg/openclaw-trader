/**
 * P6.2 — Dynamic Pairlist 测试
 *
 * 全部使用 mock fetch，不进行真实网络请求。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchDynamicPairlist,
  diffPairlist,
  formatPairlistReport,
  type BinanceTicker24h,
  type RankedPair,
} from "../exchange/pairlist.js";

// ─────────────────────────────────────────────────────
// Fixture data
// ─────────────────────────────────────────────────────

function makeTicker(
  symbol: string,
  opts: Partial<{
    quoteVolume: number;
    lastPrice: number;
    highPrice: number;
    lowPrice: number;
    priceChangePercent: number;
  }> = {}
): BinanceTicker24h {
  const lastPrice = opts.lastPrice ?? 100;
  const highPrice = opts.highPrice ?? lastPrice * 1.05;
  const lowPrice = opts.lowPrice ?? lastPrice * 0.95;
  return {
    symbol,
    lastPrice: String(lastPrice),
    highPrice: String(highPrice),
    lowPrice: String(lowPrice),
    quoteVolume: String(opts.quoteVolume ?? 100_000_000),
    volume: String((opts.quoteVolume ?? 100_000_000) / lastPrice),
    priceChangePercent: String(opts.priceChangePercent ?? 2.5),
  };
}

function mockFetch(tickers: BinanceTicker24h[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => tickers,
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────
// fetchDynamicPairlist tests
// ─────────────────────────────────────────────────────

describe("fetchDynamicPairlist", () => {
  it("基础情况：返回 USDT 计价的高成交量对", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000, lastPrice: 50000 }),
      makeTicker("ETHUSDT", { quoteVolume: 300_000_000, lastPrice: 3000 }),
      makeTicker("BTCBUSD"), // 非 USDT 计价，应排除
    ]);

    const pairs = await fetchDynamicPairlist({ maxPairs: 15 });
    expect(pairs.map((p) => p.symbol)).toContain("BTCUSDT");
    expect(pairs.map((p) => p.symbol)).toContain("ETHUSDT");
    expect(pairs.map((p) => p.symbol)).not.toContain("BTCBUSD");
  });

  it("稳定币过滤：排除 USDCUSDT, BUSDUSDT, DAIUSDT 等", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("USDCUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("BUSDUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("DAIUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("TUSDUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("FDUSDUSDT", { quoteVolume: 200_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({});
    const symbols = pairs.map((p) => p.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).not.toContain("USDCUSDT");
    expect(symbols).not.toContain("BUSDUSDT");
    expect(symbols).not.toContain("DAIUSDT");
    expect(symbols).not.toContain("TUSDUSDT");
    expect(symbols).not.toContain("FDUSDUSDT");
  });

  it("杠杆代币过滤：排除 BTCUPUSDT, ETHDOWNUSDT, BTCBEARUSDT, ETHBULLUSDT", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("BTCUPUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("ETHDOWNUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("BTCBEARUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("ETHBULLUSDT", { quoteVolume: 200_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({});
    const symbols = pairs.map((p) => p.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).not.toContain("BTCUPUSDT");
    expect(symbols).not.toContain("ETHDOWNUSDT");
    expect(symbols).not.toContain("BTCBEARUSDT");
    expect(symbols).not.toContain("ETHBULLUSDT");
  });

  it("blacklist：强制排除指定币种", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("ETHUSDT", { quoteVolume: 300_000_000 }),
      makeTicker("XRPUSDT", { quoteVolume: 200_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({ blacklist: ["XRPUSDT"] });
    const symbols = pairs.map((p) => p.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).toContain("ETHUSDT");
    expect(symbols).not.toContain("XRPUSDT");
  });

  it("whitelist：强制包含指定币种（即使低成交量）", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("ETHUSDT", { quoteVolume: 300_000_000 }),
      makeTicker("RAREUSDT", { quoteVolume: 1_000_000 }), // 低成交量，但在 whitelist
    ]);

    const pairs = await fetchDynamicPairlist({
      whitelist: ["RAREUSDT"],
      minVolume24hUsd: 50_000_000,
    });
    const symbols = pairs.map((p) => p.symbol);
    expect(symbols).toContain("RAREUSDT");
  });

  it("maxPairs：限制返回数量", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("ETHUSDT", { quoteVolume: 400_000_000 }),
      makeTicker("BNBUSDT", { quoteVolume: 300_000_000 }),
      makeTicker("SOLUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("XRPUSDT", { quoteVolume: 100_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({ maxPairs: 3 });
    expect(pairs.length).toBe(3);
  });

  it("sortBy=volume：按 24h 成交量降序排列", async () => {
    mockFetch([
      makeTicker("LOWVOLUSDT", { quoteVolume: 60_000_000, priceChangePercent: 10 }),
      makeTicker("HIGHVOLUSDT", { quoteVolume: 500_000_000, priceChangePercent: 1 }),
      makeTicker("MIDVOLUSDT", { quoteVolume: 200_000_000, priceChangePercent: 5 }),
    ]);

    const pairs = await fetchDynamicPairlist({ sortBy: "volume" });
    expect(pairs[0]?.symbol).toBe("HIGHVOLUSDT");
    expect(pairs[1]?.symbol).toBe("MIDVOLUSDT");
    expect(pairs[2]?.symbol).toBe("LOWVOLUSDT");
  });

  it("sortBy=momentum：按价格变化绝对值降序排列", async () => {
    mockFetch([
      makeTicker("ALPHAUSDT", { quoteVolume: 100_000_000, priceChangePercent: 2 }),
      makeTicker("BETAUSDT", { quoteVolume: 100_000_000, priceChangePercent: -15 }),
      makeTicker("GAMMAUSDT", { quoteVolume: 100_000_000, priceChangePercent: 8 }),
    ]);

    const pairs = await fetchDynamicPairlist({ sortBy: "momentum" });
    expect(pairs[0]?.symbol).toBe("BETAUSDT"); // abs(-15) = 15
    expect(pairs[1]?.symbol).toBe("GAMMAUSDT"); // abs(8) = 8
    expect(pairs[2]?.symbol).toBe("ALPHAUSDT"); // abs(2) = 2
  });

  it("sortBy=volatility：按 (high-low)/close 降序排列", async () => {
    mockFetch([
      makeTicker("LOWVOLAUSDT", {
        quoteVolume: 100_000_000,
        lastPrice: 100,
        highPrice: 101,
        lowPrice: 99,
      }), // vol = 2%
      makeTicker("HIGHVOLAUSDT", {
        quoteVolume: 100_000_000,
        lastPrice: 100,
        highPrice: 115,
        lowPrice: 85,
      }), // vol = 30%
      makeTicker("MIDVOLAUSDT", {
        quoteVolume: 100_000_000,
        lastPrice: 100,
        highPrice: 108,
        lowPrice: 92,
      }), // vol = 16%
    ]);

    const pairs = await fetchDynamicPairlist({ sortBy: "volatility" });
    expect(pairs[0]?.symbol).toBe("HIGHVOLAUSDT");
    expect(pairs[1]?.symbol).toBe("MIDVOLAUSDT");
    expect(pairs[2]?.symbol).toBe("LOWVOLAUSDT");
  });

  it("minVolume24hUsd：过滤低成交量", async () => {
    mockFetch([
      makeTicker("HIGHVOLUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("LOWVOLUSDT", { quoteVolume: 10_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({ minVolume24hUsd: 100_000_000 });
    expect(pairs.map((p) => p.symbol)).toContain("HIGHVOLUSDT");
    expect(pairs.map((p) => p.symbol)).not.toContain("LOWVOLUSDT");
  });

  it("API 失败时抛出错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => null,
      })
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow("Binance API error");
  });

  it("RankedPair 包含正确的字段结构", async () => {
    mockFetch([makeTicker("BTCUSDT", { quoteVolume: 500_000_000, lastPrice: 50000, priceChangePercent: 3.5 })]);

    const pairs = await fetchDynamicPairlist({ maxPairs: 1 });
    expect(pairs.length).toBeGreaterThan(0);
    const p = pairs[0]!;
    expect(p).toHaveProperty("symbol");
    expect(p).toHaveProperty("volume24hUsd");
    expect(p).toHaveProperty("priceChangePercent");
    expect(p).toHaveProperty("volatility");
    expect(p).toHaveProperty("score");
    expect(p.volume24hUsd).toBe(500_000_000);
    expect(p.priceChangePercent).toBe(3.5);
    expect(p.volatility).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// diffPairlist tests
// ─────────────────────────────────────────────────────

describe("diffPairlist", () => {
  it("新增/移除/不变 三组正确区分", () => {
    const current = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
    const next = ["BTCUSDT", "SOLUSDT", "BNBUSDT"];

    const diff = diffPairlist(current, next);
    expect(diff.added).toEqual(["SOLUSDT"]);
    expect(diff.removed).toEqual(["ETHUSDT"]);
    expect(diff.unchanged).toEqual(["BTCUSDT", "BNBUSDT"]);
  });

  it("完全相同时全部在 unchanged", () => {
    const list = ["BTCUSDT", "ETHUSDT"];
    const diff = diffPairlist(list, list);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("从空列表到有数据：全部是 added", () => {
    const diff = diffPairlist([], ["BTCUSDT", "ETHUSDT"]);
    expect(diff.added).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("从有数据到空列表：全部是 removed", () => {
    const diff = diffPairlist(["BTCUSDT", "ETHUSDT"], []);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(diff.unchanged).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────
// formatPairlistReport tests
// ─────────────────────────────────────────────────────

describe("formatPairlistReport", () => {
  const samplePairs: RankedPair[] = [
    {
      symbol: "BTCUSDT",
      volume24hUsd: 500_000_000,
      priceChangePercent: 3.5,
      volatility: 0.05,
      score: 500_000_000,
    },
    {
      symbol: "ETHUSDT",
      volume24hUsd: 200_000_000,
      priceChangePercent: -1.2,
      volatility: 0.04,
      score: 200_000_000,
    },
  ];

  it("包含 symbol 信息", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).toContain("BTCUSDT");
    expect(report).toContain("ETHUSDT");
  });

  it("包含标题和总数", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).toContain("Dynamic Pairlist Report");
    expect(report).toContain("Total: 2");
  });

  it("包含 diff 信息（有 diff 时）", () => {
    const diff = { added: ["SOLUSDT"], removed: ["XRPUSDT"], unchanged: ["BTCUSDT"] };
    const report = formatPairlistReport(samplePairs, diff);
    expect(report).toContain("Added");
    expect(report).toContain("SOLUSDT");
    expect(report).toContain("Removed");
    expect(report).toContain("XRPUSDT");
    expect(report).toContain("Unchanged");
  });

  it("没有 diff 时不包含 Added/Removed 字样", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).not.toContain("Added");
    expect(report).not.toContain("Removed");
  });
});

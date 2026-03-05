/**
 * P6.2 — Dynamic Pairlist tests
 *
 * All using mock fetch; no real network requests are made.
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
  it("basic case: returns high-volume USDT-quoted pairs", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000, lastPrice: 50000 }),
      makeTicker("ETHUSDT", { quoteVolume: 300_000_000, lastPrice: 3000 }),
      makeTicker("BTCBUSD"), // Not USDT-quoted, should be excluded
    ]);

    const pairs = await fetchDynamicPairlist({ maxPairs: 15 });
    expect(pairs.map((p) => p.symbol)).toContain("BTCUSDT");
    expect(pairs.map((p) => p.symbol)).toContain("ETHUSDT");
    expect(pairs.map((p) => p.symbol)).not.toContain("BTCBUSD");
  });

  it("stablecoin filter: excludes USDCUSDT, BUSDUSDT, DAIUSDT, etc.", async () => {
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

  it("leveraged token filter: excludes BTCUPUSDT, ETHDOWNUSDT, BTCBEARUSDT, ETHBULLUSDT", async () => {
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

  it("blacklist: forcefully excludes specified symbols", async () => {
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

  it("whitelist: forcefully includes specified symbols (even with low volume)", async () => {
    mockFetch([
      makeTicker("BTCUSDT", { quoteVolume: 500_000_000 }),
      makeTicker("ETHUSDT", { quoteVolume: 300_000_000 }),
      makeTicker("RAREUSDT", { quoteVolume: 1_000_000 }), // Low volume, but in whitelist
    ]);

    const pairs = await fetchDynamicPairlist({
      whitelist: ["RAREUSDT"],
      minVolume24hUsd: 50_000_000,
    });
    const symbols = pairs.map((p) => p.symbol);
    expect(symbols).toContain("RAREUSDT");
  });

  it("maxPairs: limits the number of returned pairs", async () => {
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

  it("sortBy=volume: sorted by 24h volume descending", async () => {
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

  it("sortBy=momentum: sorted by absolute price change descending", async () => {
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

  it("sortBy=volatility: sorted by (high-low)/close descending", async () => {
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

  it("minVolume24hUsd: filters out low-volume pairs", async () => {
    mockFetch([
      makeTicker("HIGHVOLUSDT", { quoteVolume: 200_000_000 }),
      makeTicker("LOWVOLUSDT", { quoteVolume: 10_000_000 }),
    ]);

    const pairs = await fetchDynamicPairlist({ minVolume24hUsd: 100_000_000 });
    expect(pairs.map((p) => p.symbol)).toContain("HIGHVOLUSDT");
    expect(pairs.map((p) => p.symbol)).not.toContain("LOWVOLUSDT");
  });

  it("throws error on API failure", async () => {
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

  it("RankedPair contains correct field structure", async () => {
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
  it("correctly distinguishes added/removed/unchanged groups", () => {
    const current = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
    const next = ["BTCUSDT", "SOLUSDT", "BNBUSDT"];

    const diff = diffPairlist(current, next);
    expect(diff.added).toEqual(["SOLUSDT"]);
    expect(diff.removed).toEqual(["ETHUSDT"]);
    expect(diff.unchanged).toEqual(["BTCUSDT", "BNBUSDT"]);
  });

  it("all in unchanged when lists are identical", () => {
    const list = ["BTCUSDT", "ETHUSDT"];
    const diff = diffPairlist(list, list);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("from empty to populated: all are added", () => {
    const diff = diffPairlist([], ["BTCUSDT", "ETHUSDT"]);
    expect(diff.added).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("from populated to empty: all are removed", () => {
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

  it("contains symbol info", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).toContain("BTCUSDT");
    expect(report).toContain("ETHUSDT");
  });

  it("contains title and total count", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).toContain("Dynamic Pairlist Report");
    expect(report).toContain("Total: 2");
  });

  it("contains diff info (when diff is provided)", () => {
    const diff = { added: ["SOLUSDT"], removed: ["XRPUSDT"], unchanged: ["BTCUSDT"] };
    const report = formatPairlistReport(samplePairs, diff);
    expect(report).toContain("Added");
    expect(report).toContain("SOLUSDT");
    expect(report).toContain("Removed");
    expect(report).toContain("XRPUSDT");
    expect(report).toContain("Unchanged");
  });

  it("does not contain Added/Removed when no diff is provided", () => {
    const report = formatPairlistReport(samplePairs);
    expect(report).not.toContain("Added");
    expect(report).not.toContain("Removed");
  });
});

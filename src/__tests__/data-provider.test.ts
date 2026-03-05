/**
 * DataProvider tests (G2)
 * vi.mock binance.js, verify caching logic (no real network requests)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kline } from "../types.js";

// Mock binance.js getKlines, set up before import
vi.mock("../exchange/binance.js", () => ({
  getKlines: vi.fn(),
}));

import { DataProvider } from "../exchange/data-provider.js";
import { getKlines } from "../exchange/binance.js";

const mockGetKlines = vi.mocked(getKlines);

function makeKlines(n: number, basePrice = 100): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 3_600_000,
    open: basePrice,
    high: basePrice * 1.01,
    low: basePrice * 0.99,
    close: basePrice + i * 0.1,
    volume: 1000,
    closeTime: (i + 1) * 3_600_000,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DataProvider — basic behavior", () => {
  it("get returns cached klines after refresh", async () => {
    const klines = makeKlines(60);
    mockGetKlines.mockResolvedValueOnce(klines);

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    const result = provider.get("BTCUSDT", "1h");
    expect(result).toEqual(klines);
    expect(mockGetKlines).toHaveBeenCalledOnce();
    expect(mockGetKlines).toHaveBeenCalledWith("BTCUSDT", "1h", 60);
  });

  it("returns undefined for unfetched symbol", () => {
    const provider = new DataProvider(30);
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
  });

  it("refresh fetches multiple symbols in batch", async () => {
    mockGetKlines
      .mockResolvedValueOnce(makeKlines(60))
      .mockResolvedValueOnce(makeKlines(60, 200));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT", "ETHUSDT"], "1h", 60);

    expect(provider.get("BTCUSDT", "1h")).toBeDefined();
    expect(provider.get("ETHUSDT", "1h")).toBeDefined();
    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("refresh does not re-fetch while cache is valid", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // 10 seconds later, refresh again (within 30-second TTL)
    vi.advanceTimersByTime(10_000);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // Should have been called only once
    expect(mockGetKlines).toHaveBeenCalledOnce();
  });

  it("refresh re-fetches after cache expires", async () => {
    mockGetKlines
      .mockResolvedValueOnce(makeKlines(60))
      .mockResolvedValueOnce(makeKlines(60, 101));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // After 30 seconds, refresh again
    vi.advanceTimersByTime(31_000);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("isStale: returns true for unfetched symbol", () => {
    const provider = new DataProvider(30);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });

  it("isStale: returns false when cache is fresh", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(false);
  });

  it("isStale: returns true after cache expires", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    vi.advanceTimersByTime(31_000);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });

  it("different timeframes are cached independently", async () => {
    mockGetKlines
      .mockResolvedValueOnce(makeKlines(60))  // 1h
      .mockResolvedValueOnce(makeKlines(20));  // 4h

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    await provider.refresh(["BTCUSDT"], "4h", 20);

    expect(provider.get("BTCUSDT", "1h")).toBeDefined();
    expect(provider.get("BTCUSDT", "4h")).toBeDefined();
    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("getKlines failure handled silently (other symbols still work)", async () => {
    mockGetKlines
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(makeKlines(60, 200));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT", "ETHUSDT"], "1h", 60);

    // BTCUSDT failed, ETHUSDT succeeded
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
    expect(provider.get("ETHUSDT", "1h")).toBeDefined();
  });

  it("clear() clears all cache", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    expect(provider.get("BTCUSDT", "1h")).toBeDefined();

    provider.clear();
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });
});

/**
 * DataProvider 测试 (G2)
 * vi.mock binance.js，验证缓存逻辑（不真实请求网络）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Kline } from "../types.js";

// Mock binance.js 的 getKlines，在 import 之前设置
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

describe("DataProvider — 基础行为", () => {
  it("refresh 后 get 返回缓存的 K 线", async () => {
    const klines = makeKlines(60);
    mockGetKlines.mockResolvedValueOnce(klines);

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    const result = provider.get("BTCUSDT", "1h");
    expect(result).toEqual(klines);
    expect(mockGetKlines).toHaveBeenCalledOnce();
    expect(mockGetKlines).toHaveBeenCalledWith("BTCUSDT", "1h", 60);
  });

  it("未拉取的 symbol 返回 undefined", () => {
    const provider = new DataProvider(30);
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
  });

  it("refresh 批量拉取多个 symbol", async () => {
    mockGetKlines
      .mockResolvedValueOnce(makeKlines(60))
      .mockResolvedValueOnce(makeKlines(60, 200));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT", "ETHUSDT"], "1h", 60);

    expect(provider.get("BTCUSDT", "1h")).toBeDefined();
    expect(provider.get("ETHUSDT", "1h")).toBeDefined();
    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("缓存有效时 refresh 不重复拉取", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // 10 秒后再次 refresh（未超过 30 秒）
    vi.advanceTimersByTime(10_000);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // 应该只调用一次
    expect(mockGetKlines).toHaveBeenCalledOnce();
  });

  it("缓存过期后 refresh 重新拉取", async () => {
    mockGetKlines
      .mockResolvedValueOnce(makeKlines(60))
      .mockResolvedValueOnce(makeKlines(60, 101));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    // 超过 30 秒后再次 refresh
    vi.advanceTimersByTime(31_000);
    await provider.refresh(["BTCUSDT"], "1h", 60);

    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("isStale：未拉取的 symbol 返回 true", () => {
    const provider = new DataProvider(30);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });

  it("isStale：缓存新鲜时返回 false", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(false);
  });

  it("isStale：缓存过期后返回 true", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    vi.advanceTimersByTime(31_000);
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });

  it("不同 timeframe 独立缓存", async () => {
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

  it("getKlines 失败时静默处理（其他 symbol 正常）", async () => {
    mockGetKlines
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(makeKlines(60, 200));

    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT", "ETHUSDT"], "1h", 60);

    // BTCUSDT 失败，ETHUSDT 成功
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
    expect(provider.get("ETHUSDT", "1h")).toBeDefined();
  });

  it("clear() 清空所有缓存", async () => {
    mockGetKlines.mockResolvedValueOnce(makeKlines(60));
    const provider = new DataProvider(30);
    await provider.refresh(["BTCUSDT"], "1h", 60);
    expect(provider.get("BTCUSDT", "1h")).toBeDefined();

    provider.clear();
    expect(provider.get("BTCUSDT", "1h")).toBeUndefined();
    expect(provider.isStale("BTCUSDT", "1h")).toBe(true);
  });
});

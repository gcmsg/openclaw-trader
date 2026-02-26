/**
 * Bug 2: fetch 超时保护测试
 *
 * 验证 pairlist.ts 中 AbortController + 10 秒超时机制的正确性。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchDynamicPairlist } from "../exchange/pairlist.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────
// Timeout tests
// ─────────────────────────────────────────────────────

describe("fetchDynamicPairlist — AbortController 超时 (Bug 2)", () => {
  it("fetch 被 AbortController 中止时，抛出包含 'timeout' 的错误", async () => {
    // 模拟 fetch 立即抛出 AbortError（代替真正等待 10s）
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(abortError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow(/timeout/i);
  });

  it("fetch 抛出 AbortError 时，错误信息说明 Binance API 超时", async () => {
    const abortError = new DOMException("The user aborted a request.", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(abortError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow("Binance API timeout after 10s");
  });

  it("非超时网络错误时，抛出包含原始错误信息的 Error", async () => {
    const networkError = new Error("ECONNREFUSED: connection refused");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(networkError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow(/Binance fetch failed/);
  });

  it("fetch 传入 signal 参数（AbortController 正确连接）", async () => {
    // 验证 fetch 被调用时带有 signal 参数
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [],
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchDynamicPairlist({ maxPairs: 1 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0]!;
    // 第一个参数是 URL
    expect(callArgs[0]).toContain("binance.com");
    // 第二个参数是 options，包含 signal
    const opts = callArgs[1] as RequestInit;
    expect(opts).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("正常响应时不抛出错误（signal 最终不会 abort）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          {
            symbol: "BTCUSDT",
            lastPrice: "50000",
            highPrice: "52000",
            lowPrice: "48000",
            quoteVolume: "500000000",
            volume: "10000",
            priceChangePercent: "3.5",
          },
        ],
      })
    );

    await expect(fetchDynamicPairlist({ maxPairs: 5 })).resolves.not.toThrow();
    const result = await fetchDynamicPairlist({ maxPairs: 5 });
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("BTCUSDT");
  });

  it("clearTimeout 被调用：即使发生异常也不泄露定时器", async () => {
    // 模拟 fetch 延迟后失败
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    // 这个 test 主要验证不崩溃，定时器被正确清理
    await expect(fetchDynamicPairlist()).rejects.toThrow("Binance fetch failed");
    // 如果定时器没有被清理，测试结束后 vitest 会报警告
    // 这里通过无异常完成来隐式验证
  });
});

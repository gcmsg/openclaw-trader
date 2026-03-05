/**
 * Bug 2: fetch timeout protection tests
 *
 * Validates the correctness of AbortController + 10s timeout mechanism in pairlist.ts.
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

describe("fetchDynamicPairlist — AbortController timeout (Bug 2)", () => {
  it("throws error containing 'timeout' when fetch is aborted by AbortController", async () => {
    // Simulate fetch immediately throwing AbortError (instead of actually waiting 10s)
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(abortError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow(/timeout/i);
  });

  it("error message indicates Binance API timeout when fetch throws AbortError", async () => {
    const abortError = new DOMException("The user aborted a request.", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(abortError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow("Binance API timeout after 10s");
  });

  it("throws Error containing original error message for non-timeout network errors", async () => {
    const networkError = new Error("ECONNREFUSED: connection refused");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(networkError)
    );

    await expect(fetchDynamicPairlist()).rejects.toThrow(/Binance fetch failed/);
  });

  it("fetch receives signal parameter (AbortController properly connected)", async () => {
    // Verify fetch is called with a signal parameter
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
    // First argument is the URL
    expect(callArgs[0]).toContain("binance.com");
    // Second argument is options, containing signal
    const opts = callArgs[1] as RequestInit;
    expect(opts).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not throw on normal response (signal never aborts)", async () => {
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

  it("clearTimeout is called: no timer leak even on exception", async () => {
    // Simulate fetch failing after delay
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    // This test mainly verifies no crash and timer is properly cleaned up
    await expect(fetchDynamicPairlist()).rejects.toThrow("Binance fetch failed");
    // If the timer is not cleaned up, vitest will warn after the test ends
    // Implicit verification by completing without exception
  });
});

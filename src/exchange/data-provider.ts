/**
 * DataProvider — Centralized kline cache (G2)
 *
 * Features:
 *   - Batch pre-fetch klines for multiple symbols (concurrent via Promise.allSettled)
 *   - In-memory Map cache (configurable TTL, default 30 seconds)
 *   - Avoids duplicate fetches for the same symbol within a scan cycle (~70% fewer API requests)
 *
 * Usage (in monitor.ts processScenario):
 *   const provider = new DataProvider(30);
 *   await provider.refresh(symbols, cfg.timeframe, limit);
 *   const klines = provider.get(symbol, cfg.timeframe);  // read from cache
 */

import { getKlines } from "./binance.js";
import type { Kline } from "../types.js";

interface CacheEntry {
  klines: Kline[];
  lastFetch: number;
}

export class DataProvider {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * @param staleSec Cache TTL in seconds. After expiry, isStale() returns true and next fetch will re-pull.
   */
  constructor(private readonly staleSec = 30) {}

  /**
   * Batch pre-fetch klines for symbols (concurrent; failed symbols are silently skipped).
   * If a symbol's cache has not expired, the fetch is skipped.
   */
  async refresh(symbols: string[], timeframe: string, limit: number): Promise<void> {
    await Promise.allSettled(
      symbols.map((sym) => this.fetchOne(sym, timeframe, limit))
    );
  }

  /**
   * Read klines from cache (does not trigger network requests).
   * @returns Kline[] or undefined (not fetched or expired)
   */
  get(symbol: string, timeframe: string): Kline[] | undefined {
    return this.cache.get(cacheKey(symbol, timeframe))?.klines;
  }

  /**
   * Check whether the cache has expired.
   * @returns true = needs re-fetch; false = cache is valid
   */
  isStale(symbol: string, timeframe: string): boolean {
    const entry = this.cache.get(cacheKey(symbol, timeframe));
    if (!entry) return true;
    return Date.now() - entry.lastFetch > this.staleSec * 1000;
  }

  /**
   * Clear all cache (for testing / forced refresh)
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Return all cached keys (for debugging)
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Fetch a single symbol; skip if cache is still fresh */
  private async fetchOne(symbol: string, timeframe: string, limit: number): Promise<void> {
    if (!this.isStale(symbol, timeframe)) return;
    const klines = await getKlines(symbol, timeframe, limit);
    this.cache.set(cacheKey(symbol, timeframe), { klines, lastFetch: Date.now() });
  }
}

/** Cache key: symbol + ":" + timeframe */
function cacheKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

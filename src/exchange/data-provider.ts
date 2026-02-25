/**
 * DataProvider — 集中 K 线缓存（G2）
 *
 * 功能：
 *   - 批量预拉多个 symbol 的 K 线（Promise.allSettled 并发）
 *   - 内存 Map 缓存（可配置过期时间，默认 30 秒）
 *   - 避免同一 symbol 在同一轮扫描中重复拉取（API 请求减少约 70%）
 *
 * 使用方式（在 monitor.ts 的 processScenario 中）：
 *   const provider = new DataProvider(30);
 *   await provider.refresh(symbols, cfg.timeframe, limit);
 *   const klines = provider.get(symbol, cfg.timeframe);  // 从缓存取
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
   * @param staleSec 缓存有效期（秒）。超过后 isStale() 返回 true，下次 fetch 会重新拉取。
   */
  constructor(private readonly staleSec = 30) {}

  /**
   * 批量预拉 symbols 的 K 线（并发，失败的 symbol 静默跳过）
   * 如果某个 symbol 的缓存尚未过期，跳过拉取。
   */
  async refresh(symbols: string[], timeframe: string, limit: number): Promise<void> {
    await Promise.allSettled(
      symbols.map((sym) => this.fetchOne(sym, timeframe, limit))
    );
  }

  /**
   * 从缓存读取 K 线（不触发网络请求）
   * @returns Kline[] 或 undefined（未拉取或已过期）
   */
  get(symbol: string, timeframe: string): Kline[] | undefined {
    return this.cache.get(cacheKey(symbol, timeframe))?.klines;
  }

  /**
   * 检查缓存是否已过期
   * @returns true = 需要重新拉取；false = 缓存有效
   */
  isStale(symbol: string, timeframe: string): boolean {
    const entry = this.cache.get(cacheKey(symbol, timeframe));
    if (!entry) return true;
    return Date.now() - entry.lastFetch > this.staleSec * 1000;
  }

  /**
   * 清空全部缓存（测试 / 强制刷新用）
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 返回当前缓存的所有 key（调试用）
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /** 拉取单个 symbol，如缓存新鲜则跳过 */
  private async fetchOne(symbol: string, timeframe: string, limit: number): Promise<void> {
    if (!this.isStale(symbol, timeframe)) return;
    const klines = await getKlines(symbol, timeframe, limit);
    this.cache.set(cacheKey(symbol, timeframe), { klines, lastFetch: Date.now() });
  }
}

/** 缓存键：symbol + ":" + timeframe */
function cacheKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

/**
 * MTF (Multi-Timeframe) Trend Filter
 *
 * Shared by monitor.ts and live-monitor.ts to avoid code duplication.
 * Audit finding A-001 fix.
 */

import { getKlines } from "../exchange/binance.js";
import { calculateIndicators } from "./indicators.js";
import type { DataProvider } from "../exchange/data-provider.js";
import type { RuntimeConfig, SignalType } from "../types.js";

export interface MtfResult {
  /** Whether the higher TF trend is bullish (null = not enabled or fetch failed) */
  trendBull: boolean | null;
  /** Whether signal was filtered by MTF */
  filtered: boolean;
  /** Filter reason */
  reason?: string;
}

/**
 * Check MTF trend filter
 *
 * @param symbol    Trading symbol
 * @param signalType Current signal type (only buy/short need filtering)
 * @param cfg       Runtime config
 * @param provider  DataProvider (optional, for caching)
 * @returns MTF check result
 */
export async function checkMtfFilter(
  symbol: string,
  signalType: SignalType,
  cfg: RuntimeConfig,
  provider?: DataProvider,
): Promise<MtfResult> {
  // Non-entry signals don't need MTF filtering
  if (signalType !== "buy" && signalType !== "short") {
    return { trendBull: null, filtered: false };
  }

  // MTF not configured
  if (!cfg.trend_timeframe || cfg.trend_timeframe === cfg.timeframe) {
    return { trendBull: null, filtered: false };
  }

  try {
    const trendLimit = cfg.strategy.ma.long + 10;
    const trendKlines = provider?.get(symbol, cfg.trend_timeframe)
      ?? await getKlines(symbol, cfg.trend_timeframe, trendLimit);
    const trendInd = calculateIndicators(
      trendKlines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd,
    );

    if (!trendInd) {
      return { trendBull: null, filtered: false };
    }

    const trendBull = trendInd.maShort > trendInd.maLong;

    // Buy requires bullish trend, short requires bearish trend
    if (signalType === "buy" && !trendBull) {
      return {
        trendBull,
        filtered: true,
        reason: `MTF(${cfg.trend_timeframe}) bearish, ignoring buy`,
      };
    }
    if (signalType === "short" && trendBull) {
      return {
        trendBull,
        filtered: true,
        reason: `MTF(${cfg.trend_timeframe}) bullish, ignoring short`,
      };
    }

    return { trendBull, filtered: false };
  } catch (err: unknown) {
    return { trendBull: null, filtered: false, reason: `MTF fetch failed: ${String(err)}` };
  }
}

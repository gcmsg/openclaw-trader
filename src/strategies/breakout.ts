/**
 * Trend Breakout Strategy Plugin (F4)
 *
 * Logic:
 *   Close > highest close of past N klines + volume > avg volume x volumeMultiplier -> buy
 *   Close < lowest close of past N klines -> sell
 *   Otherwise -> none
 *
 * Use case: Trending Regime
 * Parameters:
 *   lookback: number (default 20, lookback kline count, excluding current)
 *   volumeMultiplier: number (default 1.5, volume confirmation multiplier)
 *
 * Usage (paper.yaml scenario level):
 *   strategy_plugin_id: "breakout"
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";

/** Default lookback window (number of klines, excluding current) */
const DEFAULT_LOOKBACK = 20;

/** Default volume surge multiplier */
const DEFAULT_VOLUME_MULTIPLIER = 1.5;

const breakoutStrategy: Strategy = {
  id: "breakout",
  name: "Trend Breakout",
  description:
    "Close breaks above highest of past N klines + volume surge -> buy; breaks below lowest -> sell. Suitable for trending markets.",

  populateSignal(ctx: StrategyContext): SignalType {
    const { klines, indicators } = ctx;

    const lookback = DEFAULT_LOOKBACK;
    const volumeMultiplier = DEFAULT_VOLUME_MULTIPLIER;

    // Need enough historical data (at least lookback + 1 klines)
    if (klines.length < lookback + 1) {
      return "none";
    }

    // Past N klines (excluding the current/last one)
    const window = klines.slice(-(lookback + 1), -1);
    const currentKline = klines[klines.length - 1]!;

    const currentClose = currentKline.close;
    const currentVolume = currentKline.volume;

    // Calculate highest/lowest close within the window
    let windowHigh = -Infinity;
    let windowLow = Infinity;
    let windowAvgVolume = 0;

    for (const k of window) {
      if (k.close > windowHigh) windowHigh = k.close;
      if (k.close < windowLow) windowLow = k.close;
      windowAvgVolume += k.volume;
    }
    windowAvgVolume = windowAvgVolume / window.length;

    // Break above upper band + volume confirmation -> buy
    if (currentClose > windowHigh && windowAvgVolume > 0 && currentVolume >= windowAvgVolume * volumeMultiplier) {
      return "buy";
    }

    // Break below lower band -> sell
    if (currentClose < windowLow) {
      return "sell";
    }

    // Can also use indicators.avgVolume for volume data (complementary to window calculation above)
    // Here we prioritize window-based average volume to ensure breakout and volume checks use the same data scope
    void indicators; // Suppress unused warning (can be used in future extensions)

    return "none";
  },
};

// Auto-register (triggered on import)
registerStrategy(breakoutStrategy);

export { breakoutStrategy };

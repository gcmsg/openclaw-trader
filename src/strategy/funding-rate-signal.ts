/**
 * Funding Rate Contrarian Strategy Signal
 *
 * Logic: Extreme funding rate = market heavily skewed to one side = reversal precursor
 *
 *   Funding rate > +long_threshold%  -> longs extremely crowded -> contrarian short signal (funding_rate_overlong)
 *   Funding rate < -short_threshold% -> shorts extremely crowded -> contrarian long signal (funding_rate_overshort)
 *
 * Reference thresholds (Binance perpetual 8h funding rate):
 *   Long extreme: +0.30% (annualized ~328%), typically signals short-term pullback
 *   Short extreme: -0.15% (annualized ~164%), shorts overcrowded, short squeeze risk
 *
 * Usage:
 *   Add to buy/sell/short/cover conditions in strategy.yaml:
 *     buy:  [ma_bullish, funding_rate_overshort]   # shorts crowded + uptrend = strong long
 *     short: [ma_bearish, funding_rate_overlong]   # longs crowded + downtrend = strong short
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFundingRate } from "../exchange/futures-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FR_CACHE_PATH = path.resolve(__dirname, "../../logs/funding-rate-cache.json");

// ─── Types ──────────────────────────────────────────────

export type FundingSignal = "overlong" | "overshort" | "neutral";

export type FundingRateCache = Record<string, {
  ratePct: number;   // Funding rate percentage (e.g. +0.03 = +0.03%)
  fetchedAt: number; // Fetch timestamp (ms)
}>;

// ─── Cache IO ──────────────────────────────────────────

/** Read funding rate cache (returns undefined if miss or expired) */
export function readFundingRateCache(symbol: string, maxAgeMs = 10 * 60_000): number | undefined {
  try {
    if (!fs.existsSync(FR_CACHE_PATH)) return undefined;
    const cache = JSON.parse(fs.readFileSync(FR_CACHE_PATH, "utf-8")) as FundingRateCache;
    const entry = cache[symbol.toUpperCase()];
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > maxAgeMs) return undefined;
    return entry.ratePct;
  } catch {
    return undefined;
  }
}

/** Write funding rate cache */
export function writeFundingRateCache(symbol: string, ratePct: number): void {
  let cache: FundingRateCache = {};
  try {
    if (fs.existsSync(FR_CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(FR_CACHE_PATH, "utf-8")) as FundingRateCache;
    }
  } catch { /* Read failed, create new */ }
  cache[symbol.toUpperCase()] = { ratePct, fetchedAt: Date.now() };
  fs.mkdirSync(path.dirname(FR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(FR_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ─── Core Logic ─────────────────────────────────────────

/**
 * Check if funding rate is in extreme territory
 *
 * @param ratePct        Funding rate percentage (e.g. +0.03 = +0.03%)
 * @param longThreshold  Long extreme threshold (default +0.30%)
 * @param shortThreshold Short extreme threshold (absolute value, default 0.15%)
 */
export function checkFundingRateSignal(
  ratePct: number,
  longThreshold = 0.30,
  shortThreshold = 0.15
): FundingSignal {
  if (ratePct > longThreshold) return "overlong";
  if (ratePct < -shortThreshold) return "overshort";
  return "neutral";
}

// ─── Fetch Funding Rate (with cache) ───────────────────────────

/**
 * Fetch funding rate (reads cache first, valid for 10 minutes)
 * Returns percentage value, e.g. +0.03 = +0.03%
 */
export async function fetchFundingRatePct(symbol: string): Promise<number | undefined> {
  // Read cache first
  const cached = readFundingRateCache(symbol);
  if (cached !== undefined) return cached;

  // Cache expired or doesn't exist, fetch new data
  try {
    const fr = await getFundingRate(symbol);
    const ratePct = fr.fundingRate * 100; // Decimal to percentage
    writeFundingRateCache(symbol, ratePct);
    return ratePct;
  } catch {
    return undefined;
  }
}

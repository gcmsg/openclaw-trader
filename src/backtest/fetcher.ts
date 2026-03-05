/**
 * Historical Kline Data Fetcher
 * - Supports paginated fetching (Binance max 1000 per request)
 * - Local disk caching to avoid duplicate requests
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Kline } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../../logs/kline-cache");
const BASE_URL = "api.binance.com";
const BATCH_SIZE = 1000;
const REQUEST_DELAY_MS = 250; // Avoid Binance API rate limiting

/** Binance error response structure (negative code indicates API error) */
interface BinanceErrorBody {
  code: number;
  msg: string;
}

function isBinanceError(obj: unknown): obj is BinanceErrorBody {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "code" in obj &&
    typeof (obj as Record<string, unknown>)["code"] === "number" &&
    ((obj as Record<string, unknown>)["code"] as number) < 0
  );
}

function request(urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: BASE_URL, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(data) as unknown;
          if (isBinanceError(parsed)) {
            reject(new Error(`Binance API Error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch (_e: unknown) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("Request timeout")));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cache file path (partitioned by date) */
function cachePath(symbol: string, interval: string, dateStr: string): string {
  return path.join(CACHE_DIR, `${symbol}_${interval}_${dateStr}.json`);
}

/** Read cache (returns null if not found) */
function readCache(file: string): Kline[] | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Kline[];
  } catch (_e: unknown) {
    return null;
  }
}

/** Write cache */
function writeCache(file: string, klines: Kline[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(klines));
}

/**
 * Fetch complete historical kline data (paginated + cached)
 *
 * @param symbol   trading pair, e.g. "BTCUSDT"
 * @param interval kline interval, e.g. "1h"
 * @param startMs  start timestamp (milliseconds)
 * @param endMs    end timestamp (milliseconds)
 * @param onProgress optional progress callback
 */
export async function fetchHistoricalKlines(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
  onProgress?: (fetched: number) => void
): Promise<Kline[]> {
  // Try to read full range cache (keyed by date range)
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const cacheFile = cachePath(symbol, interval, `${startDate}_${endDate}`);
  const cached = readCache(cacheFile);
  if (cached) return cached;

  const allKlines: Kline[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const urlPath =
      `/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${BATCH_SIZE}`;

    const raw = (await request(urlPath)) as [
      number,
      string,
      string,
      string,
      string,
      string,
      number,
    ][];

    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      allKlines.push({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      });
    }

    onProgress?.(allKlines.length);

    cursor = (raw[raw.length - 1]?.[6] ?? 0) + 1;
    if (raw.length < BATCH_SIZE) break; // reached the end

    await sleep(REQUEST_DELAY_MS);
  }

  // Write cache (only cache data before today, avoid caching incomplete current-day data)
  const today = new Date().toISOString().slice(0, 10);
  if (endDate < today) {
    writeCache(cacheFile, allKlines);
  }

  return allKlines;
}

// ─────────────────────────────────────────────────────
// Historical Funding Rate Fetching (Futures backtest only)
// ─────────────────────────────────────────────────────

export interface FundingRateRecord {
  ts: number;    // fundingTime (milliseconds)
  rate: number;  // funding rate, e.g. -0.0001 means -0.01%
}

/**
 * Fetch Binance Futures historical funding rates
 * Settled every 8 hours (00:00 / 08:00 / 16:00 UTC)
 *
 * @param symbol  trading pair, e.g. "BTCUSDT"
 * @param startMs start timestamp (milliseconds)
 * @param endMs   end timestamp (milliseconds)
 */
export async function fetchHistoricalFundingRates(
  symbol: string,
  startMs: number,
  endMs: number
): Promise<FundingRateRecord[]> {
  const cacheFile = path.join(CACHE_DIR, `funding_${symbol}_${new Date(startMs).toISOString().slice(0, 10)}_${new Date(endMs).toISOString().slice(0, 10)}.json`);
  const cached = (() => {
    try { return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as FundingRateRecord[]; }
    catch { return null; }
  })();
  if (cached) return cached;

  interface BinanceFunding { symbol: string; fundingTime: number; fundingRate: string }
  const all: FundingRateRecord[] = [];
  let cursor = startMs;
  const LIMIT = 1000;

  while (cursor < endMs) {
    const urlPath = `/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT}`;
    let raw: BinanceFunding[];
    try {
      raw = (await (new Promise<unknown>((resolve, reject) => {
        const req = https.get({ hostname: "fapi.binance.com", path: urlPath }, (res) => {
          let data = "";
          res.on("data", (c: string) => data += c);
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); } });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
      }))) as BinanceFunding[];
    } catch { break; }

    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const r of raw) {
      all.push({ ts: r.fundingTime, rate: parseFloat(r.fundingRate) });
    }
    cursor = (raw[raw.length - 1]?.fundingTime ?? 0) + 1;
    if (raw.length < LIMIT) break;
    await sleep(REQUEST_DELAY_MS);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (new Date(endMs).toISOString().slice(0, 10) < today) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(all));
  }
  return all;
}

/**
 * Clean up expired cache (default: keep cache files within 30 days)
 */
export function pruneKlineCache(keepDays = 30): void {
  if (!fs.existsSync(CACHE_DIR)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const fullPath = path.join(CACHE_DIR, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}

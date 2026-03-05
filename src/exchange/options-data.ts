/**
 * P6.4 — Options Market Signal
 *
 * Data source: Deribit public API (no Key required)
 * GET https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 *
 * Extracts:
 *   - iv30d: Near-month contract implied volatility (approximate 30-day IV)
 *   - ivPercentile: IV percentile over the past 90 days (rough estimate since Deribit API lacks historical IV)
 *   - putCallRatio: Put/Call open interest ratio across all expiries
 *
 * Signal classification:
 *   ivSignal:  low(<30) / normal(30-60) / elevated(60-90) / extreme(>90)
 *   pcSignal:  bullish(<0.7) / neutral(0.7-1.2) / bearish(>1.2)
 *   positionSizeMultiplier: extreme->0.5, elevated->0.7, normal->1.0, low->1.2
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Force IPv4 (when server IPv6 is unreachable)
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_CACHE_PATH = path.resolve(__dirname, "../../logs/options-cache.json");
const OPTIONS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Type Definitions ──────────────────────────────────────────

export interface OptionsSummary {
  symbol: "BTC" | "ETH";
  iv30d: number;              // Near-month contract IV (percentage, e.g. 65.3 means 65.3%)
  ivPercentile: number;       // IV percentile estimate over past 90 days (0-100)
  putCallRatio: number;       // Put OI / Call OI
  ivSignal: "low" | "normal" | "elevated" | "extreme";
  pcSignal: "bullish" | "neutral" | "bearish";
  positionSizeMultiplier: number; // Position size recommendation multiplier
  generatedAt: number;
}

interface DeribitOptionItem {
  instrument_name: string;
  open_interest: number;
  mark_iv: number;
  expiration_timestamp?: number;
  // Many fields available; only using what's needed
}

interface DeribitApiResponse {
  result: DeribitOptionItem[];
}

// ─── IV Classification Logic ──────────────────────────────────────────

export function classifyIvSignal(iv: number): OptionsSummary["ivSignal"] {
  if (iv < 30) return "low";
  if (iv < 60) return "normal";
  if (iv < 90) return "elevated";
  return "extreme";
}

export function classifyPcSignal(pcr: number): OptionsSummary["pcSignal"] {
  if (pcr < 0.7) return "bullish";
  if (pcr <= 1.2) return "neutral";
  return "bearish";
}

export function calcPositionSizeMultiplier(ivSignal: OptionsSummary["ivSignal"]): number {
  switch (ivSignal) {
    case "extreme":  return 0.5;
    case "elevated": return 0.7;
    case "normal":   return 1.0;
    case "low":      return 1.2;
  }
}

/**
 * Rough IV percentile estimate: compare current IV against historical common ranges.
 * (No historical data available, so using linear interpolation: 30=10th, 60=50th, 90=90th, 120=99th)
 */
export function estimateIvPercentile(iv: number): number {
  if (iv <= 20) return 5;
  if (iv <= 30) return 10 + ((iv - 20) / 10) * 15;   // 10-25
  if (iv <= 60) return 25 + ((iv - 30) / 30) * 40;   // 25-65
  if (iv <= 90) return 65 + ((iv - 60) / 30) * 25;   // 65-90
  if (iv <= 120) return 90 + ((iv - 90) / 30) * 9;   // 90-99
  return 99;
}

// ─── Deribit HTTP Request ──────────────────────────────────

function fetchDeribitOptions(currency: "BTC" | "ETH"): Promise<DeribitOptionItem[]> {
  return new Promise((resolve, reject) => {
    const hostname = "www.deribit.com";
    const path = `/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const req = https.request(
      {
        hostname,
        path,
        method: "GET",
        agent: ipv4Agent,
        headers: { "User-Agent": "curl/7.88", "Accept": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as DeribitApiResponse;
            resolve(parsed.result);
          } catch (e) {
            reject(new Error(`Deribit parse error: ${String(e)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Deribit timeout")); });
    req.end();
  });
}

// ─── Core Logic ──────────────────────────────────────────

/**
 * Fetch BTC/ETH options market data from Deribit API, extracting IV and PCR
 */
export async function fetchOptionsSummary(symbol: "BTC" | "ETH"): Promise<OptionsSummary> {
  const items = await fetchDeribitOptions(symbol);

  if (items.length === 0) {
    throw new Error(`Deribit returned empty data for ${symbol}`);
  }

  // Separate Puts and Calls
  const puts: DeribitOptionItem[] = [];
  const calls: DeribitOptionItem[] = [];

  for (const item of items) {
    const name = item.instrument_name;
    if (name.endsWith("-P")) {
      puts.push(item);
    } else if (name.endsWith("-C")) {
      calls.push(item);
    }
  }

  // PCR = sum(put OI) / sum(call OI)
  const totalPutOI = puts.reduce((sum, p) => sum + p.open_interest, 0);
  const totalCallOI = calls.reduce((sum, c) => sum + c.open_interest, 0);
  const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 1.0;

  // Near-month contract IV (nearest expiry contracts with mark_iv > 0)
  // Sort by expiration_timestamp to find nearest expiry
  const now = Date.now();
  const validItems = items.filter(
    (item) =>
      typeof item.mark_iv === "number" &&
      item.mark_iv > 0 &&
      (item.expiration_timestamp === undefined || item.expiration_timestamp > now)
  );

  let iv30d = 0;
  if (validItems.length > 0) {
    // Sort by expiry ascending (those without expiration_timestamp go last)
    const sorted = [...validItems].sort((a, b) => {
      const ta = a.expiration_timestamp ?? Infinity;
      const tb = b.expiration_timestamp ?? Infinity;
      return ta - tb;
    });

    // Take median IV of nearest expiry contracts (avoid outliers from single contracts)
    const nearExpiry = sorted[0]?.expiration_timestamp;
    const nearContracts = sorted.filter(
      (i) => i.expiration_timestamp === nearExpiry || nearExpiry === undefined
    );
    const ivValues = nearContracts.map((i) => i.mark_iv).sort((a, b) => a - b);
    const mid = Math.floor(ivValues.length / 2);
    iv30d = ivValues[mid] ?? ivValues[0] ?? 0;
  }

  if (iv30d === 0) {
    // Fallback: take median mark_iv of all contracts
    const allIvs = validItems.map((i) => i.mark_iv).sort((a, b) => a - b);
    const mid = Math.floor(allIvs.length / 2);
    iv30d = allIvs[mid] ?? 50; // Default 50% (normal level)
  }

  const ivSignal = classifyIvSignal(iv30d);
  const pcSignal = classifyPcSignal(putCallRatio);
  const positionSizeMultiplier = calcPositionSizeMultiplier(ivSignal);
  const ivPercentile = estimateIvPercentile(iv30d);

  return {
    symbol,
    iv30d: Math.round(iv30d * 10) / 10,
    ivPercentile: Math.round(ivPercentile),
    putCallRatio: Math.round(putCallRatio * 100) / 100,
    ivSignal,
    pcSignal,
    positionSizeMultiplier,
    generatedAt: Date.now(),
  };
}

// ─── Cache Read/Write ──────────────────────────────────────────

interface OptionsCache {
  BTC?: OptionsSummary;
  ETH?: OptionsSummary;
}

export function readOptionsCache(): OptionsCache {
  try {
    const raw = fs.readFileSync(OPTIONS_CACHE_PATH, "utf-8");
    return JSON.parse(raw) as OptionsCache;
  } catch {
    return {};
  }
}

export function writeOptionsCache(summary: OptionsSummary): void {
  try {
    fs.mkdirSync(path.dirname(OPTIONS_CACHE_PATH), { recursive: true });
    const existing = readOptionsCache();
    existing[summary.symbol] = summary;
    fs.writeFileSync(OPTIONS_CACHE_PATH, JSON.stringify(existing, null, 2));
  } catch { /* Silently skip on write failure */ }
}

export function getCachedOptionsSummary(symbol: "BTC" | "ETH"): OptionsSummary | null {
  const cache = readOptionsCache();
  const entry = cache[symbol];
  if (!entry) return null;
  if (Date.now() - entry.generatedAt > OPTIONS_CACHE_TTL_MS) return null;
  return entry;
}

// ─── Format Report ──────────────────────────────────────────

export function formatOptionsReport(summary: OptionsSummary): string {
  const ivEmoji = {
    low:      "🟢",
    normal:   "🟡",
    elevated: "🟠",
    extreme:  "🔴",
  }[summary.ivSignal];

  const pcEmoji = {
    bullish: "🐂",
    neutral: "⚖️",
    bearish: "🐻",
  }[summary.pcSignal];

  const multiplierNote = summary.positionSizeMultiplier < 1.0
    ? `(Recommend reducing position to ${(summary.positionSizeMultiplier * 100).toFixed(0)}%)`
    : summary.positionSizeMultiplier > 1.0
    ? "(Low IV, can increase position size)"
    : "";

  return [
    `📊 **${summary.symbol} Options Market**`,
    `${ivEmoji} IV: ${summary.iv30d.toFixed(1)}%  [${summary.ivSignal}]  Percentile ${summary.ivPercentile}%`,
    `${pcEmoji} PCR: ${summary.putCallRatio.toFixed(2)}  [${summary.pcSignal}]`,
    `🎯 Position Multiplier: x${summary.positionSizeMultiplier.toFixed(1)} ${multiplierNote}`,
  ].join("\n");
}

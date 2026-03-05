/**
 * P6.2 — Dynamic Pairlist
 *
 * Automatically selects optimal trading pairs daily from Binance, replacing fixed symbol lists.
 * Calls Binance 24h ticker endpoint (no API Key required) for filtering and ranking.
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface PairlistConfig {
  minMarketCapUsd?: number; // Minimum market cap (volume proxy), default 1B
  minVolume24hUsd?: number; // Minimum 24h volume in USDT, default 50M
  maxPairs?: number; // Maximum number of pairs to select, default 15
  blacklist?: string[]; // Force-exclude list
  whitelist?: string[]; // Force-include list
  sortBy?: "volume" | "volatility" | "momentum"; // Sort criteria, default volume
}

export interface RankedPair {
  symbol: string;
  volume24hUsd: number;
  priceChangePercent: number;
  volatility: number; // (high - low) / close × 100 (%)
  score: number; // Composite score (value used for sorting)
}

/** Binance /api/v3/ticker/24hr single ticker fields */
export interface BinanceTicker24h {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string; // base asset volume
  quoteVolume: string; // quote asset volume (USDT for USDT pairs)
  highPrice: string;
  lowPrice: string;
}

// ─────────────────────────────────────────────────────
// Filter constants
// ─────────────────────────────────────────────────────

/** Stablecoin base names (exclude these as base asset USDT pairs) */
const STABLECOIN_BASES = new Set([
  "USDT", "BUSD", "USDC", "DAI", "TUSD", "USDP",
  "FDUSD", "USDD", "FRAX", "PYUSD", "SUSD",
  "USD1", "USDX", "USDE", "USDJ", // New stablecoins: USD1(Circle), etc.
  "UU",   // UU token, pegged at $1.00, stablecoin nature
  "U",    // UUSDT (Universal USD), stablecoin
]);

/** Asset-backed tokens (gold/commodities, not crypto assets) */
const NON_CRYPTO_BASES = new Set([
  "PAXG",  // Gold token (Paxos Gold)
  "XAUT",  // Tether Gold
  "DGLD",  // DigitGold
  "EUR", "GBP", "AUD", "JPY", "CHF", "CAD", "NZD", // Forex pairs, not crypto assets
]);

/** Leveraged token suffixes */
const LEVERAGED_SUFFIXES = ["UP", "DOWN", "BEAR", "BULL"];

/** Check if it's a stablecoin USDT pair (e.g. USDCUSDT, BUSDUSDT) */
function isStablecoinPair(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  return STABLECOIN_BASES.has(base);
}

/** Check if it's a leveraged token (e.g. BTCUPUSDT, ETHDOWNUSDT) */
function isLeveragedToken(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  return LEVERAGED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/** Check if it's a non-crypto asset (gold/commodity tokens, etc.) */
function isNonCryptoAsset(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  return NON_CRYPTO_BASES.has(base);
}

// ─────────────────────────────────────────────────────
// Main functions
// ─────────────────────────────────────────────────────

/**
 * Fetch 24h tickers from Binance, filter and rank by rules, return RankedPair array.
 *
 * @param cfg - Filter configuration (optional, all have defaults)
 * @returns Ranked trading pair list (sorted by sortBy in descending order)
 */
export async function fetchDynamicPairlist(cfg?: PairlistConfig): Promise<RankedPair[]> {
  const minVolume = cfg?.minVolume24hUsd ?? 50_000_000;
  const maxPairs = cfg?.maxPairs ?? 15;
  const blacklist = cfg?.blacklist ?? [];
  const whitelist = cfg?.whitelist ?? [];
  const sortBy = cfg?.sortBy ?? "volume";

  // 1. Fetch Binance 24h tickers (AbortController 10s timeout protection)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  let tickers: BinanceTicker24h[];
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }
    tickers = (await response.json()) as BinanceTicker24h[];
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Binance API timeout after 10s");
    }
    if (err instanceof Error && err.message.startsWith("Binance API error:")) {
      throw err;
    }
    throw new Error(`Binance fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Filter
  const filtered = tickers.filter((t) => {
    // Only keep USDT-denominated pairs
    if (!t.symbol.endsWith("USDT")) return false;
    // Exclude stablecoin pairs
    if (isStablecoinPair(t.symbol)) return false;
    // Exclude leveraged tokens
    if (isLeveragedToken(t.symbol)) return false;
    // Exclude non-crypto assets (gold/commodity tokens, etc.)
    if (isNonCryptoAsset(t.symbol)) return false;
    // Exclude blacklist
    if (blacklist.includes(t.symbol)) return false;
    // Volume filter
    const vol = parseFloat(t.quoteVolume);
    if (vol < minVolume) return false;
    // Minimum volatility filter (exclude stablecoins/forex pairs with low volatility, threshold 0.5%)
    const lastPrice = parseFloat(t.lastPrice);
    const highPrice = parseFloat(t.highPrice);
    const lowPrice = parseFloat(t.lowPrice);
    if (lastPrice > 0 && (highPrice - lowPrice) / lastPrice < 0.005) return false;
    return true;
  });

  // 3. Convert to RankedPair
  const pairs: RankedPair[] = filtered.map((t) => {
    const lastPrice = parseFloat(t.lastPrice);
    const highPrice = parseFloat(t.highPrice);
    const lowPrice = parseFloat(t.lowPrice);
    const quoteVolume = parseFloat(t.quoteVolume);
    const priceChangePercent = parseFloat(t.priceChangePercent);

    // Volatility: (high - low) / close (0 if close=0)
    const volatility = lastPrice > 0 ? (highPrice - lowPrice) / lastPrice : 0;

    // Score: based on sortBy
    let score: number;
    if (sortBy === "volume") {
      score = quoteVolume;
    } else if (sortBy === "volatility") {
      score = volatility;
    } else {
      // momentum: absolute price change percentage
      score = Math.abs(priceChangePercent);
    }

    return {
      symbol: t.symbol,
      volume24hUsd: quoteVolume,
      priceChangePercent,
      volatility,
      score,
    };
  });

  // 4. Sort descending
  pairs.sort((a, b) => b.score - a.score);

  // 5. Process whitelist: force-include (supplement from raw tickers if not in filtered)
  const whitelistPairs: RankedPair[] = [];
  const whitelistSet = new Set(whitelist);
  const filteredSymbols = new Set(pairs.map((p) => p.symbol));

  for (const sym of whitelist) {
    if (filteredSymbols.has(sym)) continue; // Already in filtered, will be added later
    // Look up in raw tickers
    const t = tickers.find((tk) => tk.symbol === sym);
    if (!t) continue;
    const lastPrice = parseFloat(t.lastPrice);
    const highPrice = parseFloat(t.highPrice);
    const lowPrice = parseFloat(t.lowPrice);
    whitelistPairs.push({
      symbol: sym,
      volume24hUsd: parseFloat(t.quoteVolume),
      priceChangePercent: parseFloat(t.priceChangePercent),
      volatility: lastPrice > 0 ? (highPrice - lowPrice) / lastPrice : 0,
      score: 0, // Whitelist items don't participate in ranking
    });
  }

  // 6. Combine results: whitelist first, then fill up to maxPairs by rank
  const result: RankedPair[] = [...whitelistPairs];

  for (const p of pairs) {
    if (result.length >= maxPairs) break;
    // Skip if already added from whitelist (if it came from filtered), avoid duplicates
    if (whitelistSet.has(p.symbol) && result.find((r) => r.symbol === p.symbol)) continue;
    if (result.find((r) => r.symbol === p.symbol)) continue;
    result.push(p);
  }

  return result;
}

/**
 * Compare with current config, output added/removed/unchanged symbols.
 */
export function diffPairlist(
  current: string[],
  next: string[]
): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const currentSet = new Set(current);
  const nextSet = new Set(next);

  return {
    added: next.filter((s) => !currentSet.has(s)),
    removed: current.filter((s) => !nextSet.has(s)),
    unchanged: current.filter((s) => nextSet.has(s)),
  };
}

/**
 * Format dynamic pairlist report (human-readable text).
 */
export function formatPairlistReport(
  pairs: RankedPair[],
  diff?: ReturnType<typeof diffPairlist>
): string {
  const lines: string[] = ["📊 Dynamic Pairlist Report", ""];

  if (diff) {
    if (diff.added.length > 0) {
      lines.push(`✅ Added   (${diff.added.length}): ${diff.added.join(", ")}`);
    }
    if (diff.removed.length > 0) {
      lines.push(`❌ Removed (${diff.removed.length}): ${diff.removed.join(", ")}`);
    }
    if (diff.unchanged.length > 0) {
      lines.push(`🔄 Unchanged (${diff.unchanged.length}): ${diff.unchanged.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(`Total: ${pairs.length} pairs selected`);
  lines.push("");
  lines.push(
    `${"Symbol".padEnd(14)} ${"Volume24h(M)".padStart(12)}  ${"Change%".padStart(8)}  ${"Volatility%".padStart(11)}  Score`
  );
  lines.push("─".repeat(64));

  for (const p of pairs) {
    const vol = (p.volume24hUsd / 1_000_000).toFixed(1);
    const change = p.priceChangePercent.toFixed(2);
    const volatility = (p.volatility * 100).toFixed(2);
    const score = p.score.toFixed(0);
    lines.push(
      `${p.symbol.padEnd(14)} ${vol.padStart(12)}  ${change.padStart(8)}  ${volatility.padStart(11)}  ${score}`
    );
  }

  return lines.join("\n");
}

/**
 * Liquidation Heatmap — Binance Futures forced liquidation data (P5.3)
 *
 * Data source: Binance Futures public API (no API Key required)
 *   GET https://fapi.binance.com/fapi/v1/allForceOrders
 *
 * Usage:
 *   - Long liquidations (long_squeeze): Longs liquidated during price drops, possible bounce ahead
 *   - Short liquidations (short_squeeze): Shorts liquidated during price rises, may accelerate rally
 *   - Dense liquidation zones represent risk concentration points, aiding support/resistance analysis
 */

import https from "https";

// Force IPv4 (when server IPv6 is unreachable)
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

// ─── Type Definitions ──────────────────────────────────────────

/** Binance raw forced liquidation order fields */
interface RawForceOrder {
  symbol: string;
  price: string;          // Liquidation price
  origQty: string;        // Quantity (contracts)
  executedQty: string;    // Actual executed quantity
  averagePrice: string;   // Average fill price
  status: string;         // FILLED / PARTIALLY_FILLED
  timeInForce: string;
  type: string;           // LIMIT
  side: string;           // BUY (short liquidation) | SELL (long liquidation)
  time: number;           // Timestamp ms
}

export interface LiquidationSummary {
  /** Total long liquidation amount (USD) */
  totalLongLiqUsd: number;
  /** Total short liquidation amount (USD) */
  totalShortLiqUsd: number;
  /** Net liquidation pressure (positive = more short liquidations = bullish signal) */
  netLiqPressure: number;
  /** Dominant direction */
  dominance: "long_squeeze" | "short_squeeze" | "balanced";
  /** Dominance ratio (larger/smaller, < 1.2 considered balanced) */
  dominanceRatio: number;
  /** Total liquidation records */
  recordCount: number;
  /** Liquidation price range */
  priceRange: { min: number; max: number };
  /** Generated timestamp */
  generatedAt: number;
}

// ─── Internal Requests ──────────────────────────────────────────

function fetchForceOrders(
  symbol: string,
  startTime?: number,
  limit = 100
): Promise<RawForceOrder[]> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      symbol,
      limit: String(Math.min(limit, 1000)),
    });
    if (startTime !== undefined) {
      params.set("startTime", String(startTime));
    }

    const hostname = "fapi.binance.com";
    const path = `/fapi/v1/allForceOrders?${params.toString()}`;

    const req = https.request(
      {
        hostname,
        path,
        method: "GET",
        agent: ipv4Agent,
        headers: { "User-Agent": "openclaw-trader/1.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data) as RawForceOrder[] | { code: number; msg: string };
            if (!Array.isArray(json)) {
              reject(new Error(`Binance API error: ${JSON.stringify(json)}`));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("liquidation fetch timeout"));
    });
    req.end();
  });
}

// ─── Public Interface ──────────────────────────────────────────

/**
 * Get liquidation summary for a given symbol over the past N hours.
 *
 * @param symbol        Contract symbol, e.g. "BTCUSDT"
 * @param lookbackHours Lookback period in hours (default 24h)
 */
export async function getLiquidationData(
  symbol: string,
  lookbackHours = 24
): Promise<LiquidationSummary> {
  const startTime = Date.now() - lookbackHours * 3_600_000;
  const orders = await fetchForceOrders(symbol, startTime, 1000);

  let totalLongLiqUsd = 0;   // SELL side = long liquidation
  let totalShortLiqUsd = 0;  // BUY  side = short liquidation
  let priceMin = Infinity;
  let priceMax = -Infinity;

  for (const o of orders) {
    const price = parseFloat(o.averagePrice) || parseFloat(o.price);
    const qty = parseFloat(o.executedQty) || parseFloat(o.origQty);
    const usd = price * qty;

    if (!isFinite(usd) || usd <= 0) continue;

    if (o.side === "SELL") {
      // Long liquidation: price drop triggers SELL forced liquidation
      totalLongLiqUsd += usd;
    } else {
      // Short liquidation: price rise triggers BUY forced liquidation
      totalShortLiqUsd += usd;
    }

    if (price < priceMin) priceMin = price;
    if (price > priceMax) priceMax = price;
  }

  const netLiqPressure = totalShortLiqUsd - totalLongLiqUsd;
  const larger = Math.max(totalLongLiqUsd, totalShortLiqUsd);
  const smaller = Math.min(totalLongLiqUsd, totalShortLiqUsd);
  const dominanceRatio = smaller > 0 ? larger / smaller : larger > 0 ? Infinity : 1;

  let dominance: LiquidationSummary["dominance"];
  if (dominanceRatio < 1.2) {
    dominance = "balanced";
  } else if (totalLongLiqUsd > totalShortLiqUsd) {
    dominance = "long_squeeze";
  } else {
    dominance = "short_squeeze";
  }

  return {
    totalLongLiqUsd,
    totalShortLiqUsd,
    netLiqPressure,
    dominance,
    dominanceRatio: isFinite(dominanceRatio) ? dominanceRatio : 0,
    recordCount: orders.length,
    priceRange: {
      min: isFinite(priceMin) ? priceMin : 0,
      max: isFinite(priceMax) ? priceMax : 0,
    },
    generatedAt: Date.now(),
  };
}

// ─── Formatted Output ──────────────────────────────────────────

function fmtUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * Format liquidation report (Telegram Markdown compatible)
 */
export function formatLiquidationReport(
  summary: LiquidationSummary,
  symbol: string
): string {
  const coin = symbol.replace("USDT", "");
  const domEmoji =
    summary.dominance === "long_squeeze" ? "🔴" :
    summary.dominance === "short_squeeze" ? "🟢" : "⚪";

  const domLabel =
    summary.dominance === "long_squeeze" ? "Long liquidations (longs hurt)" :
    summary.dominance === "short_squeeze" ? "Short liquidations (shorts hurt)" : "Balanced";

  const netSign = summary.netLiqPressure >= 0 ? "+" : "";
  const netLabel = summary.netLiqPressure >= 0
    ? "Leaning bullish (more short liquidations)"
    : "Leaning bearish (more long liquidations)";

  const lines: string[] = [
    `💥 **${coin} Liquidation Data (Past 24h)**\n`,
    `🔴 Long Liquidations: ${fmtUsd(summary.totalLongLiqUsd)}`,
    `🟢 Short Liquidations: ${fmtUsd(summary.totalShortLiqUsd)}`,
    `Net Pressure: ${netSign}${fmtUsd(Math.abs(summary.netLiqPressure))} ${netLabel}`,
    `Dominant: ${domEmoji} ${domLabel} (ratio ${summary.dominanceRatio.toFixed(2)}x)`,
    `Price Range: $${summary.priceRange.min.toLocaleString()} — $${summary.priceRange.max.toLocaleString()}`,
    `Samples: ${summary.recordCount} records`,
  ];

  return lines.join("\n");
}

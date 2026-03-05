/**
 * Macro Market Data
 *
 * Data source: Yahoo Finance unofficial API (free, no Key required)
 *
 * Why macro matters:
 *   DXY (Dollar Index) has strong negative correlation with crypto — strong dollar pressures risk assets
 *   S&P500 represents overall risk sentiment — tech/NASDAQ correlation with BTC > 0.7
 *   VIX (Fear Index) measures market panic level
 *
 * Correlation patterns (empirical):
 *   DXY monthly decline  -> Bullish for crypto (loose liquidity)
 *   SPX consecutive drops -> Crypto likely follows down (risk-off sentiment)
 *   VIX > 25             -> Market panic, not ideal for contrarian positions
 *   VIX < 15             -> Market calm, trend trades more reliable
 */

import https from "https";

// Force IPv4 (when server IPv6 is unreachable)
// family is a net.LookupOptions property, passed via type assertion
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

// ─── Type Definitions ──────────────────────────────────────────

export interface MacroAsset {
  symbol: string;
  name: string;
  price: number;
  change1d: number;       // 1-day change (%)
  change5d: number;       // 5-day change (%)
  trend: "bullish" | "bearish" | "neutral";
  trendLabel: string;
}

export interface MacroContext {
  dxy: MacroAsset | null;      // US Dollar Index
  spx: MacroAsset | null;      // S&P 500
  vix: MacroAsset | null;      // Fear Index (optional)
  cryptoEnvironment: "risk_on" | "risk_off" | "mixed" | "unknown";
  cryptoEnvironmentLabel: string;
  summary: string;             // One-line summary
  fetchedAt: number;
}

// ─── FRED API (Federal Reserve Economic Data, free, no Key required) ──────────────
// DXY (Trade-Weighted Dollar): DTWEXBGS
// S&P 500:                     SP500
// VIX:                         VIXCLS
// Returns CSV format: DATE,VALUE (empty values indicate holidays)

function fetchFredCsv(seriesId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hostname = "fred.stlouisfed.org";
    const path = `/graph/fredgraph.csv?id=${seriesId}`;
    const req = https.request(
      { hostname, path, method: "GET", agent: ipv4Agent, headers: { "User-Agent": "curl/7.88" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => { resolve(data); });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("FRED timeout")); });
    req.end();
  });
}

/** Parse FRED CSV, return the last N valid data points */
function parseFredCsv(csv: string, rows = 8): { date: string; value: number }[] {
  return csv
    .split("\n")
    .slice(1)                          // Skip header
    .filter((line) => line.includes(","))
    .map((line) => {
      const [date, val] = line.trim().split(",") as [string, string];
      return { date, value: parseFloat(val) };
    })
    .filter((r) => !isNaN(r.value))   // Remove empty value rows (holidays)
    .slice(-rows);
}

function buildMacroAsset(
  seriesId: string,
  name: string,
  csv: string
): MacroAsset | null {
  const data = parseFredCsv(csv, 8);
  if (data.length < 2) return null;

  const latest = data.at(-1);
  const prev = data.at(-2);
  const first = data.at(0);
  if (!latest || !prev || !first) return null;

  const price = latest.value;
  const change1d = prev.value > 0 ? ((price - prev.value) / prev.value) * 100 : 0;
  const change5d = first.value > 0 ? ((price - first.value) / first.value) * 100 : 0;

  let trend: MacroAsset["trend"];
  if (change1d > 0.2 && change5d > 0.3) trend = "bullish";
  else if (change1d < -0.2 && change5d < -0.3) trend = "bearish";
  else trend = "neutral";

  const trendEmoji = trend === "bullish" ? "📈" : trend === "bearish" ? "📉" : "➡️";
  const trendLabel = `${trendEmoji} ${change1d >= 0 ? "+" : ""}${change1d.toFixed(2)}% 1d / ${change5d >= 0 ? "+" : ""}${change5d.toFixed(2)}% 5d`;

  return { symbol: seriesId, name, price, change1d, change5d, trend, trendLabel };
}

// ─── Public Interface ──────────────────────────────────────────

/** Get DXY (Trade-Weighted Dollar Index, FRED: DTWEXBGS) */
export async function getDxy(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("DTWEXBGS");
    return buildMacroAsset("DXY", "DXY Dollar Index", csv);
  } catch { return null; }
}

/** Get S&P 500 (FRED: SP500) */
export async function getSP500(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("SP500");
    return buildMacroAsset("SPX", "S&P 500 SPX", csv);
  } catch { return null; }
}

/** Get VIX (FRED: VIXCLS) */
export async function getVix(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("VIXCLS");
    return buildMacroAsset("VIX", "VIX Fear Index", csv);
  } catch { return null; }
}

/**
 * Get full macro context.
 * Concurrent requests to all data sources, 8s timeout.
 */
export async function getMacroContext(): Promise<MacroContext> {
  const [dxy, spx, vix] = await Promise.allSettled([getDxy(), getSP500(), getVix()]);

  const dxyData = dxy.status === "fulfilled" ? dxy.value : null;
  const spxData = spx.status === "fulfilled" ? spx.value : null;
  const vixData = vix.status === "fulfilled" ? vix.value : null;

  // Overall assessment of the macro environment for crypto
  const dxyBearish = dxyData?.trend === "bearish";    // Weak dollar -> bullish for crypto
  const dxyBullish = dxyData?.trend === "bullish";    // Strong dollar -> bearish for crypto
  const spxBullish = spxData?.trend === "bullish";    // Stocks up -> risk-on
  const spxBearish = spxData?.trend === "bearish";    // Stocks down -> risk-off
  const vixHigh = vixData ? vixData.price > 25 : false;

  // Use a function to avoid no-useless-assignment lint rule
  const getEnv = (): [MacroContext["cryptoEnvironment"], string, string] => {
    if (vixHigh)             return ["risk_off", "🚨 Market panic (VIX > 25), risk-off sentiment dominates", "VIX elevated, weak risk appetite, crypto under pressure"];
    if (dxyBullish && spxBearish) return ["risk_off", "🔴 Macro unfavorable (strong dollar + stocks down)", "Strong dollar combined with stock pullback, crypto faces liquidity pressure"];
    if (dxyBearish && spxBullish) return ["risk_on",  "🟢 Macro favorable (weak dollar + stocks up)", "Dollar decline combined with stock rally, risk appetite improving, bullish for crypto"];
    if (dxyBullish || spxBearish) return ["mixed",    "🟡 Macro leaning negative (watch risk)", dxyBullish ? "Strong dollar pressuring crypto" : "Stocks weakening, risk sentiment under pressure"];
    if (dxyBearish || spxBullish) return ["mixed",    "🟡 Macro leaning positive (cautious optimism)", dxyBearish ? "Weak dollar, liquidity conditions improving" : "Stocks strengthening, risk appetite recovering"];
    if (dxyData || spxData)       return ["mixed",    "⚪ Macro neutral", "Dollar and stocks show no clear direction, crypto driven by internal factors"];
    return ["unknown", "❓ Failed to fetch macro data", "Unable to retrieve macro data, analysis based on pure technicals"];
  };

  const [cryptoEnvironment, cryptoEnvironmentLabel, summary] = getEnv();

  return {
    dxy: dxyData,
    spx: spxData,
    vix: vixData,
    cryptoEnvironment,
    cryptoEnvironmentLabel,
    summary,
    fetchedAt: Date.now(),
  };
}

/** Format macro data report (Telegram format) */
export function formatMacroReport(ctx: MacroContext): string {
  const lines: string[] = ["🌍 **Macro Market Context**\n"];

  if (ctx.dxy) lines.push(`💵 ${ctx.dxy.name}: $${ctx.dxy.price.toFixed(2)}  ${ctx.dxy.trendLabel}`);
  else lines.push("💵 DXY: Failed to fetch data");

  if (ctx.spx) lines.push(`📊 ${ctx.spx.name}: ${ctx.spx.price.toFixed(0)}  ${ctx.spx.trendLabel}`);
  else lines.push("📊 SPX: Failed to fetch data");

  if (ctx.vix) {
    const vixWarning = ctx.vix.price > 30 ? " ⚠️ Extreme panic" : ctx.vix.price > 20 ? " ⚠️ Elevated" : " Normal";
    lines.push(`😨 ${ctx.vix.name}: ${ctx.vix.price.toFixed(2)}${vixWarning}`);
  }

  lines.push(`\n**Crypto Environment**: ${ctx.cryptoEnvironmentLabel}`);
  lines.push(`→ ${ctx.summary}`);

  return lines.join("\n");
}

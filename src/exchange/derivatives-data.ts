/**
 * Phase 2: Derivatives Market Intelligence
 *
 * Three data sources, all free and require no API Key:
 *
 * 1. Binance Futures API (extending existing foundation)
 *    - Basis: Perpetual contract vs spot premium
 *    - Long/Short Ratio: Global account L/S ratio + top trader L/S ratio
 *
 * 2. Deribit Public API (options data)
 *    - Put/Call Ratio (PCR): Options market sentiment
 *    - ATM Implied Volatility: Market-expected volatility
 *    - Max Pain: Options expiry price gravity
 *    - IV Percentile: Current IV's historical percentile
 *
 * Why these are more valuable than RSI:
 *   - PCR and IV reflect institutional actual position costs (they hedge with options)
 *   - Max Pain is a quantifiable price gravity, statistically significant before Friday expiry
 *   - L/S Ratio reflects retail sentiment (contrarian indicator)
 *   - Basis reflects market aggressiveness (widening = aggressive sentiment)
 */

import https from "https";

// ─── Utility Functions ──────────────────────────────────────────

function fetchJson<T>(url: string, ipv4 = false): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "User-Agent": "openclaw-trader/1.0", "Accept": "application/json" },
      ...(ipv4 ? { agent: new https.Agent({ family: 4 } as https.AgentOptions) } : {}),
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: string) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`JSON parse error from ${parsed.hostname}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
    req.end();
  });
}

// ─── Type Definitions ──────────────────────────────────────────

// ① Basis
export interface BasisData {
  symbol: string;
  perpPrice: number;        // Perpetual contract price
  spotPrice: number;        // Spot price
  basis: number;            // (perp - spot) / spot * 100, in %
  interpretation: string;   // Human-readable interpretation
  signal: "bullish" | "bearish" | "neutral";
}

// ② Long/Short Ratio
export interface LongShortData {
  symbol: string;
  globalLongRatio: number;     // Global account long ratio (0-1)
  globalShortRatio: number;
  globalLSRatio: number;       // longAccount / shortAccount
  topAccountLSRatio: number;   // Top trader account L/S ratio
  topPositionLSRatio: number;  // Top trader position L/S ratio
  sentiment: "extreme_long" | "long_biased" | "neutral" | "short_biased" | "extreme_short";
  sentimentLabel: string;
}

// ③ Deribit Options Data
export interface OptionsData {
  currency: string;          // "BTC" | "ETH"
  underlyingPrice: number;
  // Put/Call Ratio
  putCallRatio: number;      // PCR of all options OI
  putCallRatioWeekly: number;// Near-term options (most sensitive)
  // Implied Volatility
  atmIv: number;             // ATM option IV (%, annualized)
  ivPercentile: number;      // IV percentile (estimated from all options of the day)
  ivSentiment: "low_vol" | "normal" | "elevated" | "extreme";
  // Max Pain (nearest expiry)
  maxPain: number;           // Max Pain price
  maxPainExpiry: string;     // Expiry date (e.g. "28FEB25")
  distanceToMaxPain: number; // Distance from current price to Max Pain in %
  // Overall
  optionsSentiment: "very_bearish" | "bearish" | "neutral" | "bullish" | "very_bullish";
  summary: string;
}

// ─── Binance: Basis ────────────────────────────────────

interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

/**
 * Get Basis (perpetual vs spot premium).
 * Positive Basis = futures premium (bullish sentiment), Negative Basis = futures discount (bearish sentiment)
 */
export async function getBasis(symbol: string): Promise<BasisData> {
  const data = await fetchJson<BinancePremiumIndex>(
    `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`
  );

  const perpPrice = parseFloat(data.markPrice);
  const spotPrice = parseFloat(data.indexPrice);
  const basis = spotPrice > 0 ? ((perpPrice - spotPrice) / spotPrice) * 100 : 0;

  let interpretation: string;
  let signal: BasisData["signal"];

  if (basis > 0.3) {
    signal = "bullish";
    interpretation = `Futures premium +${basis.toFixed(3)}%, aggressive bullish sentiment`;
  } else if (basis > 0.05) {
    signal = "bullish";
    interpretation = `Futures slight premium +${basis.toFixed(3)}%, normal leaning bullish`;
  } else if (basis < -0.3) {
    signal = "bearish";
    interpretation = `Futures discount ${basis.toFixed(3)}%, aggressive bearish sentiment`;
  } else if (basis < -0.05) {
    signal = "bearish";
    interpretation = `Futures slight discount ${basis.toFixed(3)}%, normal leaning bearish`;
  } else {
    signal = "neutral";
    interpretation = `Basis near zero ${basis.toFixed(3)}%, market neutral`;
  }

  return { symbol, perpPrice, spotPrice, basis, interpretation, signal };
}

// ─── Binance: Long/Short Ratio ─────────────────────────

interface BinanceLSRatio {
  symbol: string;
  longAccount: string;
  shortAccount: string;
  longShortRatio: string;
  timestamp: number;
}

interface BinanceLSPosition {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

export async function getLongShortRatio(symbol: string): Promise<LongShortData> {
  const baseUrl = "https://fapi.binance.com/futures/data";

  const [global, topAcc, topPos] = await Promise.allSettled([
    fetchJson<BinanceLSRatio[]>(`${baseUrl}/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`),
    fetchJson<BinanceLSPosition[]>(`${baseUrl}/topLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`),
    fetchJson<BinanceLSPosition[]>(`${baseUrl}/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=1`),
  ]);

  const globalData = global.status === "fulfilled" ? global.value[0] : null;
  const topAccData = topAcc.status === "fulfilled" ? topAcc.value[0] : null;
  const topPosData = topPos.status === "fulfilled" ? topPos.value[0] : null;

  const globalLSRatio = globalData ? parseFloat(globalData.longShortRatio) : 1;
  const globalLongRatio = globalData ? parseFloat(globalData.longAccount) : 0.5;
  const topAccountLSRatio = topAccData ? parseFloat(topAccData.longShortRatio) : 1;
  const topPositionLSRatio = topPosData ? parseFloat(topPosData.longShortRatio) : 1;

  let sentiment: LongShortData["sentiment"];
  let sentimentLabel: string;

  // Retail L/S ratio (contrarian indicator! extreme retail longs usually signal tops)
  if (globalLSRatio > 3.0) {
    sentiment = "extreme_long";
    sentimentLabel = "🔴 Retail extremely long (contrarian: top signal)";
  } else if (globalLSRatio > 1.8) {
    sentiment = "long_biased";
    sentimentLabel = "🟡 Retail leaning long (watch for FOMO risk)";
  } else if (globalLSRatio < 0.5) {
    sentiment = "extreme_short";
    sentimentLabel = "🟢 Retail extremely short (contrarian: bottom signal)";
  } else if (globalLSRatio < 0.8) {
    sentiment = "short_biased";
    sentimentLabel = "🟡 Retail leaning short (watch for short squeeze risk)";
  } else {
    sentiment = "neutral";
    sentimentLabel = "⚪ Retail neutral (no clear bias)";
  }

  return {
    symbol,
    globalLongRatio,
    globalShortRatio: 1 - globalLongRatio,
    globalLSRatio,
    topAccountLSRatio,
    topPositionLSRatio,
    sentiment,
    sentimentLabel,
  };
}

// ─── Deribit: Options Data ─────────────────────────────────

interface DeribitOption {
  instrument_name: string;      // e.g. "BTC-28FEB25-60000-C"
  mark_iv: number;              // Implied Volatility %
  open_interest: number;        // OI (contracts)
  underlying_price: number;     // Current underlying price
  volume_usd: number;           // Volume in USD
}

interface DeribitResponse {
  result: DeribitOption[];
}

/** Parse strike price and expiry date from contract name */
function parseOptionName(name: string): { strike: number; expiry: string; isCall: boolean } | null {
  // Format: BTC-28FEB25-60000-C or ETH-28FEB25-2500-P
  const parts = name.split("-");
  if (parts.length < 4) return null;
  const strike = parseInt(parts[2] ?? "", 10);
  const expiry = parts[1] ?? "";
  const isCall = parts[3] === "C";
  if (isNaN(strike)) return null;
  return { strike, expiry, isCall };
}

/** Parse Deribit expiry date string (e.g. "28FEB25", "27MAR26") to timestamp */
function parseExpiryDate(expiry: string): number {
  // Format: DDMMMYY, e.g. "28FEB25" = 2025-02-28
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(expiry.slice(0, 2), 10);
  const mon = months[expiry.slice(2, 5).toUpperCase()];
  const year = 2000 + parseInt(expiry.slice(5), 10);
  if (mon === undefined || isNaN(day) || isNaN(year)) return 0;
  return new Date(year, mon, day, 8, 0, 0).getTime(); // Deribit expiry time 08:00 UTC
}

/** Calculate Max Pain (the strike price where total option value is minimized) */
function calcMaxPain(options: DeribitOption[], spot: number): { price: number; expiry: string } {
  // Group by expiry date, select the nearest meaningful expiry (OI > 0 and > today)
  const expiryMap = new Map<string, DeribitOption[]>();
  for (const opt of options) {
    const parsed = parseOptionName(opt.instrument_name);
    if (!parsed || opt.open_interest <= 0) continue;
    const key = parsed.expiry;
    if (!expiryMap.has(key)) expiryMap.set(key, []);
    expiryMap.get(key)?.push(opt);
  }

  if (expiryMap.size === 0) return { price: spot, expiry: "N/A" };

  // Select the nearest expiry date (excluding expired ones)
  const now = Date.now();
  const futureExpiries = [...expiryMap.keys()]
    .map((exp) => ({ exp, ts: parseExpiryDate(exp) }))
    .filter((e) => e.ts > now)
    .sort((a, b) => a.ts - b.ts);

  const bestExpiry = futureExpiries[0]?.exp ?? "";

  const expiryOptions = expiryMap.get(bestExpiry) ?? [];

  // Collect all strike prices
  const strikes = [...new Set(
    expiryOptions.map((o) => parseOptionName(o.instrument_name)?.strike ?? 0).filter((s) => s > 0)
  )].sort((a, b) => a - b);

  if (strikes.length === 0) return { price: spot, expiry: bestExpiry };

  // For each strike price, calculate total option value if expiry settles at that price
  let minPain = Infinity;
  let maxPainStrike = strikes[0] ?? 0;

  for (const targetStrike of strikes) {
    let totalPain = 0;
    for (const opt of expiryOptions) {
      const parsed = parseOptionName(opt.instrument_name);
      if (!parsed) continue;
      const { strike, isCall } = parsed;
      const oi = opt.open_interest;
      // Call intrinsic value: max(0, target - strike) * OI
      // Put intrinsic value: max(0, strike - target) * OI
      const intrinsic = isCall
        ? Math.max(0, targetStrike - strike) * oi
        : Math.max(0, strike - targetStrike) * oi;
      totalPain += intrinsic;
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = targetStrike; }
  }

  return { price: maxPainStrike, expiry: bestExpiry };
}

/** Calculate ATM IV (average IV of options nearest to current price) */
function calcAtmIv(options: DeribitOption[], spot: number): number {
  const range = spot * 0.03; // +/-3% considered ATM
  const atmOptions = options.filter((o) => {
    const parsed = parseOptionName(o.instrument_name);
    return parsed && Math.abs(parsed.strike - spot) < range && o.mark_iv > 0;
  });

  if (atmOptions.length === 0) return 0;
  return atmOptions.reduce((s, o) => s + o.mark_iv, 0) / atmOptions.length;
}

/** Calculate Put/Call Ratio (OI-weighted)
 * @param nearbyDays If > 0, only count options expiring within the next N days
 */
function calcPCR(options: DeribitOption[], nearbyDays = 0): number {
  let putOI = 0;
  let callOI = 0;
  const now = Date.now();
  const cutoff = nearbyDays > 0 ? now + nearbyDays * 86400000 : Infinity;

  for (const opt of options) {
    const parsed = parseOptionName(opt.instrument_name);
    if (!parsed || opt.open_interest <= 0) continue;

    if (nearbyDays > 0) {
      const expiryTs = parseExpiryDate(parsed.expiry);
      if (expiryTs > cutoff || expiryTs < now) continue;
    }

    if (parsed.isCall) callOI += opt.open_interest;
    else putOI += opt.open_interest;
  }

  return callOI > 0 ? putOI / callOI : 1;
}

/**
 * Get full options data (Deribit, no API Key required)
 */
export async function getOptionsData(currency: "BTC" | "ETH"): Promise<OptionsData> {
  const data = await fetchJson<DeribitResponse>(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`
  );

  const options = data.result.filter((o) => o.mark_iv > 0);
  if (options.length === 0) {
    throw new Error(`No options data for ${currency}`);
  }

  const spot = options[0]?.underlying_price ?? 0;

  // PCR calculation
  const pcr = calcPCR(options);
  const pcrWeekly = calcPCR(options, 7); // Near-term has higher weight

  // ATM IV
  const atmIv = calcAtmIv(options, spot);

  // IV percentile (IV distribution of all options for the day)
  const allIvs = options.map((o) => o.mark_iv).filter((v) => v > 0).sort((a, b) => a - b);
  const ivRank = allIvs.filter((v) => v <= atmIv).length;
  const ivPercentile = allIvs.length > 0 ? Math.round((ivRank / allIvs.length) * 100) : 50;

  let ivSentiment: OptionsData["ivSentiment"];
  if (atmIv < 30) ivSentiment = "low_vol";
  else if (atmIv < 60) ivSentiment = "normal";
  else if (atmIv < 90) ivSentiment = "elevated";
  else ivSentiment = "extreme";

  // Max Pain
  const { price: maxPain, expiry: maxPainExpiry } = calcMaxPain(options, spot);
  const distanceToMaxPain = spot > 0 ? ((maxPain - spot) / spot) * 100 : 0;

  // Overall options sentiment
  let optionsSentiment: OptionsData["optionsSentiment"];
  let summary: string;

  if (pcr > 1.5 && atmIv > 70) {
    optionsSentiment = "very_bearish";
    summary = `PCR=${pcr.toFixed(2)} extremely high + IV=${atmIv.toFixed(0)}% extremely high, market in extreme panic, possible bottom`;
  } else if (pcr > 1.2) {
    optionsSentiment = "bearish";
    summary = `PCR=${pcr.toFixed(2)} elevated (institutions buying put protection), short-term downward pressure`;
  } else if (pcr < 0.6) {
    optionsSentiment = "very_bullish";
    summary = `PCR=${pcr.toFixed(2)} extremely low (strong call demand), possible excessive optimism`;
  } else if (pcr < 0.8) {
    optionsSentiment = "bullish";
    summary = `PCR=${pcr.toFixed(2)} low, market leaning optimistic`;
  } else {
    optionsSentiment = "neutral";
    summary = `PCR=${pcr.toFixed(2)} neutral, options market shows no clear direction`;
  }

  // Append Max Pain information
  const mpDist = Math.abs(distanceToMaxPain);
  if (mpDist > 5) {
    summary += `. Max Pain $${maxPain.toLocaleString()} is ${mpDist.toFixed(1)}% from current price, possible mean-reversion pressure before expiry`;
  }

  return {
    currency,
    underlyingPrice: spot,
    putCallRatio: pcr,
    putCallRatioWeekly: pcrWeekly,
    atmIv,
    ivPercentile,
    ivSentiment,
    maxPain,
    maxPainExpiry,
    distanceToMaxPain,
    optionsSentiment,
    summary,
  };
}

// ─── IV Skew & Term Structure ─────────────────────────

export interface IvSkewPoint {
  otmPct: number;     // OTM degree (%), e.g. 5 means 5% OTM
  putIv: number;      // Put option IV (%)
  callIv: number;     // Call option IV (%)
  skew: number;       // put - call (positive = downside protection premium)
}

export interface IvTermPoint {
  expiry: string;        // Expiry date string
  daysToExpiry: number;  // Days remaining
  atmIv: number;         // ATM IV (%)
}

export interface IvSkewData {
  currency: string;
  underlyingPrice: number;
  /**
   * IV Smile (comparison of option IVs at different OTM levels)
   * Negative skew -> market fears downside; Positive skew -> market fears upside
   */
  smile: IvSkewPoint[];         // put vs call at 5%, 10%, 15% OTM
  skew25d: number | null;       // Nearest 25-delta skew (near month)
  atmIv: number;                // ATM IV baseline
  /**
   * Term Structure (ATM IV across different expiry dates)
   * Normal shape: near-month IV > far-month IV (Contango structure)
   * Inverted: near-month IV < far-month IV -> market expects a major event soon
   */
  termStructure: IvTermPoint[];
  termStructureSlope: "contango" | "backwardation" | "flat";
  termStructureLabel: string;
  /**
   * Overall interpretation
   */
  skewLabel: "steep_put_skew" | "moderate_put_skew" | "flat" | "call_skew";
  skewSummary: string;
  fetchedAt: number;
}

/** Calculate IV Skew (put - call, by OTM levels) */
function calcIvSmile(
  options: DeribitOption[],
  spot: number,
  expiryFilter?: string
): IvSkewPoint[] {
  const filtered = expiryFilter
    ? options.filter((o) => {
        const p = parseOptionName(o.instrument_name);
        return p?.expiry === expiryFilter;
      })
    : options;

  const OTM_LEVELS = [5, 10, 15]; // OTM percentage levels
  const result: IvSkewPoint[] = [];

  for (const otmPct of OTM_LEVELS) {
    const putStrike = spot * (1 - otmPct / 100);
    const callStrike = spot * (1 + otmPct / 100);
    const tolerance = spot * 0.03; // +/-3% tolerance

    // Find the nearest put/call to target strike
    const putOpts = filtered.filter((o) => {
      const p = parseOptionName(o.instrument_name);
      return p && !p.isCall && Math.abs(p.strike - putStrike) < tolerance && o.mark_iv > 0;
    });
    const callOpts = filtered.filter((o) => {
      const p = parseOptionName(o.instrument_name);
      return p && p.isCall && Math.abs(p.strike - callStrike) < tolerance && o.mark_iv > 0;
    });

    if (putOpts.length === 0 || callOpts.length === 0) continue;

    // OI-weighted average IV
    const wAvgIv = (opts: DeribitOption[]) => {
      const totalOI = opts.reduce((s, o) => s + o.open_interest, 0);
      if (totalOI === 0) return opts.reduce((s, o) => s + o.mark_iv, 0) / opts.length;
      return opts.reduce((s, o) => s + o.mark_iv * o.open_interest, 0) / totalOI;
    };

    const putIv = wAvgIv(putOpts);
    const callIv = wAvgIv(callOpts);

    result.push({ otmPct, putIv, callIv, skew: putIv - callIv });
  }

  return result;
}

/** Calculate Term Structure (ATM IV across different expiry dates) */
function calcTermStructure(options: DeribitOption[], spot: number): IvTermPoint[] {
  const now = Date.now();
  const expiryMap = new Map<string, DeribitOption[]>();
  for (const opt of options) {
    const p = parseOptionName(opt.instrument_name);
    if (!p || opt.mark_iv <= 0) continue;
    if (!expiryMap.has(p.expiry)) expiryMap.set(p.expiry, []);
    expiryMap.get(p.expiry)?.push(opt);
  }

  const points: IvTermPoint[] = [];
  for (const [expiry, opts] of expiryMap) {
    const expiryTs = parseExpiryDate(expiry);
    if (expiryTs <= now) continue; // Expired

    const dte = Math.max(0, Math.round((expiryTs - now) / 86400000));
    if (dte > 365) continue; // Skip options over 1 year out

    const atmIv = calcAtmIv(opts, spot);
    if (atmIv <= 0) continue;

    points.push({ expiry, daysToExpiry: dte, atmIv });
  }

  return points.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/**
 * Get full IV Skew analysis (Deribit public API, no authentication required)
 */
export async function getIvSkewData(currency: "BTC" | "ETH"): Promise<IvSkewData> {
  const data = await fetchJson<DeribitResponse>(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`
  );

  const options = data.result.filter((o) => o.mark_iv > 0 && o.open_interest > 0);
  if (options.length === 0) throw new Error(`No IV data for ${currency}`);

  const spot = options[0]?.underlying_price ?? 0;
  const now = Date.now();

  // Find nearest expiry date (for skew calculation)
  const nearestExpiry = (() => {
    const futureOpts = options
      .map((o) => parseOptionName(o.instrument_name))
      .filter((p): p is NonNullable<typeof p> => p !== null && parseExpiryDate(p.expiry) > now)
      .sort((a, b) => parseExpiryDate(a.expiry) - parseExpiryDate(b.expiry));
    return futureOpts[0]?.expiry;
  })();

  // ATM IV
  const atmIv = nearestExpiry
    ? calcAtmIv(options.filter((o) => parseOptionName(o.instrument_name)?.expiry === nearestExpiry), spot)
    : calcAtmIv(options, spot);

  // IV Smile (near month)
  const smile = calcIvSmile(options, spot, nearestExpiry);

  // 25-delta approximation: use 5% OTM level skew (approximately 25d for BTC/ETH)
  const skew25d = smile.find((p) => p.otmPct === 5)?.skew ?? null;

  // Term Structure
  const termStructure = calcTermStructure(options, spot);

  // Term Structure slope
  let termStructureSlope: IvSkewData["termStructureSlope"] = "flat";
  let termStructureLabel: string;
  if (termStructure.length >= 2) {
    const near = termStructure[0]?.atmIv ?? 0;
    const far = termStructure[termStructure.length - 1]?.atmIv ?? 0;
    const diff = near - far;
    if (diff > 5) {
      termStructureSlope = "backwardation";
      termStructureLabel = `📈 Inverted (near-month IV ${near.toFixed(0)}% > far-month ${far.toFixed(0)}%), market expects a major event soon`;
    } else if (diff < -5) {
      termStructureSlope = "contango";
      termStructureLabel = `✅ Normal contango (near-month IV ${near.toFixed(0)}% < far-month ${far.toFixed(0)}%), market calm`;
    } else {
      termStructureLabel = `➡️ Flat structure (near-month ${near.toFixed(0)}% ≈ far-month ${far.toFixed(0)}%)`;
    }
  } else {
    termStructureLabel = "Insufficient data to determine";
  }

  // Overall Skew label
  const avgSmileSkew = smile.length > 0
    ? smile.reduce((s, p) => s + p.skew, 0) / smile.length
    : 0;

  let skewLabel: IvSkewData["skewLabel"];
  let skewSummary: string;

  if (avgSmileSkew > 8) {
    skewLabel = "steep_put_skew";
    skewSummary = `Significant put premium (avg skew +${avgSmileSkew.toFixed(1)}%), market highly alert to downside`;
  } else if (avgSmileSkew > 3) {
    skewLabel = "moderate_put_skew";
    skewSummary = `Normal put skew (skew +${avgSmileSkew.toFixed(1)}%), downside protection demand exceeds upside`;
  } else if (avgSmileSkew < -3) {
    skewLabel = "call_skew";
    skewSummary = `Call premium (skew ${avgSmileSkew.toFixed(1)}%), market chasing upside, possible short squeeze risk`;
  } else {
    skewLabel = "flat";
    skewSummary = `Options pricing fairly balanced (skew ${avgSmileSkew.toFixed(1)}%), no significant directional skew`;
  }

  return {
    currency,
    underlyingPrice: spot,
    smile,
    skew25d,
    atmIv,
    termStructure,
    termStructureSlope,
    termStructureLabel,
    skewLabel,
    skewSummary,
    fetchedAt: Date.now(),
  };
}

/** Format IV Skew report */
export function formatIvSkewReport(skew: IvSkewData): string {
  const lines: string[] = [`📐 **${skew.currency} IV Skew Analysis**\n`];

  // Smile table
  if (skew.smile.length > 0) {
    lines.push("| OTM | Put IV | Call IV | Skew |");
    lines.push("|-----|--------|---------|------|");
    for (const p of skew.smile) {
      const skewEmoji = p.skew > 5 ? "🔴" : p.skew > 2 ? "🟡" : p.skew < -2 ? "🟢" : "⚪";
      lines.push(`| ${p.otmPct}% | ${p.putIv.toFixed(1)}% | ${p.callIv.toFixed(1)}% | ${skewEmoji} ${p.skew >= 0 ? "+" : ""}${p.skew.toFixed(1)}% |`);
    }
    lines.push("");
  }

  // 25-delta skew
  if (skew.skew25d !== null) {
    lines.push(`📍 25d Skew: ${skew.skew25d >= 0 ? "+" : ""}${skew.skew25d.toFixed(1)}%  (positive=bearish skew, negative=bullish skew)`);
  }

  // Term Structure
  lines.push(`\n📅 **Term Structure**: ${skew.termStructureLabel}`);
  if (skew.termStructure.length > 0) {
    const pts = skew.termStructure.slice(0, 5); // Show at most 5
    lines.push(pts.map((p) => `${p.expiry}(${p.daysToExpiry}d): ${p.atmIv.toFixed(0)}%`).join(" → "));
  }

  // Overall interpretation
  lines.push(`\n💡 **Summary**: ${skew.skewSummary}`);

  return lines.join("\n");
}

// ─── Batch Fetching ─────────────────────────────────────────

export interface DerivativesSnapshot {
  symbol: string;
  basis: BasisData | null;
  longShort: LongShortData | null;
  options: OptionsData | null;       // Only BTC and ETH have options
  ivSkew?: IvSkewData | null;        // IV Skew analysis (optional, BTC and ETH only, requires explicit request)
}

export async function getDerivativesSnapshot(symbol: string, includeSkew = false): Promise<DerivativesSnapshot> {
  const currency = symbol.startsWith("BTC") ? "BTC" : symbol.startsWith("ETH") ? "ETH" : null;

  const [basis, longShort, options, ivSkew] = await Promise.allSettled([
    getBasis(symbol),
    getLongShortRatio(symbol),
    currency ? getOptionsData(currency) : Promise.reject(new Error("no options")),
    (currency && includeSkew) ? getIvSkewData(currency) : Promise.reject(new Error("skew disabled")),
  ]);

  return {
    symbol,
    basis: basis.status === "fulfilled" ? basis.value : null,
    longShort: longShort.status === "fulfilled" ? longShort.value : null,
    options: options.status === "fulfilled" ? options.value : null,
    ivSkew: ivSkew.status === "fulfilled" ? ivSkew.value : null,
  };
}

// ─── Format Report ───────────────────────────────────────

export function formatDerivativesReport(snap: DerivativesSnapshot): string {
  const coin = snap.symbol.replace("USDT", "");
  const lines: string[] = [`📈 **${coin} Derivatives Market**\n`];

  if (snap.basis) {
    const b = snap.basis;
    const emoji = b.signal === "bullish" ? "🟢" : b.signal === "bearish" ? "🔴" : "⚪";
    lines.push(`${emoji} Basis: ${b.basis >= 0 ? "+" : ""}${b.basis.toFixed(3)}%  ${b.interpretation}`);
  }

  if (snap.longShort) {
    const ls = snap.longShort;
    lines.push(`👥 L/S Ratio: ${ls.globalLSRatio.toFixed(2)} (Long ${(ls.globalLongRatio * 100).toFixed(0)}% / Short ${(ls.globalShortRatio * 100).toFixed(0)}%)`);
    lines.push(`   Top Traders: ${ls.topAccountLSRatio.toFixed(2)}  ${ls.sentimentLabel}`);
  }

  if (snap.options) {
    const o = snap.options;
    const pcrEmoji = o.putCallRatio > 1.2 ? "🔴" : o.putCallRatio < 0.8 ? "🟢" : "⚪";
    const ivEmoji = o.ivSentiment === "extreme" ? "🔥" : o.ivSentiment === "elevated" ? "⚠️" : "";

    lines.push(`\n🎯 **Options Data (${o.currency})**`);
    lines.push(`${pcrEmoji} PCR: ${o.putCallRatio.toFixed(2)}  ${ivEmoji} ATM IV: ${o.atmIv.toFixed(1)}% (${o.ivPercentile}th percentile)`);
    lines.push(`💥 Max Pain: $${o.maxPain.toLocaleString()} (${o.distanceToMaxPain >= 0 ? "+" : ""}${o.distanceToMaxPain.toFixed(1)}%)  Expiry: ${o.maxPainExpiry}`);
    lines.push(`→ ${o.summary}`);
  }

  if (snap.ivSkew) {
    const sk = snap.ivSkew;
    const smileStr = sk.smile.map((p) => `±${p.otmPct}%: ${p.skew >= 0 ? "+" : ""}${p.skew.toFixed(1)}`).join(" | ");
    lines.push(`\n📐 **IV Skew** (put-call)  ${smileStr}`);
    lines.push(`   25d Skew: ${sk.skew25d !== null ? `${sk.skew25d >= 0 ? "+" : ""}${sk.skew25d.toFixed(1)}%` : "N/A"}  | Term: ${sk.termStructureSlope}`);
    lines.push(`   → ${sk.skewSummary}`);
  }

  return lines.join("\n");
}

/** Generate multi-coin derivatives summary report (only BTC/ETH have options) */
export function formatMultiDerivativesReport(snaps: DerivativesSnapshot[]): string {
  const sections = snaps.map((s) => formatDerivativesReport(s));
  return ["━━ Derivatives Market Intelligence ━━\n", ...sections].join("\n\n");
}

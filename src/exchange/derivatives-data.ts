/**
 * Phase 2：衍生品市场情报
 *
 * 三个数据源，全部免费、无需 API Key：
 *
 * 1. Binance Futures API（已有基础，扩展）
 *    - Basis：永续合约 vs 现货溢价
 *    - Long/Short Ratio：全球账户多空比 + 大户多空比
 *
 * 2. Deribit Public API（期权数据）
 *    - Put/Call Ratio（PCR）：期权市场情绪
 *    - ATM Implied Volatility：市场预期波动率
 *    - Max Pain：期权到期价格引力
 *    - IV Percentile：当前 IV 的历史百分位
 *
 * 为什么这些比 RSI 更有价值：
 *   - PCR 和 IV 反映机构的实际仓位成本（他们用期权对冲）
 *   - Max Pain 是可量化的价格引力，每周五到期前有统计意义
 *   - L/S Ratio 反映散户情绪（逆向指标）
 *   - Basis 反映市场激进程度（扩大 = 情绪激进）
 */

import https from "https";

// ─── 工具函数 ──────────────────────────────────────────

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

// ─── 类型定义 ──────────────────────────────────────────

// ① Basis
export interface BasisData {
  symbol: string;
  perpPrice: number;        // 永续合约价格
  spotPrice: number;        // 现货价格
  basis: number;            // (perp - spot) / spot * 100，单位 %
  interpretation: string;   // 中文解读
  signal: "bullish" | "bearish" | "neutral";
}

// ② Long/Short Ratio
export interface LongShortData {
  symbol: string;
  globalLongRatio: number;     // 全球账户做多比例（0-1）
  globalShortRatio: number;
  globalLSRatio: number;       // longAccount / shortAccount
  topAccountLSRatio: number;   // 大户账户多空比
  topPositionLSRatio: number;  // 大户持仓多空比
  sentiment: "extreme_long" | "long_biased" | "neutral" | "short_biased" | "extreme_short";
  sentimentLabel: string;
}

// ③ Deribit 期权数据
export interface OptionsData {
  currency: string;          // "BTC" | "ETH"
  underlyingPrice: number;
  // Put/Call Ratio
  putCallRatio: number;      // 全部期权 OI 的 PCR
  putCallRatioWeekly: number;// 最近周期期权（最敏感）
  // Implied Volatility
  atmIv: number;             // 平值期权 IV（%，年化）
  ivPercentile: number;      // IV 百分位（基于当日所有期权估算）
  ivSentiment: "low_vol" | "normal" | "elevated" | "extreme";
  // Max Pain（当前最近到期日）
  maxPain: number;           // Max Pain 价格
  maxPainExpiry: string;     // 到期日（如 "28FEB25"）
  distanceToMaxPain: number; // 当前价格到 Max Pain 的距离 %
  // 综合
  optionsSentiment: "very_bearish" | "bearish" | "neutral" | "bullish" | "very_bullish";
  summary: string;
}

// ─── Binance：Basis ────────────────────────────────────

interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

/**
 * 获取 Basis（永续 vs 现货溢价）
 * 正 Basis = 期货溢价（看多情绪），负 Basis = 期货折价（看空情绪）
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
    interpretation = `期货溢价 +${basis.toFixed(3)}%，多头情绪激进`;
  } else if (basis > 0.05) {
    signal = "bullish";
    interpretation = `期货小幅溢价 +${basis.toFixed(3)}%，正常偏多`;
  } else if (basis < -0.3) {
    signal = "bearish";
    interpretation = `期货折价 ${basis.toFixed(3)}%，空头情绪激进`;
  } else if (basis < -0.05) {
    signal = "bearish";
    interpretation = `期货小幅折价 ${basis.toFixed(3)}%，正常偏空`;
  } else {
    signal = "neutral";
    interpretation = `Basis 接近零 ${basis.toFixed(3)}%，市场中性`;
  }

  return { symbol, perpPrice, spotPrice, basis, interpretation, signal };
}

// ─── Binance：Long/Short Ratio ─────────────────────────

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

  // 散户多空比（逆向指标！散户极度做多时通常是顶部）
  if (globalLSRatio > 3.0) {
    sentiment = "extreme_long";
    sentimentLabel = "🔴 散户极度看多（逆向：顶部信号）";
  } else if (globalLSRatio > 1.8) {
    sentiment = "long_biased";
    sentimentLabel = "🟡 散户偏多（注意追高风险）";
  } else if (globalLSRatio < 0.5) {
    sentiment = "extreme_short";
    sentimentLabel = "🟢 散户极度看空（逆向：底部信号）";
  } else if (globalLSRatio < 0.8) {
    sentiment = "short_biased";
    sentimentLabel = "🟡 散户偏空（注意轧空风险）";
  } else {
    sentiment = "neutral";
    sentimentLabel = "⚪ 散户中性（无明显偏向）";
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

// ─── Deribit：期权数据 ─────────────────────────────────

interface DeribitOption {
  instrument_name: string;      // e.g. "BTC-28FEB25-60000-C"
  mark_iv: number;              // Implied Volatility %
  open_interest: number;        // OI（张数）
  underlying_price: number;     // 当前标的价格
  volume_usd: number;           // 成交量 USD
}

interface DeribitResponse {
  result: DeribitOption[];
}

/** 从合约名解析行权价和到期日 */
function parseOptionName(name: string): { strike: number; expiry: string; isCall: boolean } | null {
  // 格式：BTC-28FEB25-60000-C 或 ETH-28FEB25-2500-P
  const parts = name.split("-");
  if (parts.length < 4) return null;
  const strike = parseInt(parts[2]!, 10);
  const expiry = parts[1]!;
  const isCall = parts[3] === "C";
  if (isNaN(strike)) return null;
  return { strike, expiry, isCall };
}

/** 解析 Deribit 到期日字符串（如 "28FEB25"、"27MAR26"）为时间戳 */
function parseExpiryDate(expiry: string): number {
  // 格式：DDMMMYY，如 "28FEB25" = 2025-02-28
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(expiry.slice(0, 2), 10);
  const mon = months[expiry.slice(2, 5).toUpperCase()];
  const year = 2000 + parseInt(expiry.slice(5), 10);
  if (mon === undefined || isNaN(day) || isNaN(year)) return 0;
  return new Date(year, mon, day, 8, 0, 0).getTime(); // Deribit 到期时间 08:00 UTC
}

/** 计算 Max Pain（总期权价值最小的行权价） */
function calcMaxPain(options: DeribitOption[], spot: number): { price: number; expiry: string } {
  // 按到期日分组，选最近的有意义到期日（OI > 0 且 > 今天）
  const expiryMap = new Map<string, DeribitOption[]>();
  for (const opt of options) {
    const parsed = parseOptionName(opt.instrument_name);
    if (!parsed || opt.open_interest <= 0) continue;
    const key = parsed.expiry;
    if (!expiryMap.has(key)) expiryMap.set(key, []);
    expiryMap.get(key)!.push(opt);
  }

  if (expiryMap.size === 0) return { price: spot, expiry: "N/A" };

  // 选最近的到期日（但不是已过期的）
  const now = Date.now();
  const futureExpiries = [...expiryMap.keys()]
    .map((exp) => ({ exp, ts: parseExpiryDate(exp) }))
    .filter((e) => e.ts > now)
    .sort((a, b) => a.ts - b.ts);

  const bestExpiry = futureExpiries[0]?.exp ?? "";

  const expiryOptions = expiryMap.get(bestExpiry) ?? [];

  // 收集所有行权价
  const strikes = [...new Set(
    expiryOptions.map((o) => parseOptionName(o.instrument_name)?.strike ?? 0).filter((s) => s > 0)
  )].sort((a, b) => a - b);

  if (strikes.length === 0) return { price: spot, expiry: bestExpiry };

  // 对每个行权价计算如果到期在该价格时，总期权价值
  let minPain = Infinity;
  let maxPainStrike = strikes[0]!;

  for (const targetStrike of strikes) {
    let totalPain = 0;
    for (const opt of expiryOptions) {
      const parsed = parseOptionName(opt.instrument_name);
      if (!parsed) continue;
      const { strike, isCall } = parsed;
      const oi = opt.open_interest;
      // Call 内在价值：max(0, target - strike) * OI
      // Put 内在价值：max(0, strike - target) * OI
      const intrinsic = isCall
        ? Math.max(0, targetStrike - strike) * oi
        : Math.max(0, strike - targetStrike) * oi;
      totalPain += intrinsic;
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = targetStrike; }
  }

  return { price: maxPainStrike, expiry: bestExpiry };
}

/** 计算 ATM IV（最接近现价的期权 IV 平均） */
function calcAtmIv(options: DeribitOption[], spot: number): number {
  const range = spot * 0.03; // ±3% 视为 ATM
  const atmOptions = options.filter((o) => {
    const parsed = parseOptionName(o.instrument_name);
    return parsed && Math.abs(parsed.strike - spot) < range && o.mark_iv > 0;
  });

  if (atmOptions.length === 0) return 0;
  return atmOptions.reduce((s, o) => s + o.mark_iv, 0) / atmOptions.length;
}

/** 计算 Put/Call Ratio（OI 加权）
 * @param nearbyDays 如果 > 0，只统计最近 N 天内到期的期权
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
 * 获取完整期权数据（Deribit，无需 API Key）
 */
export async function getOptionsData(currency: "BTC" | "ETH"): Promise<OptionsData> {
  const data = await fetchJson<DeribitResponse>(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`
  );

  const options = data.result.filter((o) => o.mark_iv > 0);
  if (options.length === 0) {
    throw new Error(`No options data for ${currency}`);
  }

  const spot = options[0]!.underlying_price;

  // PCR 计算
  const pcr = calcPCR(options);
  const pcrWeekly = calcPCR(options, 7); // 近期权重更高

  // ATM IV
  const atmIv = calcAtmIv(options, spot);

  // IV 百分位（当日所有期权的 IV 分布）
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

  // 综合期权情绪
  let optionsSentiment: OptionsData["optionsSentiment"];
  let summary: string;

  if (pcr > 1.5 && atmIv > 70) {
    optionsSentiment = "very_bearish";
    summary = `PCR=${pcr.toFixed(2)} 极高 + IV=${atmIv.toFixed(0)}% 极高，市场极度恐慌，可能是底部`;
  } else if (pcr > 1.2) {
    optionsSentiment = "bearish";
    summary = `PCR=${pcr.toFixed(2)} 偏高（机构在买 Put 保护），短期下行压力`;
  } else if (pcr < 0.6) {
    optionsSentiment = "very_bullish";
    summary = `PCR=${pcr.toFixed(2)} 极低（Call 旺盛），可能存在过度乐观`;
  } else if (pcr < 0.8) {
    optionsSentiment = "bullish";
    summary = `PCR=${pcr.toFixed(2)} 偏低，市场偏乐观`;
  } else {
    optionsSentiment = "neutral";
    summary = `PCR=${pcr.toFixed(2)} 中性，期权市场无明显方向`;
  }

  // 补充 Max Pain 信息
  const mpDist = Math.abs(distanceToMaxPain);
  if (mpDist > 5) {
    summary += `。Max Pain $${maxPain.toLocaleString()} 与当前价差 ${mpDist.toFixed(1)}%，到期日前可能有回归压力`;
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
  otmPct: number;     // OTM 程度（%），如 5 表示 5% OTM
  putIv: number;      // 看跌期权 IV（%）
  callIv: number;     // 看涨期权 IV（%）
  skew: number;       // put - call（正=下行保护溢价）
}

export interface IvTermPoint {
  expiry: string;        // 到期日字符串
  daysToExpiry: number;  // 剩余天数
  atmIv: number;         // ATM IV（%）
}

export interface IvSkewData {
  currency: string;
  underlyingPrice: number;
  /**
   * IV Smile（不同 OTM 程度的期权 IV 对比）
   * 负 skew → 市场担忧下行；正 skew → 市场担忧上行
   */
  smile: IvSkewPoint[];         // 5%, 10%, 15% OTM 的 put vs call
  skew25d: number | null;       // 最接近 25-delta 的 skew（近月）
  atmIv: number;                // ATM IV 基准
  /**
   * Term Structure（不同到期日的 ATM IV）
   * 正常形态：近月 IV > 远月 IV（Contango 结构）
   * 反转：近月 IV < 远月 IV → 市场预期近期会有大事件
   */
  termStructure: IvTermPoint[];
  termStructureSlope: "contango" | "backwardation" | "flat";
  termStructureLabel: string;
  /**
   * 综合解读
   */
  skewLabel: "steep_put_skew" | "moderate_put_skew" | "flat" | "call_skew";
  skewSummary: string;
  fetchedAt: number;
}

/** 计算 IV Skew（put - call，按 OTM 档位） */
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

  const OTM_LEVELS = [5, 10, 15]; // OTM 百分比档位
  const result: IvSkewPoint[] = [];

  for (const otmPct of OTM_LEVELS) {
    const putStrike = spot * (1 - otmPct / 100);
    const callStrike = spot * (1 + otmPct / 100);
    const tolerance = spot * 0.03; // ±3% 容差

    // 找最接近目标行权价的 put/call
    const putOpts = filtered.filter((o) => {
      const p = parseOptionName(o.instrument_name);
      return p && !p.isCall && Math.abs(p.strike - putStrike) < tolerance && o.mark_iv > 0;
    });
    const callOpts = filtered.filter((o) => {
      const p = parseOptionName(o.instrument_name);
      return p && p.isCall && Math.abs(p.strike - callStrike) < tolerance && o.mark_iv > 0;
    });

    if (putOpts.length === 0 || callOpts.length === 0) continue;

    // 取 OI 加权 IV
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

/** 计算 Term Structure（不同到期日的 ATM IV） */
function calcTermStructure(options: DeribitOption[], spot: number): IvTermPoint[] {
  const now = Date.now();
  const expiryMap = new Map<string, DeribitOption[]>();
  for (const opt of options) {
    const p = parseOptionName(opt.instrument_name);
    if (!p || opt.mark_iv <= 0) continue;
    if (!expiryMap.has(p.expiry)) expiryMap.set(p.expiry, []);
    expiryMap.get(p.expiry)!.push(opt);
  }

  const points: IvTermPoint[] = [];
  for (const [expiry, opts] of expiryMap) {
    const expiryTs = parseExpiryDate(expiry);
    if (expiryTs <= now) continue; // 已过期

    const dte = Math.max(0, Math.round((expiryTs - now) / 86400000));
    if (dte > 365) continue; // 跳过超过 1 年的

    const atmIv = calcAtmIv(opts, spot);
    if (atmIv <= 0) continue;

    points.push({ expiry, daysToExpiry: dte, atmIv });
  }

  return points.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/**
 * 获取完整 IV Skew 分析（Deribit 公开 API，无需认证）
 */
export async function getIvSkewData(currency: "BTC" | "ETH"): Promise<IvSkewData> {
  const data = await fetchJson<DeribitResponse>(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`
  );

  const options = data.result.filter((o) => o.mark_iv > 0 && o.open_interest > 0);
  if (options.length === 0) throw new Error(`No IV data for ${currency}`);

  const spot = options[0]!.underlying_price;
  const now = Date.now();

  // 找最近到期日（用于 skew 计算）
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

  // IV Smile（近月）
  const smile = calcIvSmile(options, spot, nearestExpiry);

  // 25-delta 近似：取 5% OTM 档的 skew（对 BTC/ETH 来说 ≈25d）
  const skew25d = smile.find((p) => p.otmPct === 5)?.skew ?? null;

  // Term Structure
  const termStructure = calcTermStructure(options, spot);

  // Term Structure 斜率
  let termStructureSlope: IvSkewData["termStructureSlope"] = "flat";
  let termStructureLabel: string;
  if (termStructure.length >= 2) {
    const near = termStructure[0]!.atmIv;
    const far = termStructure[termStructure.length - 1]!.atmIv;
    const diff = near - far;
    if (diff > 5) {
      termStructureSlope = "backwardation";
      termStructureLabel = `📈 反转（近月 IV ${near.toFixed(0)}% > 远月 ${far.toFixed(0)}%），市场预期近期有重大事件`;
    } else if (diff < -5) {
      termStructureSlope = "contango";
      termStructureLabel = `✅ 正常顺差（近月 IV ${near.toFixed(0)}% < 远月 ${far.toFixed(0)}%），市场平静`;
    } else {
      termStructureLabel = `➡️ 平坦结构（近月 ${near.toFixed(0)}% ≈ 远月 ${far.toFixed(0)}%）`;
    }
  } else {
    termStructureLabel = "数据不足，无法判断";
  }

  // 综合 Skew 标签
  const avgSmileSkew = smile.length > 0
    ? smile.reduce((s, p) => s + p.skew, 0) / smile.length
    : 0;

  let skewLabel: IvSkewData["skewLabel"];
  let skewSummary: string;

  if (avgSmileSkew > 8) {
    skewLabel = "steep_put_skew";
    skewSummary = `看跌期权溢价显著（平均 skew +${avgSmileSkew.toFixed(1)}%），市场对下行极为警惕`;
  } else if (avgSmileSkew > 3) {
    skewLabel = "moderate_put_skew";
    skewSummary = `正常看跌偏斜（skew +${avgSmileSkew.toFixed(1)}%），下行保护需求高于上行`;
  } else if (avgSmileSkew < -3) {
    skewLabel = "call_skew";
    skewSummary = `看涨期权溢价（skew ${avgSmileSkew.toFixed(1)}%），市场在追涨，可能是上方轧空风险`;
  } else {
    skewLabel = "flat";
    skewSummary = `期权定价较均衡（skew ${avgSmileSkew.toFixed(1)}%），无明显方向性偏斜`;
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

/** 格式化 IV Skew 报告 */
export function formatIvSkewReport(skew: IvSkewData): string {
  const lines: string[] = [`📐 **${skew.currency} IV Skew 分析**\n`];

  // Smile 表格
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
    lines.push(`📍 25d Skew: ${skew.skew25d >= 0 ? "+" : ""}${skew.skew25d.toFixed(1)}%  (正=看空偏斜，负=看多偏斜)`);
  }

  // Term Structure
  lines.push(`\n📅 **期限结构**: ${skew.termStructureLabel}`);
  if (skew.termStructure.length > 0) {
    const pts = skew.termStructure.slice(0, 5); // 最多显示 5 个
    lines.push(pts.map((p) => `${p.expiry}(${p.daysToExpiry}d): ${p.atmIv.toFixed(0)}%`).join(" → "));
  }

  // 综合解读
  lines.push(`\n💡 **综合**: ${skew.skewSummary}`);

  return lines.join("\n");
}

// ─── 批量获取 ─────────────────────────────────────────

export interface DerivativesSnapshot {
  symbol: string;
  basis: BasisData | null;
  longShort: LongShortData | null;
  options: OptionsData | null;       // 仅 BTC 和 ETH 有期权
  ivSkew?: IvSkewData | null;        // IV Skew 分析（可选，仅 BTC 和 ETH，需显式请求）
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

// ─── 格式化报告 ───────────────────────────────────────

export function formatDerivativesReport(snap: DerivativesSnapshot): string {
  const coin = snap.symbol.replace("USDT", "");
  const lines: string[] = [`📈 **${coin} 衍生品市场**\n`];

  if (snap.basis) {
    const b = snap.basis;
    const emoji = b.signal === "bullish" ? "🟢" : b.signal === "bearish" ? "🔴" : "⚪";
    lines.push(`${emoji} Basis: ${b.basis >= 0 ? "+" : ""}${b.basis.toFixed(3)}%  ${b.interpretation}`);
  }

  if (snap.longShort) {
    const ls = snap.longShort;
    lines.push(`👥 L/S 比: ${ls.globalLSRatio.toFixed(2)} (多 ${(ls.globalLongRatio * 100).toFixed(0)}% / 空 ${(ls.globalShortRatio * 100).toFixed(0)}%)`);
    lines.push(`   大户: ${ls.topAccountLSRatio.toFixed(2)}  ${ls.sentimentLabel}`);
  }

  if (snap.options) {
    const o = snap.options;
    const pcrEmoji = o.putCallRatio > 1.2 ? "🔴" : o.putCallRatio < 0.8 ? "🟢" : "⚪";
    const ivEmoji = o.ivSentiment === "extreme" ? "🔥" : o.ivSentiment === "elevated" ? "⚠️" : "";

    lines.push(`\n🎯 **期权数据 (${o.currency})**`);
    lines.push(`${pcrEmoji} PCR: ${o.putCallRatio.toFixed(2)}  ${ivEmoji} ATM IV: ${o.atmIv.toFixed(1)}% (${o.ivPercentile}th 百分位)`);
    lines.push(`💥 Max Pain: $${o.maxPain.toLocaleString()} (${o.distanceToMaxPain >= 0 ? "+" : ""}${o.distanceToMaxPain.toFixed(1)}%)  到期: ${o.maxPainExpiry}`);
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

/** 生成多币种衍生品综合报告（仅 BTC/ETH 有期权） */
export function formatMultiDerivativesReport(snaps: DerivativesSnapshot[]): string {
  const sections = snaps.map((s) => formatDerivativesReport(s));
  return ["━━ 衍生品市场情报 ━━\n", ...sections].join("\n\n");
}

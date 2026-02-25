/**
 * Binance Futures 公开市场数据
 *
 * 资金费率（Funding Rate）和未平仓合约（Open Interest）
 * 均为免费公开接口，无需 API Key。
 *
 * 用途：评估市场情绪，判断多空过热，预判趋势延续或反转。
 *
 * 资金费率解读：
 *   > +0.1%  多头过热，平仓风险高（看空信号）
 *   0 ~ +0.05%  正常，市场偏多
 *  -0.05% ~ 0  正常，市场偏空
 *   < -0.05%  空头过热，轧空风险（看多信号）
 *
 * OI 解读：
 *   OI 上升 + 价格上涨  → 多头入场，趋势加强
 *   OI 上升 + 价格下跌  → 空头入场，趋势加强
 *   OI 下降 + 价格上涨  → 空头止损，反弹力度有限
 *   OI 下降 + 价格下跌  → 多头离场，下跌减速
 */

import https from "https";

const FAPI_HOST = "fapi.binance.com";

/** HTTP GET 工具（复用 Binance 请求模式） */
function fetchJson<T>(hostname: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`JSON parse error: ${data.slice(0, 100)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── 类型定义 ──────────────────────────────────────────

export interface FundingRate {
  symbol: string;
  fundingRate: number;       // 当前资金费率（小数，如 0.0001 = 0.01%）
  fundingRateStr: string;    // 格式化字符串（如 "+0.0100%"）
  nextFundingTime: number;   // 下次结算时间（ms）
  sentiment: "overlong" | "overbought" | "neutral_long" | "neutral_short" | "overshort";
  sentimentLabel: string;    // 中文描述
}

export interface OpenInterest {
  symbol: string;
  openInterest: number;       // 未平仓合约张数
  openInterestUsdt: number;   // 名义价值（USDT）
  changePercent1h: number;    // 1h 变化百分比
  changePercent4h: number;    // 4h 变化百分比
  trend: "rising" | "falling" | "flat";
  trendLabel: string;
}

export interface FuturesMarketData {
  symbol: string;
  fundingRate: FundingRate;
  openInterest: OpenInterest;
  combinedSignal: "bullish" | "bearish" | "neutral" | "extreme_long" | "extreme_short";
  combinedLabel: string;
}

// ─── 内部：Binance API 响应类型 ────────────────────────

interface BinanceFundingRate {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

interface BinanceOI {
  symbol: string;
  openInterest: string;
  time: number;
}

interface BinanceOIHist {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

// ─── 资金费率 ──────────────────────────────────────────

function parseFundingRate(raw: BinanceFundingRate, nextTime: number): FundingRate {
  const rate = parseFloat(raw.fundingRate);
  const ratePercent = rate * 100;

  let sentiment: FundingRate["sentiment"];
  let sentimentLabel: string;

  if (rate > 0.001) {
    sentiment = "overlong";
    sentimentLabel = "多头严重过热 ⚠️（反转风险高）";
  } else if (rate > 0.0003) {
    sentiment = "overbought";
    sentimentLabel = "多头偏热（注意追高风险）";
  } else if (rate >= 0) {
    sentiment = "neutral_long";
    sentimentLabel = "中性偏多（正常）";
  } else if (rate >= -0.0005) {
    sentiment = "neutral_short";
    sentimentLabel = "中性偏空（正常）";
  } else {
    sentiment = "overshort";
    sentimentLabel = "空头过热 ⚠️（轧空风险高）";
  }

  return {
    symbol: raw.symbol,
    fundingRate: rate,
    fundingRateStr: `${ratePercent >= 0 ? "+" : ""}${ratePercent.toFixed(4)}%`,
    nextFundingTime: nextTime,
    sentiment,
    sentimentLabel,
  };
}

/** 获取最新资金费率 */
export async function getFundingRate(symbol: string): Promise<FundingRate> {
  // /fapi/v1/premiumIndex 包含 nextFundingTime
  const data = await fetchJson<{
    symbol: string;
    markPrice: string;
    indexPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
  }>(FAPI_HOST, `/fapi/v1/premiumIndex?symbol=${symbol}`);

  return parseFundingRate(
    { symbol: data.symbol, fundingRate: data.lastFundingRate, fundingTime: 0 },
    data.nextFundingTime
  );
}

/** 获取多个币种的资金费率（并发） */
export async function getFundingRates(symbols: string[]): Promise<Map<string, FundingRate>> {
  const results = await Promise.allSettled(symbols.map(getFundingRate));
  const map = new Map<string, FundingRate>();
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") map.set(symbols[i] ?? "", r.value);
  }
  return map;
}

// ─── 未平仓合约 ────────────────────────────────────────

/** 获取 OI 历史（用于计算变化率） */
async function getOIHistory(symbol: string, limit = 5): Promise<BinanceOIHist[]> {
  return fetchJson<BinanceOIHist[]>(
    FAPI_HOST,
    `/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=${limit}`
  );
}

/** 获取当前未平仓合约 + 变化率 */
export async function getOpenInterest(symbol: string, currentPrice: number): Promise<OpenInterest> {
  const [current, history] = await Promise.all([
    fetchJson<BinanceOI>(FAPI_HOST, `/fapi/v1/openInterest?symbol=${symbol}`),
    getOIHistory(symbol, 5),
  ]);

  const oiNow = parseFloat(current.openInterest);
  const oiUsdt = oiNow * currentPrice;

  // 计算变化率
  let change1h = 0;
  let change4h = 0;
  if (history.length >= 2) {
    const oi1hAgo = parseFloat(history[history.length - 2]?.sumOpenInterest ?? "0");
    change1h = oi1hAgo > 0 ? ((oiNow - oi1hAgo) / oi1hAgo) * 100 : 0;
  }
  if (history.length >= 5) {
    const oi4hAgo = parseFloat(history[0]?.sumOpenInterest ?? "0");
    change4h = oi4hAgo > 0 ? ((oiNow - oi4hAgo) / oi4hAgo) * 100 : 0;
  }

  let trend: OpenInterest["trend"];
  if (change1h > 0.5) trend = "rising";
  else if (change1h < -0.5) trend = "falling";
  else trend = "flat";

  const trendLabel =
    trend === "rising" ? `上升 +${change1h.toFixed(1)}%` :
    trend === "falling" ? `下降 ${change1h.toFixed(1)}%` :
    `平稳 ${change1h.toFixed(1)}%`;

  return {
    symbol,
    openInterest: oiNow,
    openInterestUsdt: oiUsdt,
    changePercent1h: change1h,
    changePercent4h: change4h,
    trend,
    trendLabel,
  };
}

// ─── 综合分析 ──────────────────────────────────────────

/** 结合资金费率 + OI 变化给出综合信号 */
export async function getFuturesMarketData(
  symbol: string,
  currentPrice: number
): Promise<FuturesMarketData> {
  const [fundingRate, openInterest] = await Promise.all([
    getFundingRate(symbol),
    getOpenInterest(symbol, currentPrice),
  ]);

  // 综合信号：资金费率 × OI 趋势
  let combinedSignal: FuturesMarketData["combinedSignal"];
  let combinedLabel: string;

  const fr = fundingRate.fundingRate;
  const oiTrend = openInterest.trend;

  if (fr > 0.001 && oiTrend === "rising") {
    combinedSignal = "extreme_long";
    combinedLabel = "🔥 多头极度过热（高风险反转区）";
  } else if (fr < -0.0005 && oiTrend === "rising") {
    combinedSignal = "extreme_short";
    combinedLabel = "🔥 空头极度过热（轧空风险高）";
  } else if (fr > 0.0003 || (fr > 0 && oiTrend === "rising")) {
    combinedSignal = "bullish";
    combinedLabel = "📈 多头占优（正常偏多）";
  } else if (fr < -0.0002 || (fr < 0 && oiTrend === "rising")) {
    combinedSignal = "bearish";
    combinedLabel = "📉 空头占优（正常偏空）";
  } else {
    combinedSignal = "neutral";
    combinedLabel = "⚖️ 中性（方向不明确）";
  }

  return { symbol, fundingRate, openInterest, combinedSignal, combinedLabel };
}

/** 批量获取多个币种的 Futures 市场数据 */
export async function getBatchFuturesData(
  symbols: string[],
  prices: Record<string, number>
): Promise<Map<string, FuturesMarketData>> {
  const results = await Promise.allSettled(
    symbols.map((sym) => getFuturesMarketData(sym, prices[sym] ?? 0))
  );
  const map = new Map<string, FuturesMarketData>();
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") map.set(symbols[i] ?? "", r.value);
  }
  return map;
}

/** 格式化资金费率报告（供 Telegram 发送） */
export function formatFundingRateReport(data: Map<string, FuturesMarketData>): string {
  const lines: string[] = ["📊 **资金费率 & 持仓量**\n"];

  for (const [symbol, d] of data) {
    const coin = symbol.replace("USDT", "");
    const fr = d.fundingRate;
    const oi = d.openInterest;
    const frEmoji = fr.fundingRate > 0.0005 ? "🔴" : fr.fundingRate < -0.0003 ? "🟢" : "⚪";
    const oiEmoji = oi.trend === "rising" ? "📈" : oi.trend === "falling" ? "📉" : "➡️";

    lines.push(
      `${frEmoji} **${coin}** 资金费率: ${fr.fundingRateStr} | ${oiEmoji} OI: ${oi.trendLabel}`
    );
  }

  lines.push(`\n${[...data.values()].map(d => d.combinedLabel).join("\n")}`);
  return lines.join("\n");
}

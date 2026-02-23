/**
 * 新闻与情绪数据抓取
 * 使用免费 API，无需 Key
 */

import https from "https";

function get(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "openclaw-trader/0.1.0" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Parse failed: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Timeout")));
  });
}

// ─────────────────────────────────────────────────────
// Fear & Greed Index（恐惧贪婪指数）
// ─────────────────────────────────────────────────────

export interface FearGreedData {
  value: number;       // 0-100
  label: string;       // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: number;
}

export async function getFearGreedIndex(): Promise<FearGreedData> {
  const data = (await get(
    "https://api.alternative.me/fng/?limit=1&format=json"
  )) as { data: Array<{ value: string; value_classification: string; timestamp: string }> };

  const item = data.data[0];
  return {
    value: parseInt(item.value),
    label: item.value_classification,
    timestamp: parseInt(item.timestamp) * 1000,
  };
}

// ─────────────────────────────────────────────────────
// CryptoPanic 新闻（免费公开接口）
// ─────────────────────────────────────────────────────

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  currencies?: string[]; // 相关币种，如 ["BTC", "ETH"]
  votes?: { positive: number; negative: number; important: number };
}

export async function getLatestNews(limit = 20): Promise<NewsItem[]> {
  try {
    const data = (await get(
      `https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&limit=${limit}&kind=news`
    )) as {
      results: Array<{
        title: string;
        url: string;
        source: { title: string };
        published_at: string;
        currencies?: Array<{ code: string }>;
        votes?: { positive: number; negative: number; important: number };
      }>;
    };

    return data.results.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source.title,
      publishedAt: item.published_at,
      currencies: item.currencies?.map((c) => c.code),
      votes: item.votes,
    }));
  } catch {
    // CryptoPanic 可能限速，返回空数组
    return [];
  }
}

// ─────────────────────────────────────────────────────
// CoinGecko 全球市场数据
// ─────────────────────────────────────────────────────

export interface GlobalMarketData {
  totalMarketCapUsd: number;
  totalVolumeUsd: number;
  btcDominance: number;
  marketCapChangePercent24h: number;
}

export async function getGlobalMarket(): Promise<GlobalMarketData> {
  const data = (await get(
    "https://api.coingecko.com/api/v3/global"
  )) as {
    data: {
      total_market_cap: { usd: number };
      total_volume: { usd: number };
      market_cap_percentage: { btc: number };
      market_cap_change_percentage_24h_usd: number;
    };
  };

  return {
    totalMarketCapUsd: data.data.total_market_cap.usd,
    totalVolumeUsd: data.data.total_volume.usd,
    btcDominance: data.data.market_cap_percentage.btc,
    marketCapChangePercent24h: data.data.market_cap_change_percentage_24h_usd,
  };
}

// ─────────────────────────────────────────────────────
// 价格异动检测（1小时涨跌幅）
// ─────────────────────────────────────────────────────

export interface PriceChange {
  symbol: string;
  priceChangePercent: number;
  price: number;
}

export async function getPriceChanges(
  symbols: string[]
): Promise<PriceChange[]> {
  const data = (await get(
    "https://api.binance.com/api/v3/ticker/24hr"
  )) as Array<{ symbol: string; priceChangePercent: string; lastPrice: string }>;

  return data
    .filter((t) => symbols.includes(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      priceChangePercent: parseFloat(t.priceChangePercent),
      price: parseFloat(t.lastPrice),
    }));
}

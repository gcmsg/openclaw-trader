/**
 * 新闻与情绪数据抓取
 * 使用免费 API，无需 Key
 */

import https from "https";

function get(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "openclaw-trader/0.1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (_e: unknown) {
          reject(new Error(`Parse failed: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Timeout")));
  });
}

// ─────────────────────────────────────────────────────
// Fear & Greed Index（恐惧贪婪指数）
// ─────────────────────────────────────────────────────

export interface FearGreedData {
  value: number; // 0-100
  label: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: number;
}

export async function getFearGreedIndex(): Promise<FearGreedData> {
  const data = (await get("https://api.alternative.me/fng/?limit=1&format=json")) as {
    data: { value: string; value_classification: string; timestamp: string }[];
  };

  const item = data.data[0];
  if (!item) throw new Error("Fear & Greed API 返回空数据");
  return {
    value: parseInt(item.value, 10),
    label: item.value_classification,
    timestamp: parseInt(item.timestamp, 10) * 1000,
  };
}

// ─────────────────────────────────────────────────────
// CryptoCompare 新闻（免费，无需 API Key）
// ─────────────────────────────────────────────────────

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  currencies?: string[]; // 相关币种，如 ["BTC", "ETH"]
  categories?: string; // 如 "MARKET|REGULATION|BTC"
  important?: boolean; // 是否判定为重要新闻
}

// 高影响关键词（出现则标记 important=true）
const IMPORTANT_KEYWORDS = [
  "crash",
  "collapse",
  "dump",
  "plunge",
  "hack",
  "exploit",
  "breach",
  "ban",
  "regulation",
  "sec",
  "etf",
  "approved",
  "rejected",
  "liquidation",
  "bankruptcy",
  "shutdown",
  "fraud",
  "scam",
  "all-time high",
  "ath",
  "breakout",
  "capitulation",
  "federal reserve",
  "fed rate",
  "inflation",
  "sanctions",
  "surge",
  "rally",
  "bull",
  "bear",
];

// 高影响类别
const IMPORTANT_CATEGORIES = ["REGULATION", "HACK", "EXCHANGE", "ICO", "MACROECONOMICS"];

// 监控的主流币种关键词映射
const COIN_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth", "ether"],
  BNB: ["bnb", "binance coin", "binance smart chain"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  ADA: ["cardano", "ada"],
  DOGE: ["dogecoin", "doge"],
  AVAX: ["avalanche", "avax"],
};

function extractCurrencies(title: string, categories: string): string[] {
  const text = (title + " " + categories).toLowerCase();
  return Object.entries(COIN_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => text.includes(kw)))
    .map(([coin]) => coin);
}

function isImportant(title: string, categories: string): boolean {
  const text = title.toLowerCase();
  const cats = categories.toUpperCase().split("|");
  return (
    IMPORTANT_KEYWORDS.some((kw) => text.includes(kw)) ||
    IMPORTANT_CATEGORIES.some((cat) => cats.includes(cat))
  );
}

export async function getLatestNews(limit = 30): Promise<NewsItem[]> {
  try {
    const data = (await get(
      `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=${limit}&sortOrder=latest`
    )) as {
      Data: {
        title: string;
        url: string;
        source_info: { name: string };
        published_on: number;
        categories: string;
      }[];
    };

    return data.Data.map((item) => {
      const categories = item.categories || "";
      return {
        title: item.title,
        url: item.url,
        source: item.source_info.name || "CryptoCompare",
        publishedAt: new Date(item.published_on * 1000).toISOString(),
        currencies: extractCurrencies(item.title, categories),
        categories,
        important: isImportant(item.title, categories),
      };
    });
  } catch (_e: unknown) {
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
  const data = (await get("https://api.coingecko.com/api/v3/global")) as {
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

export async function getPriceChanges(symbols: string[]): Promise<PriceChange[]> {
  const data = (await get("https://api.binance.com/api/v3/ticker/24hr")) as {
    symbol: string;
    priceChangePercent: string;
    lastPrice: string;
  }[];

  return data
    .filter((t) => symbols.includes(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      priceChangePercent: parseFloat(t.priceChangePercent),
      price: parseFloat(t.lastPrice),
    }));
}

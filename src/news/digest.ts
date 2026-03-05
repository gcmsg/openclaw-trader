/**
 * News Digest Module — Phase 3
 *
 * Design Philosophy:
 *   Keyword matching is fake NLP — "Bitcoin rebounds strongly after breaking support" is not bearish.
 *   The correct approach is to feed structured news headlines to the LLM (AI agent) for semantic understanding.
 *
 *   This module is responsible for:
 *     1. Aggregating latest news from multiple sources
 *     2. Formatting into LLM-friendly standard output
 *     3. Categorizing by impact: macro/regulatory/technical/market structure
 *
 *   The AI agent in the evening cron task receives this digest for real semantic analysis.
 */

import https from "https";

// ─── Type Definitions ──────────────────────────────────────────

export type NewsCategory =
  | "macro"          // Macro/Fed/FX
  | "regulatory"     // Regulation/Compliance/Policy
  | "technical"      // Technical upgrades/Protocol/Security
  | "market"         // Market structure/Exchange/Liquidity
  | "narrative"      // Market narrative/ETF/Institutional
  | "other";

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: number;   // Unix timestamp (s)
  url: string;
  category: NewsCategory;
  keywords: string[];    // Matched key entities (BTC/ETH/FED, etc.)
}

export interface NewsDigest {
  items: NewsItem[];
  fetchedAt: number;
  sources: string[];
  topHeadlines: string[];  // Concise summary for LLM (up to 8 items)
  formattedForAI: string;  // Full LLM input format
}

// ─── Keyword Classification Rules ────────────────────────────────────

const CATEGORY_RULES: { keywords: string[]; category: NewsCategory }[] = [
  {
    keywords: ["fed", "federal reserve", "fomc", "interest rate", "inflation", "cpi", "ppi",
               "gdp", "recession", "treasury", "powell", "rate cut", "rate hike", "yield"],
    category: "macro",
  },
  {
    keywords: ["sec", "regulation", "ban", "lawsuit", "congress", "senate", "bill", "law",
               "compliance", "kyc", "aml", "license", "cftc", "doj", "doj"],
    category: "regulatory",
  },
  {
    keywords: ["upgrade", "hard fork", "soft fork", "protocol", "hack", "exploit", "vulnerability",
               "bridge", "layer 2", "l2", "rollup", "zk", "staking", "validator"],
    category: "technical",
  },
  {
    keywords: ["etf", "institution", "blackrock", "fidelity", "grayscale", "microstrategy",
               "coinbase", "binance", "ftx", "spot etf", "futures etf", "adoption"],
    category: "narrative",
  },
  {
    keywords: ["liquidation", "long", "short", "leverage", "funding", "open interest",
               "exchange", "volume", "whale", "flow", "spot"],
    category: "market",
  },
];

function categorize(title: string): { category: NewsCategory; keywords: string[] } {
  const titleLower = title.toLowerCase();
  const foundKeywords: string[] = [];
  let bestCategory: NewsCategory = "other";
  let maxMatches = 0;

  for (const rule of CATEGORY_RULES) {
    const matches = rule.keywords.filter((kw) => titleLower.includes(kw));
    if (matches.length > maxMatches) {
      maxMatches = matches.length;
      bestCategory = rule.category;
      foundKeywords.push(...matches);
    }
  }

  return { category: bestCategory, keywords: [...new Set(foundKeywords)] };
}

// ─── News Fetching (CryptoCompare, free) ──────────────────

interface CCNewsItem {
  title: string;
  published_on: number;
  url: string;
  source_info?: { name: string };
  categories: string;
}

interface CCNewsResponse {
  Data: CCNewsItem[];
}

function fetchCC(limit = 20): Promise<CCNewsResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "min-api.cryptocompare.com",
        path: `/data/v2/news/?lang=EN&limit=${limit}&sortOrder=latest`,
        method: "GET",
        headers: { "User-Agent": "openclaw-trader/1.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data) as CCNewsResponse); }
          catch { reject(new Error("CryptoCompare parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("CC timeout")); });
    req.end();
  });
}

// ─── Main Function ────────────────────────────────────────────

export async function getNewsDigest(limit = 15): Promise<NewsDigest> {
  const raw = await fetchCC(limit);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 24 * 3600; // Only take news within 24h

  const items: NewsItem[] = raw.Data
    .filter((item) => item.published_on > cutoff)
    .map((item) => {
      const { category, keywords } = categorize(item.title);
      return {
        title: item.title,
        source: item.source_info?.name ?? "Unknown",
        publishedAt: item.published_on,
        url: item.url,
        category,
        keywords,
      };
    })
    .slice(0, limit);

  const sources = [...new Set(items.map((i) => i.source))];

  // Sort by importance: macro > regulatory > narrative > market > technical > other
  const priority: Record<NewsCategory, number> = {
    macro: 5, regulatory: 4, narrative: 3, market: 2, technical: 1, other: 0,
  };
  const sorted = [...items].sort((a, b) => priority[b.category] - priority[a.category]);

  // Generate LLM-friendly format
  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const h = d.getUTCHours().toString().padStart(2, "0");
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m} UTC`;
  };

  const topHeadlines = sorted.slice(0, 8).map(
    (item) => `[${item.category.toUpperCase()}] ${item.title} (${formatTime(item.publishedAt)})`
  );

  // Group output by category
  const grouped = new Map<NewsCategory, NewsItem[]>();
  for (const item of sorted) {
    const arr = grouped.get(item.category) ?? [];
    arr.push(item);
    grouped.set(item.category, arr);
  }

  const catLabels: Record<NewsCategory, string> = {
    macro: "🌍 Macro/Fed",
    regulatory: "⚖️ Regulation/Policy",
    narrative: "📰 Institutional/ETF/Narrative",
    market: "📊 Market Structure",
    technical: "🔧 Technical/Protocol",
    other: "📋 Other",
  };

  const lines: string[] = ["📰 **Latest Crypto News Digest** (within 24h, for AI analysis)\n"];

  const catOrder: NewsCategory[] = ["macro", "regulatory", "narrative", "market", "technical", "other"];
  for (const cat of catOrder) {
    const catItems = grouped.get(cat);
    if (!catItems || catItems.length === 0) continue;
    lines.push(`**${catLabels[cat]}**`);
    for (const item of catItems.slice(0, 3)) {
      lines.push(`  • ${item.title} — ${item.source} (${formatTime(item.publishedAt)})`);
    }
    lines.push("");
  }

  lines.push("⬆️ The above news is analyzed by the AI agent to determine market impact.");

  return {
    items,
    fetchedAt: Date.now(),
    sources,
    topHeadlines,
    formattedForAI: lines.join("\n"),
  };
}

/** Format report (output directly into analysis report) */
export function formatNewsDigest(digest: NewsDigest): string {
  return digest.formattedForAI;
}

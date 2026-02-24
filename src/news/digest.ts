/**
 * 新闻摘要模块 — Phase 3
 *
 * 设计哲学：
 *   关键词匹配是假的 NLP，「比特币跌破支撑后强力反弹」不等于利空。
 *   正确做法是把结构化的新闻标题喂给真正的 LLM（Mia），让 AI 做语义理解。
 *
 *   这个模块负责：
 *     1. 从多个来源聚合最新新闻
 *     2. 格式化成 LLM 友好的标准输出
 *     3. 按影响分类：宏观/监管/技术/市场结构
 *
 *   Mia 在晚间 cron 任务中接收这个 digest，进行真正的语义分析。
 */

import https from "https";

// ─── 类型定义 ──────────────────────────────────────────

export type NewsCategory =
  | "macro"          // 宏观/美联储/汇率
  | "regulatory"     // 监管/合规/政策
  | "technical"      // 技术升级/协议/安全
  | "market"         // 市场结构/交易所/流动性
  | "narrative"      // 市场叙事/ETF/机构
  | "other";

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: number;   // Unix timestamp (s)
  url: string;
  category: NewsCategory;
  keywords: string[];    // 匹配到的关键实体（BTC/ETH/FED 等）
}

export interface NewsDigest {
  items: NewsItem[];
  fetchedAt: number;
  sources: string[];
  topHeadlines: string[];  // 给 LLM 的简洁摘要（最多 8 条）
  formattedForAI: string;  // 完整 LLM 输入格式
}

// ─── 关键词分类规则 ────────────────────────────────────

const CATEGORY_RULES: { keywords: string[]; category: NewsCategory }[] = [
  {
    keywords: ["fed", "federal reserve", "fomc", "interest rate", "inflation", "cpi", "ppi",
               "gdp", "recession", "treasury", "powell", "rate cut", "rate hike", "yield",
               "美联储", "利率", "通胀", "衰退"],
    category: "macro",
  },
  {
    keywords: ["sec", "regulation", "ban", "lawsuit", "congress", "senate", "bill", "law",
               "compliance", "kyc", "aml", "license", "cftc", "doj", "doj",
               "监管", "合规", "立法", "禁止"],
    category: "regulatory",
  },
  {
    keywords: ["upgrade", "hard fork", "soft fork", "protocol", "hack", "exploit", "vulnerability",
               "bridge", "layer 2", "l2", "rollup", "zk", "staking", "validator",
               "升级", "攻击", "漏洞", "跨链"],
    category: "technical",
  },
  {
    keywords: ["etf", "institution", "blackrock", "fidelity", "grayscale", "microstrategy",
               "coinbase", "binance", "ftx", "spot etf", "futures etf", "adoption",
               "机构", "现货ETF", "采用"],
    category: "narrative",
  },
  {
    keywords: ["liquidation", "long", "short", "leverage", "funding", "open interest",
               "exchange", "volume", "whale", "flow", "spot",
               "清算", "多空", "杠杆", "鲸鱼"],
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

// ─── 新闻获取（CryptoCompare，免费） ──────────────────

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

// ─── 主函数 ────────────────────────────────────────────

export async function getNewsDigest(limit = 15): Promise<NewsDigest> {
  const raw = await fetchCC(limit);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 24 * 3600; // 只取 24h 内的新闻

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

  // 按重要性排序：macro > regulatory > narrative > market > technical > other
  const priority: Record<NewsCategory, number> = {
    macro: 5, regulatory: 4, narrative: 3, market: 2, technical: 1, other: 0,
  };
  const sorted = [...items].sort((a, b) => priority[b.category] - priority[a.category]);

  // 生成 LLM 友好的格式
  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const h = d.getUTCHours().toString().padStart(2, "0");
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m} UTC`;
  };

  const topHeadlines = sorted.slice(0, 8).map(
    (item) => `[${item.category.toUpperCase()}] ${item.title} (${formatTime(item.publishedAt)})`
  );

  // 按分类分组输出
  const grouped = new Map<NewsCategory, NewsItem[]>();
  for (const item of sorted) {
    const arr = grouped.get(item.category) ?? [];
    arr.push(item);
    grouped.set(item.category, arr);
  }

  const catLabels: Record<NewsCategory, string> = {
    macro: "🌍 宏观/美联储",
    regulatory: "⚖️ 监管/政策",
    narrative: "📰 机构/ETF/叙事",
    market: "📊 市场结构",
    technical: "🔧 技术/协议",
    other: "📋 其他",
  };

  const lines: string[] = ["📰 **最新加密新闻摘要**（24h 内，供 AI 分析）\n"];

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

  lines.push("⬆️ 以上新闻由 Mia 进行语义分析，判断市场影响。");

  return {
    items,
    fetchedAt: Date.now(),
    sources,
    topHeadlines,
    formattedForAI: lines.join("\n"),
  };
}

/** 格式化报告（直接输出到分析报告中） */
export function formatNewsDigest(digest: NewsDigest): string {
  return digest.formattedForAI;
}

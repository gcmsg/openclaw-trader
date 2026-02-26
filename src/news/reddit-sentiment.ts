/**
 * Reddit 社交情绪分析（P5.4）
 *
 * 数据源：Reddit 公开 JSON API（无需 Auth）
 *   - https://www.reddit.com/r/{subreddit}/search.json?q=...
 *   - https://www.reddit.com/r/{subreddit}/new.json
 *
 * 注意：必须设置 User-Agent，否则返回 429。
 *       免费接口每分钟约 60 次请求上限（不登录）。
 */

import https from "https";

// ─── 关键词（复用 sentiment-gate.ts 同源词库）──────────

/** 利多关键词 */
export const BULLISH_KEYWORDS: string[] = [
  "rally", "surge", "bull", "pump", "breakout", "all-time high", "ath",
  "institutional", "etf", "approval", "adopt", "partnership", "launch",
  "upgrade", "mainnet", "halving", "recovery", "recover", "rebound",
  "support", "accumulate", "accumulation", "inflow", "buy", "moon",
  "bullish", "long", "hodl", "hold", "green",
];

/** 利空关键词 */
export const BEARISH_KEYWORDS: string[] = [
  "crash", "dump", "bear", "drop", "fall", "plunge", "collapse",
  "hack", "exploit", "breach", "stolen", "ban", "crackdown",
  "sec", "lawsuit", "fine", "penalty", "bankruptcy", "insolvency",
  "liquidation", "rug", "scam", "fraud", "outflow", "sell-off",
  "selloff", "fear", "uncertainty", "concern", "warning", "risk",
  "bearish", "short", "red", "panic",
];

// ─── 类型定义 ──────────────────────────────────────────

export interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  created: number;        // Unix timestamp (seconds)
  url: string;
  sentiment?: "bullish" | "bearish" | "neutral";
}

export interface RedditSentimentResult {
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  /** 所有帖子的平均 score */
  avgScore: number;
  /** 整体情绪标签 */
  sentimentLabel: "bullish" | "bearish" | "neutral";
  /** 置信度 0-1（|bullish-bearish| / total）*/
  confidence: number;
  /** 前 5 条（按 score 降序）*/
  topPosts: RedditPost[];
  generatedAt: number;
}

// ─── 内部请求 ──────────────────────────────────────────

/** 原始 Reddit API listing 结构 */
interface RedditListing {
  data: {
    children: {
      data: {
        title: string;
        score: number;
        num_comments: number;
        created_utc: number;
        url: string;
        permalink: string;
      };
    }[];
  };
}

function fetchRedditJson(url: string): Promise<RedditListing> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "openclaw-trader/1.0 (by /u/openclaw-bot)",
          Accept: "application/json",
        },
      },
      (res) => {
        // Reddit 可能 302 重定向（通常不需处理，https 会跟随）
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Reddit HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as RedditListing);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12_000, () => {
      req.destroy();
      reject(new Error(`Reddit fetch timeout: ${url}`));
    });
    req.end();
  });
}

/** 对单条帖子标题做情绪分类 */
function classifyTitle(title: string): "bullish" | "bearish" | "neutral" {
  const lower = title.toLowerCase();
  let bullScore = 0;
  let bearScore = 0;
  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw)) bullScore++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw)) bearScore++;
  }
  if (bullScore > bearScore) return "bullish";
  if (bearScore > bullScore) return "bearish";
  return "neutral";
}

// ─── 公开接口 ──────────────────────────────────────────

/**
 * 从指定 subreddit 抓取帖子
 *
 * @param subreddit   如 "CryptoCurrency" 或 "Bitcoin"
 * @param keywords    若提供，使用 search 接口；否则抓 /new
 */
export async function fetchRedditPosts(
  subreddit: string,
  keywords?: string[]
): Promise<RedditPost[]> {
  let url: string;
  if (keywords && keywords.length > 0) {
    const q = encodeURIComponent(keywords.join(" OR "));
    url = `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&sort=new&limit=25&t=day`;
  } else {
    url = `https://www.reddit.com/r/${subreddit}/new.json?limit=25`;
  }

  const listing = await fetchRedditJson(url);
  const children = listing?.data?.children ?? [];

  return children.map((child) => {
    const d = child.data;
    const post: RedditPost = {
      title: d.title,
      score: d.score,
      numComments: d.num_comments,
      created: d.created_utc,
      url: `https://www.reddit.com${d.permalink}`,
      sentiment: classifyTitle(d.title),
    };
    return post;
  });
}

/**
 * 分析一批帖子，生成情绪结果
 */
export function analyzeRedditSentiment(posts: RedditPost[]): RedditSentimentResult {
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  let totalScore = 0;

  for (const p of posts) {
    const sentiment = p.sentiment ?? classifyTitle(p.title);
    if (sentiment === "bullish") bullishCount++;
    else if (sentiment === "bearish") bearishCount++;
    else neutralCount++;
    totalScore += p.score;
  }

  const total = posts.length;
  const avgScore = total > 0 ? totalScore / total : 0;

  let sentimentLabel: RedditSentimentResult["sentimentLabel"] = "neutral";
  if (bullishCount > bearishCount && bullishCount > neutralCount) sentimentLabel = "bullish";
  else if (bearishCount > bullishCount && bearishCount > neutralCount) sentimentLabel = "bearish";

  const confidence = total > 0
    ? Math.abs(bullishCount - bearishCount) / total
    : 0;

  const topPosts = [...posts]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    bullishCount,
    bearishCount,
    neutralCount,
    avgScore,
    sentimentLabel,
    confidence,
    topPosts,
    generatedAt: Date.now(),
  };
}

/**
 * 格式化 Reddit 情绪报告（Telegram Markdown 兼容）
 */
export function formatRedditReport(result: RedditSentimentResult): string {
  const sentEmoji =
    result.sentimentLabel === "bullish" ? "🟢" :
    result.sentimentLabel === "bearish" ? "🔴" : "⚪";

  const total = result.bullishCount + result.bearishCount + result.neutralCount;
  const confPct = (result.confidence * 100).toFixed(0);

  const lines: string[] = [
    `🗣️ **Reddit 社区情绪**\n`,
    `整体：${sentEmoji} ${result.sentimentLabel.toUpperCase()}（置信度 ${confPct}%）`,
    `🟢 看多: ${result.bullishCount}  🔴 看空: ${result.bearishCount}  ⚪ 中性: ${result.neutralCount}  共 ${total} 条`,
    `平均分: ${result.avgScore.toFixed(0)} 分`,
  ];

  if (result.topPosts.length > 0) {
    lines.push("\n**热门帖子 Top5：**");
    for (const p of result.topPosts) {
      const s = p.sentiment === "bullish" ? "🟢" : p.sentiment === "bearish" ? "🔴" : "⚪";
      const titleShort = p.title.length > 60 ? p.title.slice(0, 57) + "..." : p.title;
      lines.push(`${s} [${p.score}↑] ${titleShort}`);
    }
  }

  return lines.join("\n");
}

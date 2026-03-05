/**
 * Reddit Social Sentiment Analysis (P5.4)
 *
 * Data source: Reddit public JSON API (no Auth required)
 *   - https://www.reddit.com/r/{subreddit}/search.json?q=...
 *   - https://www.reddit.com/r/{subreddit}/new.json
 *
 * Note: User-Agent must be set, otherwise returns 429.
 *       Free API has ~60 requests per minute limit (without login).
 */

import https from "https";

// ─── Keywords (reusing sentiment-gate.ts shared vocabulary) ──────────

/** Bullish keywords */
export const BULLISH_KEYWORDS: string[] = [
  "rally", "surge", "bull", "pump", "breakout", "all-time high", "ath",
  "institutional", "etf", "approval", "adopt", "partnership", "launch",
  "upgrade", "mainnet", "halving", "recovery", "recover", "rebound",
  "support", "accumulate", "accumulation", "inflow", "buy", "moon",
  "bullish", "long", "hodl", "hold", "green",
];

/** Bearish keywords */
export const BEARISH_KEYWORDS: string[] = [
  "crash", "dump", "bear", "drop", "fall", "plunge", "collapse",
  "hack", "exploit", "breach", "stolen", "ban", "crackdown",
  "sec", "lawsuit", "fine", "penalty", "bankruptcy", "insolvency",
  "liquidation", "rug", "scam", "fraud", "outflow", "sell-off",
  "selloff", "fear", "uncertainty", "concern", "warning", "risk",
  "bearish", "short", "red", "panic",
];

// ─── Type Definitions ──────────────────────────────────────────

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
  /** Average score of all posts */
  avgScore: number;
  /** Overall sentiment label */
  sentimentLabel: "bullish" | "bearish" | "neutral";
  /** Confidence 0-1 (|bullish-bearish| / total) */
  confidence: number;
  /** Top 5 (sorted by score descending) */
  topPosts: RedditPost[];
  generatedAt: number;
}

// ─── Internal Request ──────────────────────────────────────────

/** Raw Reddit API listing structure */
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
        // Reddit may 302 redirect (usually no handling needed, https follows)
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
            reject(e instanceof Error ? e : new Error(String(e)));
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

/** Classify sentiment for a single post title */
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

// ─── Public API ──────────────────────────────────────────

/**
 * Fetch posts from a specified subreddit
 *
 * @param subreddit   e.g. "CryptoCurrency" or "Bitcoin"
 * @param keywords    If provided, uses search API; otherwise fetches /new
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
  const children = listing.data.children;

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
 * Analyze a batch of posts and generate sentiment results
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
 * Format Reddit sentiment report (Telegram Markdown compatible)
 */
export function formatRedditReport(result: RedditSentimentResult): string {
  const sentEmoji =
    result.sentimentLabel === "bullish" ? "🟢" :
    result.sentimentLabel === "bearish" ? "🔴" : "⚪";

  const total = result.bullishCount + result.bearishCount + result.neutralCount;
  const confPct = (result.confidence * 100).toFixed(0);

  const lines: string[] = [
    `🗣️ **Reddit Community Sentiment**\n`,
    `Overall: ${sentEmoji} ${result.sentimentLabel.toUpperCase()} (confidence ${confPct}%)`,
    `🟢 Bullish: ${result.bullishCount}  🔴 Bearish: ${result.bearishCount}  ⚪ Neutral: ${result.neutralCount}  Total: ${total} posts`,
    `Avg score: ${result.avgScore.toFixed(0)}`,
  ];

  if (result.topPosts.length > 0) {
    lines.push("\n**Top 5 Posts:**");
    for (const p of result.topPosts) {
      const s = p.sentiment === "bullish" ? "🟢" : p.sentiment === "bearish" ? "🔴" : "⚪";
      const titleShort = p.title.length > 60 ? p.title.slice(0, 57) + "..." : p.title;
      lines.push(`${s} [${p.score}↑] ${titleShort}`);
    }
  }

  return lines.join("\n");
}

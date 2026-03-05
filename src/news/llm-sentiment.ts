/**
 * LLM Semantic Sentiment Analysis
 *
 * Calls Claude via OpenClaw Gateway's OpenAI-compatible API,
 * performing semantic analysis on news headlines and market data to output structured sentiment scores.
 *
 * Architecture:
 *   market-analysis.ts -> analyzeSentimentWithLLM() -> OpenClaw HTTP API
 *   -> Claude semantic understanding -> writeSentimentCache()
 *
 * Advantages over keyword matching:
 *   - Understands semantic context ("regulatory clarity" vs "regulatory crackdown" both contain "regulatory" but opposite directions)
 *   - Handles sarcasm/complex sentence structures
 *   - Integrates comprehensive judgment from multiple news items
 *   - Identifies actual impact of industry-specific events
 */

import axios from "axios";
import type { SentimentLabel, SentimentEntry } from "./sentiment-cache.js";
import { createLogger } from "../logger.js";

const log = createLogger("llm-sentiment");

// ─────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────

const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const LLM_MODEL = "openclaw:main";
const LLM_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

interface LLMSentimentResult {
  score: number;             // -10 to +10
  label: SentimentLabel;
  bullishReasons: string[];  // Up to 3 items
  bearishReasons: string[];  // Up to 3 items
  confidence: "high" | "medium" | "low";
  summary: string;           // One-sentence summary
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

// ─────────────────────────────────────────────────────
// Prompt Engineering
// ─────────────────────────────────────────────────────

function buildPrompt(params: {
  headlines: string[];
  fearGreed: number;
  btcDominance: number;
  marketCapChange: number;
}): string {
  const { headlines, fearGreed, btcDominance, marketCapChange } = params;

  const headlineText = headlines
    .slice(0, 25)
    .map((h, i) => `${i + 1}. ${h}`)
    .join("\n");

  return `You are a cryptocurrency market sentiment analysis expert. Based on the following information, provide a comprehensive judgment of current market sentiment.

## Market Data
- Fear & Greed Index: ${fearGreed}/100
- BTC Dominance: ${btcDominance.toFixed(1)}%
- 24h Total Market Cap Change: ${marketCapChange >= 0 ? "+" : ""}${marketCapChange.toFixed(2)}%

## Latest News Headlines (up to 25)
${headlineText}

## Task
Analyze the above information and output a JSON-formatted sentiment judgment. Notes:
- score range: -10 (extremely bearish) to +10 (extremely bullish)
- Focus on the substantive impact of events, not literal keywords (e.g., "regulatory clarity" is bullish, "regulatory crackdown" is bearish)
- bullishReasons and bearishReasons: up to 3 each, concise (under 15 words)

## Output Format (strict JSON, no other text)
{
  "score": <number -10 to +10>,
  "label": <"very_bullish"|"bullish"|"neutral"|"bearish"|"very_bearish">,
  "bullishReasons": ["...", "..."],
  "bearishReasons": ["...", "..."],
  "confidence": <"high"|"medium"|"low">,
  "summary": "<one-sentence summary, under 30 words>"
}`;
}

// ─────────────────────────────────────────────────────
// Core Function
// ─────────────────────────────────────────────────────

/**
 * Call LLM to analyze market sentiment
 *
 * @returns LLMSentimentResult, or null (falls back to keywords when LLM is unavailable)
 */
export async function analyzeSentimentWithLLM(params: {
  headlines: string[];
  fearGreed: number;
  btcDominance: number;
  marketCapChange: number;
}): Promise<LLMSentimentResult | null> {
  const token = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
  if (!token) {
    log.warn("OPENCLAW_GATEWAY_TOKEN not configured, LLM sentiment analysis skipped");
    return null;
  }

  const prompt = buildPrompt(params);

  try {
    const response = await axios.post<ChatCompletionResponse>(
      `${GATEWAY_URL}/v1/chat/completions`,
      {
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.3,  // Low temperature: reduce randomness, ensure stable output format
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: LLM_TIMEOUT_MS,
      }
    );

    const content = response.data.choices[0]?.message.content ?? "";
    return parseLLMResponse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`LLM sentiment analysis failed (${msg}), falling back to keyword matching`);
    return null;
  }
}

/**
 * Parse JSON returned by LLM
 */
function parseLLMResponse(content: string): LLMSentimentResult | null {
  try {
    // Extract JSON (LLM may add explanatory text before/after)
    const jsonMatch = (/\{[\s\S]*\}/).exec(content);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<LLMSentimentResult>;

    // Validate required fields
    if (typeof parsed.score !== "number") return null;
    if (!isValidLabel(parsed.label)) return null;

    return {
      score: Math.max(-10, Math.min(10, parsed.score)),
      label: parsed.label,
      bullishReasons: (parsed.bullishReasons ?? []).slice(0, 3),
      bearishReasons: (parsed.bearishReasons ?? []).slice(0, 3),
      confidence: parsed.confidence ?? "medium",
      summary: parsed.summary ?? "",
    };
  } catch {
    return null;
  }
}

function isValidLabel(v: unknown): v is SentimentLabel {
  return ["very_bullish", "bullish", "neutral", "bearish", "very_bearish"].includes(v as string);
}

// ─────────────────────────────────────────────────────
// Convert to SentimentEntry (for writeSentimentCache)
// ─────────────────────────────────────────────────────

export function llmResultToEntry(
  result: LLMSentimentResult,
  headlineCount: number
): Omit<SentimentEntry, "updatedAt" | "source"> {
  return {
    score: result.score,
    label: result.label,
    bullishReasons: result.bullishReasons,
    bearishReasons: result.bearishReasons,
    headlineCount,
    analyzedBy: `LLM (confidence: ${result.confidence})`,
  };
}

/**
 * Format LLM analysis results for report output
 */
export function formatLLMSentimentReport(result: LLMSentimentResult): string {
  const scoreStr = result.score >= 0 ? `+${result.score}` : `${result.score}`;
  const confEmoji = { high: "🎯", medium: "🤔", low: "❓" }[result.confidence];
  const lines = [
    `🤖 **LLM Sentiment Analysis** ${confEmoji} | Score ${scoreStr}/10`,
    `📝 ${result.summary}`,
  ];
  if (result.bullishReasons.length > 0) {
    lines.push(`🟢 Bullish: ${result.bullishReasons.join(" · ")}`);
  }
  if (result.bearishReasons.length > 0) {
    lines.push(`🔴 Bearish: ${result.bearishReasons.join(" · ")}`);
  }
  return lines.join("\n");
}

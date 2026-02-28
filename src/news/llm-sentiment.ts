/**
 * LLM 语义情绪分析
 *
 * 通过 OpenClaw Gateway 的 OpenAI 兼容 API 调用 Claude，
 * 对新闻标题和市场数据进行语义分析，输出结构化情绪评分。
 *
 * 架构：
 *   market-analysis.ts → analyzeSentimentWithLLM() → OpenClaw HTTP API
 *   → Claude 语义理解 → writeSentimentCache()
 *
 * 相比关键词匹配的优势：
 *   - 理解语义上下文（"监管明朗" vs "监管收紧" 都含"监管"但方向相反）
 *   - 处理讽刺/复杂句式
 *   - 整合多条新闻的综合判断
 *   - 识别行业特定事件的实际影响
 */

import axios from "axios";
import type { SentimentLabel, SentimentEntry } from "./sentiment-cache.js";
import { createLogger } from "../logger.js";

const log = createLogger("llm-sentiment");

// ─────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────

const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const LLM_MODEL = "openclaw:main";
const LLM_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────

interface LLMSentimentResult {
  score: number;             // -10 到 +10
  label: SentimentLabel;
  bullishReasons: string[];  // 最多 3 条
  bearishReasons: string[];  // 最多 3 条
  confidence: "high" | "medium" | "low";
  summary: string;           // 一句话总结
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

// ─────────────────────────────────────────────────────
// Prompt 工程
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

  return `你是一位加密货币市场情绪分析专家。请根据以下信息，对当前市场情绪做出综合判断。

## 市场数据
- 恐惧贪婪指数：${fearGreed}/100
- BTC 主导率：${btcDominance.toFixed(1)}%
- 24h 总市值变化：${marketCapChange >= 0 ? "+" : ""}${marketCapChange.toFixed(2)}%

## 最新新闻标题（最多25条）
${headlineText}

## 任务
分析上述信息，输出 JSON 格式的情绪判断。注意：
- score 范围 -10（极度看空）到 +10（极度看多）
- 关注事件的实质影响，而非字面关键词（如"监管明朗"是利多，"监管收紧"是利空）
- bullishReasons 和 bearishReasons 各最多 3 条，简洁中文（15字以内）

## 输出格式（严格 JSON，不要加任何其他文字）
{
  "score": <number -10 to +10>,
  "label": <"very_bullish"|"bullish"|"neutral"|"bearish"|"very_bearish">,
  "bullishReasons": ["...", "..."],
  "bearishReasons": ["...", "..."],
  "confidence": <"high"|"medium"|"low">,
  "summary": "<一句话中文总结，30字以内>"
}`;
}

// ─────────────────────────────────────────────────────
// 核心函数
// ─────────────────────────────────────────────────────

/**
 * 调用 LLM 分析市场情绪
 *
 * @returns LLMSentimentResult，或 null（LLM 不可用时降级到关键词）
 */
export async function analyzeSentimentWithLLM(params: {
  headlines: string[];
  fearGreed: number;
  btcDominance: number;
  marketCapChange: number;
}): Promise<LLMSentimentResult | null> {
  const token = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
  if (!token) {
    log.warn("OPENCLAW_GATEWAY_TOKEN 未配置，LLM 情绪分析跳过");
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
        temperature: 0.3,  // 低温度：减少随机性，保证输出格式稳定
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
    log.warn(`LLM 情绪分析失败（${msg}），降级到关键词匹配`);
    return null;
  }
}

/**
 * 解析 LLM 返回的 JSON
 */
function parseLLMResponse(content: string): LLMSentimentResult | null {
  try {
    // 提取 JSON（LLM 可能在前后加说明文字）
    const jsonMatch = (/\{[\s\S]*\}/).exec(content);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<LLMSentimentResult>;

    // 校验必填字段
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
// 转换为 SentimentEntry（供 writeSentimentCache 使用）
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
 * 格式化 LLM 分析结果用于报告输出
 */
export function formatLLMSentimentReport(result: LLMSentimentResult): string {
  const scoreStr = result.score >= 0 ? `+${result.score}` : `${result.score}`;
  const confEmoji = { high: "🎯", medium: "🤔", low: "❓" }[result.confidence];
  const lines = [
    `🤖 **LLM 情绪分析** ${confEmoji} | 评分 ${scoreStr}/10`,
    `📝 ${result.summary}`,
  ];
  if (result.bullishReasons.length > 0) {
    lines.push(`🟢 利多：${result.bullishReasons.join(" · ")}`);
  }
  if (result.bearishReasons.length > 0) {
    lines.push(`🔴 利空：${result.bearishReasons.join(" · ")}`);
  }
  return lines.join("\n");
}

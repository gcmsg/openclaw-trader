/**
 * 多策略集成投票（Ensemble Strategy Voting）
 *
 * 汇聚多个策略的信号，通过加权投票决定最终方向。
 *
 * 使用方式：
 *   strategy_id: "ensemble"（在 StrategyConfig 中配置）
 *   ensemble:
 *     strategies:
 *       - id: "default"
 *         weight: 0.5
 *       - id: "rsi-reversal"
 *         weight: 0.3
 *       - id: "breakout"
 *         weight: 0.2
 *     threshold: 0.6     # 胜出信号最低得分（默认 0.5）
 *     unanimous: false   # 是否要求全票一致（默认 false）
 */

import type { SignalType } from "../types.js";
import type { StrategyContext } from "./types.js";
import { getStrategy } from "./registry.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface EnsembleConfig {
  strategies: Array<{
    id: string;     // 策略 ID（如 "default", "rsi-reversal", "breakout"）
    weight: number; // 投票权重（0~1），默认各 1/N
  }>;
  /** 多数信号必须达到的加权比例才触发。默认 0.5 */
  threshold?: number;
  /** 要求所有策略一致才触发（unanimous mode）。默认 false */
  unanimous?: boolean;
}

export interface VoteResult {
  signal: SignalType; // 最终信号
  votes: Array<{
    strategyId: string;
    signal: SignalType;
    weight: number;
  }>;
  buyScore: number;   // 买入加权得分（0~1）
  sellScore: number;  // 卖出加权得分
  shortScore: number;
  coverScore: number;
  confidence: number; // 胜出信号的得分
  unanimous: boolean; // 是否全票一致
}

// ─────────────────────────────────────────────────────
// Core Function
// ─────────────────────────────────────────────────────

/**
 * 运行所有策略并投票，决定最终信号。
 *
 * 算法：
 * 1. 遍历 config.strategies，从 registry 加载每个策略（找不到则 warn + 跳过）
 * 2. 调用 strategy.populateSignal(ctx) 获得各自信号
 * 3. 按权重归一化后累加 buy/sell/short/cover 得分
 * 4. 得分最高且 >= threshold 的方向胜出；否则 "none"
 * 5. unanimous=true 时，要求所有非 "none" 投票方向一致，否则返回 "none"
 */
export function ensembleVote(
  config: EnsembleConfig,
  ctx: StrategyContext
): VoteResult {
  const threshold = config.threshold ?? 0.5;
  const unanimousMode = config.unanimous ?? false;

  // ── 空策略列表 ────────────────────────────────────
  if (config.strategies.length === 0) {
    return buildEmptyResult();
  }

  // ── 计算总权重（用于归一化）────────────────────────
  let totalWeight = 0;
  for (const s of config.strategies) {
    totalWeight += s.weight;
  }
  if (totalWeight <= 0) totalWeight = 1; // 防止除零

  // ── 执行各策略投票 ────────────────────────────────
  const votes: VoteResult["votes"] = [];
  let buyScore = 0;
  let sellScore = 0;
  let shortScore = 0;
  let coverScore = 0;

  for (const entry of config.strategies) {
    let strategy;
    try {
      strategy = getStrategy(entry.id);
    } catch {
      // 策略不存在：warn + 跳过（不计入投票）
      console.warn(`[ensemble] 策略 "${entry.id}" 未注册，跳过`);
      continue;
    }

    const signal = strategy.populateSignal(ctx);
    const normalizedWeight = entry.weight / totalWeight;

    votes.push({ strategyId: entry.id, signal, weight: entry.weight });

    switch (signal) {
      case "buy":   buyScore   += normalizedWeight; break;
      case "sell":  sellScore  += normalizedWeight; break;
      case "short": shortScore += normalizedWeight; break;
      case "cover": coverScore += normalizedWeight; break;
      case "none":  /* 弃权，不累加 */ break;
    }
  }

  // ── 如果没有有效投票 ──────────────────────────────
  if (votes.length === 0) {
    return buildEmptyResult();
  }

  // ── unanimous 模式：要求所有非 none 投票方向一致 ──
  if (unanimousMode) {
    const nonNoneSignals = votes
      .map((v) => v.signal)
      .filter((s): s is Exclude<SignalType, "none"> => s !== "none");

    if (nonNoneSignals.length === 0) {
      // 全部弃权 → none
      return {
        signal: "none",
        votes,
        buyScore,
        sellScore,
        shortScore,
        coverScore,
        confidence: 0,
        unanimous: true,
      };
    }

    const first = nonNoneSignals[0]!;
    const isUnanimous = nonNoneSignals.every((s) => s === first);

    if (!isUnanimous) {
      // 不一致 → none
      return {
        signal: "none",
        votes,
        buyScore,
        sellScore,
        shortScore,
        coverScore,
        confidence: 0,
        unanimous: false,
      };
    }

    // 一致：使用该方向，但仍需满足 threshold
    const winScore = scoreForSignal(first, buyScore, sellScore, shortScore, coverScore);
    if (winScore < threshold) {
      return {
        signal: "none",
        votes,
        buyScore,
        sellScore,
        shortScore,
        coverScore,
        confidence: winScore,
        unanimous: true,
      };
    }

    return {
      signal: first,
      votes,
      buyScore,
      sellScore,
      shortScore,
      coverScore,
      confidence: winScore,
      unanimous: true,
    };
  }

  // ── 普通模式：得分最高且 >= threshold 的信号胜出 ──
  const scores: Array<[SignalType, number]> = [
    ["buy", buyScore],
    ["sell", sellScore],
    ["short", shortScore],
    ["cover", coverScore],
  ];

  // 找出最高得分
  let maxScore = 0;
  let winSignal: SignalType = "none";

  for (const [sig, score] of scores) {
    if (score > maxScore) {
      maxScore = score;
      winSignal = sig;
    }
  }

  // 最高得分必须 >= threshold 才能胜出
  if (maxScore < threshold) {
    winSignal = "none";
  }

  // ── 检查是否全票一致 ──────────────────────────────
  const nonNoneVotes = votes.filter((v) => v.signal !== "none");
  let isUnanimous = false;
  if (nonNoneVotes.length > 0) {
    const first = nonNoneVotes[0]!.signal;
    isUnanimous =
      nonNoneVotes.every((v) => v.signal === first) &&
      nonNoneVotes.length === votes.length;
  } else {
    // 所有都是 none → 视为一致（全弃权）
    isUnanimous = true;
  }

  return {
    signal: winSignal,
    votes,
    buyScore,
    sellScore,
    shortScore,
    coverScore,
    confidence: maxScore,
    unanimous: isUnanimous,
  };
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function buildEmptyResult(): VoteResult {
  return {
    signal: "none",
    votes: [],
    buyScore: 0,
    sellScore: 0,
    shortScore: 0,
    coverScore: 0,
    confidence: 0,
    unanimous: true,
  };
}

function scoreForSignal(
  signal: SignalType,
  buyScore: number,
  sellScore: number,
  shortScore: number,
  coverScore: number
): number {
  switch (signal) {
    case "buy":   return buyScore;
    case "sell":  return sellScore;
    case "short": return shortScore;
    case "cover": return coverScore;
    case "none":  return 0;
  }
}

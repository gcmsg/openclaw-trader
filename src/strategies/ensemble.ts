/**
 * Multi-Strategy Ensemble Voting (Ensemble Strategy Voting)
 *
 * Aggregates signals from multiple strategies via weighted voting to determine the final direction.
 *
 * Usage:
 *   strategy_id: "ensemble" (configured in StrategyConfig)
 *   ensemble:
 *     strategies:
 *       - id: "default"
 *         weight: 0.5
 *       - id: "rsi-reversal"
 *         weight: 0.3
 *       - id: "breakout"
 *         weight: 0.2
 *     threshold: 0.6     # Minimum score for winning signal (default 0.5)
 *     unanimous: false   # Whether all votes must agree (default false)
 */

import type { SignalType } from "../types.js";
import type { StrategyContext } from "./types.js";
import { getStrategy } from "./registry.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface EnsembleConfig {
  strategies: {
    id: string;     // Strategy ID (e.g. "default", "rsi-reversal", "breakout")
    weight: number; // Voting weight (0~1), default 1/N each
  }[];
  /** Weighted ratio the majority signal must reach to trigger. Default 0.5 */
  threshold?: number;
  /** Require all strategies to agree before triggering (unanimous mode). Default false */
  unanimous?: boolean;
}

export interface VoteResult {
  signal: SignalType; // Final signal
  votes: {
    strategyId: string;
    signal: SignalType;
    weight: number;
  }[];
  buyScore: number;   // Buy weighted score (0~1)
  sellScore: number;  // Sell weighted score
  shortScore: number;
  coverScore: number;
  confidence: number; // Winning signal's score
  unanimous: boolean; // Whether all votes are unanimous
}

// ─────────────────────────────────────────────────────
// Core Function
// ─────────────────────────────────────────────────────

/**
 * Run all strategies and vote to determine the final signal.
 *
 * Algorithm:
 * 1. Iterate config.strategies, load each strategy from registry (warn + skip if not found)
 * 2. Call strategy.populateSignal(ctx) to get each strategy's signal
 * 3. Normalize by weight and accumulate buy/sell/short/cover scores
 * 4. Highest score >= threshold wins; otherwise "none"
 * 5. When unanimous=true, all non-"none" votes must agree, otherwise return "none"
 */
export function ensembleVote(
  config: EnsembleConfig,
  ctx: StrategyContext
): VoteResult {
  const threshold = config.threshold ?? 0.5;
  const unanimousMode = config.unanimous ?? false;

  // ── Empty strategy list ────────────────────────────
  if (config.strategies.length === 0) {
    return buildEmptyResult();
  }

  // ── Calculate total weight (for normalization) ─────
  let totalWeight = 0;
  for (const s of config.strategies) {
    totalWeight += s.weight;
  }
  if (totalWeight <= 0) totalWeight = 1; // Prevent division by zero

  // ── Execute each strategy's vote ───────────────────
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
      // Strategy not found: warn + skip (not counted in voting)
      console.warn(`[ensemble] strategy "${entry.id}" not registered, skipping`);
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
      case "none":  /* Abstain, do not accumulate */ break;
    }
  }

  // ── If no valid votes ──────────────────────────────
  if (votes.length === 0) {
    return buildEmptyResult();
  }

  // ── Unanimous mode: require all non-none votes to agree ──
  if (unanimousMode) {
    const nonNoneSignals = votes
      .map((v) => v.signal)
      .filter((s): s is Exclude<SignalType, "none"> => s !== "none");

    if (nonNoneSignals.length === 0) {
      // All abstained -> none
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
      // Not unanimous -> none
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

    // Unanimous: use that direction, but still need to meet threshold
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

  // ── Normal mode: highest score >= threshold wins ────
  const scores: [SignalType, number][] = [
    ["buy", buyScore],
    ["sell", sellScore],
    ["short", shortScore],
    ["cover", coverScore],
  ];

  // Find the highest score
  let maxScore = 0;
  let winSignal: SignalType = "none";

  for (const [sig, score] of scores) {
    if (score > maxScore) {
      maxScore = score;
      winSignal = sig;
    }
  }

  // Highest score must be >= threshold to win
  if (maxScore < threshold) {
    winSignal = "none";
  }

  // ── Check if votes are unanimous ───────────────────
  const nonNoneVotes = votes.filter((v) => v.signal !== "none");
  let isUnanimous: boolean;
  if (nonNoneVotes.length > 0) {
    const first = nonNoneVotes[0]!.signal;
    isUnanimous =
      nonNoneVotes.every((v) => v.signal === first) &&
      nonNoneVotes.length === votes.length;
  } else {
    // All are none -> treat as unanimous (all abstained)
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

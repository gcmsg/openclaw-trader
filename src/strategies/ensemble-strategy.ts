/**
 * Ensemble Voting Strategy Plugin (Ensemble Strategy)
 *
 * Strategy id = "ensemble"
 * Internally calls ensembleVote() to aggregate signals from multiple sub-strategies via weighted voting to determine the final direction.
 *
 * Configuration (strategy.yaml):
 *   strategy_id: "ensemble"
 *   ensemble:
 *     strategies:
 *       - id: "rsi-reversal"
 *         weight: 0.5
 *       - id: "breakout"
 *         weight: 0.5
 *     threshold: 0.6
 *     unanimous: false
 *
 * VoteResult is stored in ctx.extra.ensembleVote for logging/notification use.
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";
import { ensembleVote } from "./ensemble.js";
import type { EnsembleConfig } from "./ensemble.js";

const ensembleStrategy: Strategy = {
  id: "ensemble",
  name: "Ensemble Voting",
  description:
    "Merges signals from multiple strategies via weighted voting. Supports threshold (minimum confidence) and unanimous (all-agree) modes.",

  populateSignal(ctx: StrategyContext): SignalType {
    // Read ensemble config from configuration
    const ensembleCfg = (ctx.cfg as { ensemble?: EnsembleConfig }).ensemble;

    if (!ensembleCfg) {
      console.warn("[ensemble-strategy] ensemble not configured, returning none");
      return "none";
    }

    // Execute weighted voting
    const result = ensembleVote(ensembleCfg, ctx);

    // Store VoteResult in ctx.extra for logging/notification use
    if (ctx.extra !== undefined) {
      // ctx.extra is ExtraIndicators (Record<string, number | boolean | undefined>)
      // Store vote results as individual fields (type constraint does not support nested objects)
      ctx.extra["ensembleSignal"] = result.signal === "none" ? 0 : 1;
      ctx.extra["ensembleBuyScore"] = result.buyScore;
      ctx.extra["ensembleSellScore"] = result.sellScore;
      ctx.extra["ensembleShortScore"] = result.shortScore;
      ctx.extra["ensembleCoverScore"] = result.coverScore;
      ctx.extra["ensembleConfidence"] = result.confidence;
      ctx.extra["ensembleUnanimous"] = result.unanimous;
    }

    return result.signal;
  },
};

// Auto-register (triggered on import)
registerStrategy(ensembleStrategy);

export { ensembleStrategy };

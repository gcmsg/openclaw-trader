/**
 * RSI Mean Reversion Strategy Plugin (F4 / P7.4)
 *
 * Logic:
 *   RSI < oversold (default 30) -> oversold, buy
 *   RSI > overbought (default 70) -> overbought, sell
 *   Otherwise -> none
 *
 * P7.4 addition: Consecutive loss protection
 *   Consecutive losses >= 3 -> pause opening positions, return "none"
 *   onTradeClosed callback: loss +1, profit resets to 0
 *
 * Use case: Ranging/sideways market (Ranging Regime)
 * Parameter source: cfg.strategy.rsi.oversold / overbought (reuses YAML config values)
 *
 * Usage (paper.yaml scenario level):
 *   strategy_plugin_id: "rsi-reversal"
 */

import type { Strategy, StrategyContext, TradeResult } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";


const rsiReversalStrategy: Strategy = {
  id: "rsi-reversal",
  name: "RSI Mean Reversion",
  description:
    "RSI < oversold -> buy (oversold bottom fishing); RSI > overbought -> sell (overbought exit). Suitable for ranging/sideways markets." +
    " Pauses opening positions after >= 3 consecutive losses (risk reduction).",

  populateSignal(ctx: StrategyContext): SignalType {
    const { indicators, cfg, stateStore } = ctx;

    // Read consecutive loss count (default 0)
    const consecutiveLosses = stateStore?.get<number>("consecutiveLosses", 0) ?? 0;

    // If consecutive losses >= 3, skip entry signals (risk reduction)
    if (consecutiveLosses >= 3) {
      return "none";
    }

    // Read thresholds from config (or use defaults)
    const oversold = cfg.strategy.rsi.oversold;
    const overbought = cfg.strategy.rsi.overbought;

    if (indicators.rsi < oversold) {
      return "buy";
    }

    if (indicators.rsi > overbought) {
      return "sell";
    }

    return "none";
  },

  onTradeClosed(result: TradeResult, ctx: StrategyContext): void {
    const { stateStore } = ctx;
    if (!stateStore) return;

    const consecutiveLosses = stateStore.get("consecutiveLosses", 0);
    if (result.pnl < 0) {
      stateStore.set("consecutiveLosses", consecutiveLosses + 1);
    } else {
      stateStore.set("consecutiveLosses", 0); // Reset on profit
    }
  },

  /**
   * Strategy-level position adjustment logic (P9: adjustPosition)
   * Condition: RSI < 20 and loss > 3% and DCA count < 2 -> add 50% to position
   */
  adjustPosition(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      quantity: number;
      costBasis: number;
      profitRatio: number;
      holdMs: number;
      dcaCount: number;
    },
    ctx: StrategyContext
  ): number | null {
    const { indicators } = ctx;

    if (
      indicators.rsi < 20 &&
      position.profitRatio < -0.03 &&
      position.dcaCount < 2
    ) {
      return position.costBasis * 0.5; // Add 50% to position
    }

    return null;
  },
};

// Auto-register (triggered on import)
registerStrategy(rsiReversalStrategy);

export { rsiReversalStrategy };

/**
 * Strategy Plugin Interface Definition (F4)
 *
 * Abstracts signal logic into pluggable strategy plugins, coexisting with existing config-driven logic:
 *   - strategy_id: "default" -> uses existing YAML condition matching logic (behavior unchanged)
 *   - strategy_id: "rsi-reversal" | "breakout" | custom -> uses plugin logic
 */

import type { Kline, StrategyConfig, SignalType } from "../types.js";
import type { Indicators } from "../types.js";
import type { StateStore } from "./state-store.js";

// ─────────────────────────────────────────────────────
// Extra Indicators (additional indicators computable by plugins)
// ─────────────────────────────────────────────────────

export type ExtraIndicators = Record<string, number | boolean | undefined>;

// ─────────────────────────────────────────────────────
// Strategy Context (complete context passed to plugins)
// ─────────────────────────────────────────────────────

export interface StrategyContext {
  klines: Kline[];
  /** Runtime config (StrategyConfig or its subclass RuntimeConfig) */
  cfg: StrategyConfig;
  indicators: Indicators;
  /** Current position direction (undefined = no position). Default strategy needs this field to reproduce detectSignal's position-aware logic */
  currentPosSide?: "long" | "short";
  extra?: ExtraIndicators;
  /** Optional: Strategy state store (persistent across candles). Omitting means stateless mode */
  stateStore?: StateStore;
}

// ─────────────────────────────────────────────────────
// Trade Result (trade close result, for onTradeClosed callback)
// ─────────────────────────────────────────────────────

export interface TradeResult {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  pnl: number;        // USDT
  pnlPercent: number; // -0.05 means -5%
  holdMs: number;
  exitReason: string;
}

// ─────────────────────────────────────────────────────
// Exit Result (custom exit result)
// ─────────────────────────────────────────────────────

export interface ExitResult {
  exit: boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────
// Strategy Interface
// ─────────────────────────────────────────────────────

export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly description?: string;

  /**
   * Optional: Compute additional indicators beyond built-in MA/RSI/MACD.
   * Return values are merged into indicators (does not overwrite existing fields).
   */
  populateIndicators?(ctx: StrategyContext): ExtraIndicators;

  /**
   * Core: Determine signal direction based on indicators.
   * Return "none" for no action.
   */
  populateSignal(ctx: StrategyContext): SignalType;

  /**
   * Optional: Custom exit logic.
   * Return null to use default stop-loss/take-profit logic.
   */
  shouldExit?(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      holdMs: number;
    },
    ctx: StrategyContext
  ): ExitResult | null;

  /**
   * Optional: Callback after trade close, strategy can update internal state.
   * Called each time the paper/live engine closes a trade.
   */
  onTradeClosed?(result: TradeResult, ctx: StrategyContext): void;

  /**
   * Optional: Strategy-level position increase/decrease logic (ref: Freqtrade adjust_trade_position).
   * Called during each position check cycle. Return value meaning:
   *   > 0: Amount to add (USDT)
   *   < 0: Amount to reduce (USDT, absolute value)
   *   0 or null: No adjustment
   *
   * Current checkDcaTranches() hardcoded logic serves as the default fallback.
   */
  adjustPosition?(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      quantity: number;
      costBasis: number;        // Current total cost (USDT)
      profitRatio: number;      // Current profit/loss ratio
      holdMs: number;
      dcaCount: number;         // Number of DCA entries so far
    },
    ctx: StrategyContext
  ): number | null;

  /**
   * Optional: Custom dynamic stoploss logic (ref: Freqtrade custom_stoploss).
   * Return new stoploss price, return null to use default stoploss logic (including break_even_stop).
   * Called once per cycle only during position holding.
   */
  customStoploss?(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      currentStopLoss: number;
      profitRatio: number;   // Current profit ratio (positive = profit)
      holdMs: number;
    },
    ctx: StrategyContext
  ): number | null;

  /**
   * Optional: Pre-exit confirmation hook (ref: Freqtrade confirm_trade_exit).
   * Called before executing stop-loss/take-profit/ROI/signal exits. Return false to skip this exit (retry next cycle).
   * Typical uses: Flash crash protection (reject exit on abnormal price deviation), liquidity checks, exit cooldown.
   */
  confirmExit?(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      profitRatio: number;
      holdMs: number;
    },
    exitReason: string,
    ctx: StrategyContext
  ): boolean;
}

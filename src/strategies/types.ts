/**
 * Strategy Plugin 接口定义（F4）
 *
 * 将信号逻辑抽象为可插拔的策略插件，与现有配置驱动逻辑共存：
 *   - strategy_id: "default" → 走现有 YAML 条件匹配逻辑（行为完全不变）
 *   - strategy_id: "rsi-reversal" | "breakout" | 自定义 → 走插件逻辑
 */

import type { Kline, StrategyConfig, SignalType } from "../types.js";
import type { Indicators } from "../types.js";
import type { StateStore } from "./state-store.js";

// ─────────────────────────────────────────────────────
// Extra Indicators (插件可计算的额外指标)
// ─────────────────────────────────────────────────────

export interface ExtraIndicators {
  [key: string]: number | boolean | undefined;
}

// ─────────────────────────────────────────────────────
// Strategy Context（传入插件的完整上下文）
// ─────────────────────────────────────────────────────

export interface StrategyContext {
  klines: Kline[];
  /** 运行时配置（StrategyConfig 或其子类 RuntimeConfig 均可） */
  cfg: StrategyConfig;
  indicators: Indicators;
  /** 当前持仓方向（undefined = 无持仓）。默认策略需要此字段来复现 detectSignal 的持仓感知逻辑 */
  currentPosSide?: "long" | "short";
  extra?: ExtraIndicators;
  /** 可选：策略状态存储（跨 candle 持久化）。不传时表示无状态模式 */
  stateStore?: StateStore;
}

// ─────────────────────────────────────────────────────
// Trade Result（交易关闭结果，用于 onTradeClosed 回调）
// ─────────────────────────────────────────────────────

export interface TradeResult {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  pnl: number;        // USDT
  pnlPercent: number; // -0.05 表示 -5%
  holdMs: number;
  exitReason: string;
}

// ─────────────────────────────────────────────────────
// Exit Result（自定义出场结果）
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
   * 可选：在内置 MA/RSI/MACD 指标之外计算额外指标。
   * 返回值会 merge 到 indicators 中（不覆盖已有字段）。
   */
  populateIndicators?(ctx: StrategyContext): ExtraIndicators;

  /**
   * 核心：基于指标判断信号方向。
   * 返回 "none" 表示不操作。
   */
  populateSignal(ctx: StrategyContext): SignalType;

  /**
   * 可选：自定义出场逻辑。
   * 返回 null 则走默认止损/止盈逻辑。
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
   * 可选：交易关闭后回调，策略可更新内部状态。
   * 每次 paper/live 引擎关闭一笔交易后调用。
   */
  onTradeClosed?(result: TradeResult, ctx: StrategyContext): void;

  /**
   * 可选：自定义动态止损逻辑（参考 Freqtrade custom_stoploss）。
   * 返回新的止损价格，返回 null 则使用默认止损逻辑（含 break_even_stop）。
   * 仅在持仓期间每轮调用一次。
   */
  customStoploss?(
    position: {
      symbol: string;
      side: "long" | "short";
      entryPrice: number;
      currentPrice: number;
      currentStopLoss: number;
      profitRatio: number;   // 当前盈利比率（正 = 盈利）
      holdMs: number;
    },
    ctx: StrategyContext
  ): number | null;
}

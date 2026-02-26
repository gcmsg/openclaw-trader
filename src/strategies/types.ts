/**
 * Strategy Plugin 接口定义（F4）
 *
 * 将信号逻辑抽象为可插拔的策略插件，与现有配置驱动逻辑共存：
 *   - strategy_id: "default" → 走现有 YAML 条件匹配逻辑（行为完全不变）
 *   - strategy_id: "rsi-reversal" | "breakout" | 自定义 → 走插件逻辑
 */

import type { Kline, StrategyConfig, SignalType } from "../types.js";
import type { Indicators } from "../types.js";

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
}

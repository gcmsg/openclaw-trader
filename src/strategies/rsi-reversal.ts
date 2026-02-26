/**
 * RSI 均值回归策略插件（F4）
 *
 * 逻辑：
 *   RSI < oversold（默认 30）→ 超卖，买入（buy）
 *   RSI > overbought（默认 70）→ 超买，卖出（sell）
 *   其他 → none
 *
 * 适用场景：横盘震荡市（Ranging Regime）
 * 参数读取：cfg.strategy.rsi.oversold / overbought（复用 YAML 配置值）
 *
 * 使用方式（paper.yaml scenario 级别）：
 *   strategy_plugin_id: "rsi-reversal"
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";

const rsiReversalStrategy: Strategy = {
  id: "rsi-reversal",
  name: "RSI 均值回归",
  description:
    "RSI < oversold → buy（超卖抄底）；RSI > overbought → sell（超买出场）。适合横盘震荡行情。",

  populateSignal(ctx: StrategyContext): SignalType {
    const { indicators, cfg } = ctx;

    // 从配置读取阈值（或使用默认值）
    const oversold = cfg.strategy.rsi.oversold ?? 30;
    const overbought = cfg.strategy.rsi.overbought ?? 70;

    if (indicators.rsi < oversold) {
      return "buy";
    }

    if (indicators.rsi > overbought) {
      return "sell";
    }

    return "none";
  },
};

// 自动注册（import 时触发）
registerStrategy(rsiReversalStrategy);

export { rsiReversalStrategy };

/**
 * RSI 均值回归策略插件（F4 / P7.4）
 *
 * 逻辑：
 *   RSI < oversold（默认 30）→ 超卖，买入（buy）
 *   RSI > overbought（默认 70）→ 超买，卖出（sell）
 *   其他 → none
 *
 * P7.4 新增：连续亏损保护
 *   连续亏损 >= 3 次 → 暂停开仓，返回 "none"
 *   onTradeClosed 回调：亏损 +1，盈利重置为 0
 *
 * 适用场景：横盘震荡市（Ranging Regime）
 * 参数读取：cfg.strategy.rsi.oversold / overbought（复用 YAML 配置值）
 *
 * 使用方式（paper.yaml scenario 级别）：
 *   strategy_plugin_id: "rsi-reversal"
 */

import type { Strategy, StrategyContext, TradeResult } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";

const rsiReversalStrategy: Strategy = {
  id: "rsi-reversal",
  name: "RSI 均值回归",
  description:
    "RSI < oversold → buy（超卖抄底）；RSI > overbought → sell（超买出场）。适合横盘震荡行情。" +
    " 连续亏损 >= 3 次时暂停开仓（降低风险）。",

  populateSignal(ctx: StrategyContext): SignalType {
    const { indicators, cfg, stateStore } = ctx;

    // 读取连续亏损次数（默认 0）
    const consecutiveLosses = stateStore?.get("consecutiveLosses", 0) ?? 0;

    // 如果连续亏损 >= 3 次，跳过开仓信号（降低风险）
    if (consecutiveLosses >= 3) {
      return "none";
    }

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

  onTradeClosed(result: TradeResult, ctx: StrategyContext): void {
    const { stateStore } = ctx;
    if (!stateStore) return;

    const consecutiveLosses = stateStore.get("consecutiveLosses", 0);
    if (result.pnl < 0) {
      stateStore.set("consecutiveLosses", consecutiveLosses + 1);
    } else {
      stateStore.set("consecutiveLosses", 0); // 盈利时重置
    }
  },
};

// 自动注册（import 时触发）
registerStrategy(rsiReversalStrategy);

export { rsiReversalStrategy };

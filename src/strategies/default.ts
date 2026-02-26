/**
 * 默认策略插件（F4）
 *
 * 将现有 YAML 配置驱动的信号检测逻辑封装为 Strategy 插件。
 * 行为与 signal-engine.ts → detectSignal() 完全一致，读取
 * cfg.signals.buy / cfg.signals.sell / cfg.signals.short / cfg.signals.cover。
 *
 * 注意：不修改也不删除原 detectSignal()，保持完全向后兼容。
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { detectSignal } from "../strategy/signals.js";
import { registerStrategy } from "./registry.js";

const defaultStrategy: Strategy = {
  id: "default",
  name: "配置驱动（YAML 条件匹配）",
  description:
    "使用 strategy.yaml / strategies/*.yaml 中的 signals.buy/sell/short/cover 条件匹配信号。保留原有行为，不做任何修改。",

  populateSignal(ctx: StrategyContext): SignalType {
    // 直接复用现有 detectSignal，保持完全一致（含持仓感知逻辑）
    const signal = detectSignal(
      "plugin_call",
      ctx.indicators,
      ctx.cfg,
      ctx.currentPosSide
    );
    return signal.type;
  },
};

// 自动注册（import 时触发）
registerStrategy(defaultStrategy);

export { defaultStrategy };

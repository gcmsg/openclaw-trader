/**
 * 内置策略注册入口（F4）
 *
 * import 此文件即可触发所有内置策略的自动注册。
 * signal-engine.ts 在模块顶部 import 这里，确保注册在首次 processSignal 调用前完成。
 */

// 触发注册（副作用 import）
import "./default.js";
import "./rsi-reversal.js";
import "./breakout.js";
import "./ensemble-strategy.js";

// 重新导出公共 API
export { registerStrategy, getStrategy, listStrategies, listStrategyDetails } from "./registry.js";
export type { Strategy, StrategyContext, ExtraIndicators, ExitResult } from "./types.js";

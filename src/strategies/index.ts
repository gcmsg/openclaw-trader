/**
 * Built-in Strategy Registration Entry Point (F4)
 *
 * Importing this file triggers auto-registration of all built-in strategies.
 * signal-engine.ts imports this at the module top level, ensuring registration completes before the first processSignal call.
 */

// Trigger registration (side-effect imports)
import "./default.js";
import "./rsi-reversal.js";
import "./breakout.js";
import "./ensemble-strategy.js";

// Re-export public API
export { registerStrategy, getStrategy, listStrategies, listStrategyDetails } from "./registry.js";
export type { Strategy, StrategyContext, ExtraIndicators, ExitResult } from "./types.js";

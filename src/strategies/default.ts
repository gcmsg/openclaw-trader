/**
 * Default Strategy Plugin (F4)
 *
 * Wraps the existing YAML config-driven signal detection logic as a Strategy plugin.
 * Behavior is identical to signal-engine.ts -> detectSignal(), reading
 * cfg.signals.buy / cfg.signals.sell / cfg.signals.short / cfg.signals.cover.
 *
 * Note: Does not modify or remove the original detectSignal(), fully backward compatible.
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { detectSignal } from "../strategy/signals.js";
import { registerStrategy } from "./registry.js";

const defaultStrategy: Strategy = {
  id: "default",
  name: "Config-Driven (YAML Condition Matching)",
  description:
    "Uses signals.buy/sell/short/cover conditions from strategy.yaml / strategies/*.yaml for signal matching. Preserves original behavior without any modifications.",

  populateSignal(ctx: StrategyContext): SignalType {
    // Directly reuse existing detectSignal, maintaining full consistency (including position-aware logic)
    const signal = detectSignal(
      "plugin_call",
      ctx.indicators,
      ctx.cfg,
      ctx.currentPosSide
    );
    return signal.type;
  },
};

// Auto-register (triggered on import)
registerStrategy(defaultStrategy);

export { defaultStrategy };

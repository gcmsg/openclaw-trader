/**
 * Regime Adaptive Parameter Switching
 *
 * Automatically switches to optimal parameter set for the current market regime based on classifyRegime() results.
 * Parameter source: cycle-analysis segmented backtest + hyperopt optimization results.
 *
 * Design principles:
 *   - Bull market: Aggressive long (tight stop-loss, large take-profit, large position)
 *   - Ranging market: Quick in/out (small take-profit, medium position) + mean reversion
 *   - Bear market: Primarily short / very conservative long + small position
 *   - Breakout: Wait for confirmation, no opening
 */

import type { StrategyConfig, RiskConfig } from "../types.js";
import type { MarketRegime } from "./regime.js";

// ── Per-regime optimal parameters (from cycle-analysis hyperopt results) ────

export interface RegimeParams {
  /** Strategy indicator parameter overrides */
  strategy: {
    ma: { short: number; long: number };
    rsi: { period: number; overbought: number; oversold: number };
  };
  /** Risk management parameter overrides */
  risk: Partial<RiskConfig>;
  /** Signal condition overrides (optional) */
  signals?: {
    buy?: string[];
    sell?: string[];
    short?: string[];
    cover?: string[];
  };
  /** Whether shorting is allowed */
  allowShort: boolean;
  /** Description */
  description: string;
}

/**
 * Parameter set for each regime
 *
 * Data source: Summary of cycle-analysis 6-phase hyperopt results
 * - trending_bull <- Bull market launch phase optimal
 * - trending_bear <- Early bear market optimal + shorting enabled
 * - ranging_tight <- Bottom accumulation phase optimal (wide stop-loss, wait for breakout)
 * - ranging_wide <- High volatility ranging phase optimal (quick in/out)
 * - breakout_up/down <- Breakout phase, conservative, wait for confirmation
 */
export const REGIME_PARAMS: Record<MarketRegime, RegimeParams> = {
  trending_bull: {
    description: "Bull trend — aggressive long, tight stop-loss, large take-profit",
    strategy: {
      ma: { short: 26, long: 90 },
      rsi: { period: 16, overbought: 75, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 3.2,
      take_profit_percent: 23,
      position_ratio: 0.28,
      trailing_stop: { enabled: true, activation_percent: 10, callback_percent: 3 },
    },
    allowShort: false,
  },

  trending_bear: {
    description: "Bear trend — primarily short, conservative long",
    strategy: {
      ma: { short: 10, long: 65 },
      rsi: { period: 14, overbought: 60, oversold: 25 },
    },
    risk: {
      stop_loss_percent: 3.7,
      take_profit_percent: 11,
      position_ratio: 0.15,        // Bear market: halve position size
    },
    signals: {
      short: ["ma_bearish", "macd_bearish", "rsi_not_oversold"],
      cover: ["ma_bullish"],
    },
    allowShort: true,
  },

  ranging_tight: {
    description: "Low volatility ranging — wide stop-loss, wait for breakout, minimal position",
    strategy: {
      ma: { short: 44, long: 200 },
      rsi: { period: 19, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 8.9,
      take_profit_percent: 20,
      position_ratio: 0.13,
    },
    allowShort: false,
  },

  ranging_wide: {
    description: "High volatility ranging — quick in/out, mean reversion",
    strategy: {
      ma: { short: 48, long: 55 },         // Short/long MA converge -> don't rely on MA trend
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4.5,
      take_profit_percent: 8.2,             // Small take-profit, quick exit
      position_ratio: 0.25,
    },
    signals: {
      buy: ["rsi_oversold", "macd_bullish"],  // Mean reversion: buy oversold
      sell: ["rsi_overbought"],                // Sell overbought
    },
    allowShort: false,
  },

  breakout_up: {
    description: "Upward breakout — wait for confirmation, small exploratory position",
    strategy: {
      ma: { short: 20, long: 60 },
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4,
      take_profit_percent: 15,
      position_ratio: 0.1,     // Breakout unconfirmed, minimal position
    },
    allowShort: false,
  },

  breakout_down: {
    description: "Downward breakout — wait for confirmation, no opening for now",
    strategy: {
      ma: { short: 20, long: 60 },
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4,
      take_profit_percent: 15,
      position_ratio: 0.05,    // Almost no position
    },
    allowShort: false,          // Wait for confirmation, then switch to trending_bear to short
  },
};

// ── Apply Regime Parameters to Config ────────────────

/**
 * Override base config with regime parameters, return new config
 * Does not modify the original config object
 */
export function applyRegimeParams(
  baseCfg: StrategyConfig,
  regime: MarketRegime,
): StrategyConfig {
  const rp = REGIME_PARAMS[regime];

  const newCfg: StrategyConfig = {
    ...baseCfg,
    strategy: {
      ...baseCfg.strategy,
      ma: { ...rp.strategy.ma },
      rsi: {
        ...baseCfg.strategy.rsi,
        ...rp.strategy.rsi,
      },
    },
    risk: {
      ...baseCfg.risk,
      ...rp.risk,
      // trailing_stop needs deep merge
      trailing_stop: rp.risk.trailing_stop
        ? { ...baseCfg.risk.trailing_stop, ...rp.risk.trailing_stop }
        : baseCfg.risk.trailing_stop,
    },
    signals: rp.signals
      ? {
          buy: rp.signals.buy ?? baseCfg.signals.buy,
          sell: rp.signals.sell ?? baseCfg.signals.sell,
          ...(rp.signals.short ? { short: rp.signals.short } : baseCfg.signals.short ? { short: baseCfg.signals.short } : {}),
          ...(rp.signals.cover ? { cover: rp.signals.cover } : baseCfg.signals.cover ? { cover: baseCfg.signals.cover } : {}),
        }
      : baseCfg.signals,
  };

  return newCfg;
}

/**
 * Get description of current regime parameters (for logging/notifications)
 */
export function describeRegimeParams(regime: MarketRegime): string {
  const rp = REGIME_PARAMS[regime];
  const parts = [
    `[${rp.description}]`,
    `MA ${rp.strategy.ma.short}/${rp.strategy.ma.long}`,
    `RSI ${rp.strategy.rsi.period}`,
    `SL ${rp.risk.stop_loss_percent ?? "?"}%`,
    `TP ${rp.risk.take_profit_percent ?? "?"}%`,
    `Position ${((rp.risk.position_ratio ?? 0.2) * 100).toFixed(0)}%`,
  ];
  if (rp.allowShort) parts.push("🔻 Shorting enabled");
  return parts.join(" | ");
}

/**
 * Regime 自适应参数切换
 *
 * 根据 classifyRegime() 的结果，自动切换到该市场阶段的最优参数组。
 * 参数来源：cycle-analysis 分段回测 + hyperopt 优化结果。
 *
 * 设计原则：
 *   - 牛市：激进做多（紧止损，大止盈，大仓位）
 *   - 震荡市：快进快出（小止盈，中等仓位）+ 均值回归
 *   - 熊市：做空为主 / 极度保守做多 + 小仓位
 *   - 突破：等待确认，不开仓
 */

import type { StrategyConfig, RiskConfig } from "../types.js";
import type { MarketRegime } from "./regime.js";

// ── 分阶段最优参数（来自 cycle-analysis hyperopt 结果）────

export interface RegimeParams {
  /** 策略指标参数覆盖 */
  strategy: {
    ma: { short: number; long: number };
    rsi: { period: number; overbought: number; oversold: number };
  };
  /** 风控参数覆盖 */
  risk: Partial<RiskConfig>;
  /** 信号条件覆盖（可选） */
  signals?: {
    buy?: string[];
    sell?: string[];
    short?: string[];
    cover?: string[];
  };
  /** 是否允许做空 */
  allowShort: boolean;
  /** 描述 */
  description: string;
}

/**
 * 各 regime 对应的参数组
 *
 * 数据来源：cycle-analysis 6 阶段 hyperopt 结果的归纳
 * - trending_bull ← 牛市启动阶段最优
 * - trending_bear ← 熊市初期最优 + 启用做空
 * - ranging_tight ← 谷底积累阶段最优（宽止损等突破）
 * - ranging_wide ← 高位震荡阶段最优（快进快出）
 * - breakout_up/down ← 突破阶段，保守等确认
 */
export const REGIME_PARAMS: Record<MarketRegime, RegimeParams> = {
  trending_bull: {
    description: "牛市趋势 — 激进做多，紧止损大止盈",
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
    description: "熊市趋势 — 做空为主，保守做多",
    strategy: {
      ma: { short: 10, long: 65 },
      rsi: { period: 14, overbought: 60, oversold: 25 },
    },
    risk: {
      stop_loss_percent: 3.7,
      take_profit_percent: 11,
      position_ratio: 0.15,        // 熊市仓位减半
    },
    signals: {
      short: ["ma_bearish", "macd_bearish", "rsi_not_oversold"],
      cover: ["ma_bullish"],
    },
    allowShort: true,
  },

  ranging_tight: {
    description: "低波动震荡 — 宽止损等突破，极小仓位",
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
    description: "高波动震荡 — 快进快出，均值回归",
    strategy: {
      ma: { short: 48, long: 55 },         // 短长均线趋近 → 不靠 MA 趋势
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4.5,
      take_profit_percent: 8.2,             // 小止盈快出
      position_ratio: 0.25,
    },
    signals: {
      buy: ["rsi_oversold", "macd_bullish"],  // 均值回归：超卖买
      sell: ["rsi_overbought"],                // 超买卖
    },
    allowShort: false,
  },

  breakout_up: {
    description: "向上突破 — 等确认，小仓位试探",
    strategy: {
      ma: { short: 20, long: 60 },
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4,
      take_profit_percent: 15,
      position_ratio: 0.1,     // 突破未确认，极小仓位
    },
    allowShort: false,
  },

  breakout_down: {
    description: "向下突破 — 等确认，暂不开仓",
    strategy: {
      ma: { short: 20, long: 60 },
      rsi: { period: 14, overbought: 70, oversold: 30 },
    },
    risk: {
      stop_loss_percent: 4,
      take_profit_percent: 15,
      position_ratio: 0.05,    // 几乎不开仓
    },
    allowShort: false,          // 等确认后切到 trending_bear 再做空
  },
};

// ── 应用 Regime 参数到配置 ───────────────────────────

/**
 * 将 regime 参数覆盖到基础配置，返回新配置
 * 不修改原始配置对象
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
      // trailing_stop 需要深合并
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
 * 获取当前 regime 的参数描述（用于日志/通知）
 */
export function describeRegimeParams(regime: MarketRegime): string {
  const rp = REGIME_PARAMS[regime];
  const parts = [
    `[${rp.description}]`,
    `MA ${rp.strategy.ma.short}/${rp.strategy.ma.long}`,
    `RSI ${rp.strategy.rsi.period}`,
    `SL ${rp.risk.stop_loss_percent ?? "?"}%`,
    `TP ${rp.risk.take_profit_percent ?? "?"}%`,
    `仓位 ${((rp.risk.position_ratio ?? 0.2) * 100).toFixed(0)}%`,
  ];
  if (rp.allowShort) parts.push("🔻 做空已启用");
  return parts.join(" | ");
}

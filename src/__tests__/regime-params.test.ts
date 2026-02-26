/**
 * Regime 自适应参数切换测试
 */
import { describe, it, expect } from "vitest";
import {
  REGIME_PARAMS,
  applyRegimeParams,
  describeRegimeParams,
} from "../strategy/regime-params.js";
import type { MarketRegime } from "../strategy/regime.js";
import type { StrategyConfig } from "../types.js";

function makeBaseCfg(): StrategyConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 30, overbought: 65 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
    },
    signals: {
      buy: ["ma_bullish", "macd_bullish", "rsi_not_overbought"],
      sell: ["ma_bearish"],
    },
    risk: {
      min_rr: 0,
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.3,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 8,
      correlation_filter: { enabled: false, threshold: 0.75, lookback: 60 },
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: false, on_trade: false, on_stop_loss: false,
      on_take_profit: false, on_error: false, on_daily_summary: false,
      min_interval_minutes: 30,
    },
    news: { enabled: false, interval_hours: 4, price_alert_threshold: 5, fear_greed_alert: 15 },
    mode: "paper",
  } as StrategyConfig;
}

describe("REGIME_PARAMS", () => {
  it("所有 6 个 regime 都有参数定义", () => {
    const regimes: MarketRegime[] = [
      "trending_bull", "trending_bear", "ranging_tight",
      "ranging_wide", "breakout_up", "breakout_down",
    ];
    for (const r of regimes) {
      expect(REGIME_PARAMS[r]).toBeDefined();
      expect(REGIME_PARAMS[r].description).toBeTruthy();
    }
  });

  it("trending_bear 允许做空", () => {
    expect(REGIME_PARAMS.trending_bear.allowShort).toBe(true);
    expect(REGIME_PARAMS.trending_bear.signals?.short).toBeDefined();
  });

  it("trending_bull 不允许做空", () => {
    expect(REGIME_PARAMS.trending_bull.allowShort).toBe(false);
  });

  it("牛市仓位 > 熊市仓位", () => {
    const bull = REGIME_PARAMS.trending_bull.risk.position_ratio ?? 0;
    const bear = REGIME_PARAMS.trending_bear.risk.position_ratio ?? 0;
    expect(bull).toBeGreaterThan(bear);
  });

  it("震荡市止盈 < 趋势市止盈", () => {
    const rangingTP = REGIME_PARAMS.ranging_wide.risk.take_profit_percent ?? 0;
    const bullTP = REGIME_PARAMS.trending_bull.risk.take_profit_percent ?? 0;
    expect(rangingTP).toBeLessThan(bullTP);
  });
});

describe("applyRegimeParams", () => {
  it("牛市参数覆盖 MA 和 SL/TP", () => {
    const base = makeBaseCfg();
    const result = applyRegimeParams(base, "trending_bull");

    expect(result.strategy.ma.short).toBe(26);
    expect(result.strategy.ma.long).toBe(90);
    expect(result.risk.stop_loss_percent).toBe(3.2);
    expect(result.risk.take_profit_percent).toBe(23);
    expect(result.risk.position_ratio).toBe(0.28);
  });

  it("熊市覆盖信号条件（加入做空）", () => {
    const base = makeBaseCfg();
    const result = applyRegimeParams(base, "trending_bear");

    expect(result.signals.short).toBeDefined();
    expect(result.signals.short).toContain("ma_bearish");
    expect(result.signals.cover).toContain("ma_bullish");
  });

  it("不修改原始配置", () => {
    const base = makeBaseCfg();
    const originalMA = base.strategy.ma.short;
    applyRegimeParams(base, "trending_bull");
    expect(base.strategy.ma.short).toBe(originalMA);
  });

  it("保留未覆盖的字段", () => {
    const base = makeBaseCfg();
    const result = applyRegimeParams(base, "trending_bull");

    // 未被 regime 覆盖的字段保持不变
    expect(result.risk.max_positions).toBe(4);
    expect(result.risk.max_total_loss_percent).toBe(20);
    expect(result.strategy.macd.fast).toBe(12);
  });

  it("ranging_wide 使用均值回归信号", () => {
    const base = makeBaseCfg();
    const result = applyRegimeParams(base, "ranging_wide");

    expect(result.signals.buy).toContain("rsi_oversold");
    expect(result.signals.sell).toContain("rsi_overbought");
  });
});

describe("describeRegimeParams", () => {
  it("牛市描述包含关键信息", () => {
    const desc = describeRegimeParams("trending_bull");
    expect(desc).toContain("牛市");
    expect(desc).toContain("MA 26/90");
    expect(desc).toContain("SL 3.2%");
  });

  it("熊市描述包含做空标记", () => {
    const desc = describeRegimeParams("trending_bear");
    expect(desc).toContain("做空已启用");
  });
});

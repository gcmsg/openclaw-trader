/**
 * 趋势突破策略插件（F4）
 *
 * 逻辑：
 *   收盘价 > 过去 N 根 K 线最高点 + 成交量 > 均量 × volumeMultiplier → buy
 *   收盘价 < 过去 N 根 K 线最低点 → sell
 *   其他 → none
 *
 * 适用场景：趋势突破行情（Trending Regime）
 * 参数：
 *   lookback: number（默认 20，回望 K 线数量，不含当前）
 *   volumeMultiplier: number（默认 1.5，量能确认倍数）
 *
 * 使用方式（paper.yaml scenario 级别）：
 *   strategy_plugin_id: "breakout"
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";

/** 默认回望窗口（根 K 线，不含当前） */
const DEFAULT_LOOKBACK = 20;

/** 默认量能放大倍数 */
const DEFAULT_VOLUME_MULTIPLIER = 1.5;

const breakoutStrategy: Strategy = {
  id: "breakout",
  name: "趋势突破",
  description:
    "收盘价突破过去 N 根 K 线最高点 + 量能放大 → buy；跌破最低点 → sell。适合趋势行情。",

  populateSignal(ctx: StrategyContext): SignalType {
    const { klines, indicators } = ctx;

    const lookback = DEFAULT_LOOKBACK;
    const volumeMultiplier = DEFAULT_VOLUME_MULTIPLIER;

    // 需要足够的历史数据（至少 lookback + 1 根）
    if (klines.length < lookback + 1) {
      return "none";
    }

    // 过去 N 根 K 线（不含当前最后一根）
    const window = klines.slice(-(lookback + 1), -1);
    const currentKline = klines[klines.length - 1]!;

    const currentClose = currentKline.close;
    const currentVolume = currentKline.volume;

    // 计算窗口内最高收盘价 / 最低收盘价
    let windowHigh = -Infinity;
    let windowLow = Infinity;
    let windowAvgVolume = 0;

    for (const k of window) {
      if (k.close > windowHigh) windowHigh = k.close;
      if (k.close < windowLow) windowLow = k.close;
      windowAvgVolume += k.volume;
    }
    windowAvgVolume = windowAvgVolume / window.length;

    // 突破上轨 + 量能确认 → 买入
    if (currentClose > windowHigh && windowAvgVolume > 0 && currentVolume >= windowAvgVolume * volumeMultiplier) {
      return "buy";
    }

    // 跌破下轨 → 卖出
    if (currentClose < windowLow) {
      return "sell";
    }

    // 也可通过 indicators.avgVolume 来获取量能（与上方窗口计算互为补充）
    // 此处优先使用窗口内均量，保证突破判断与量能口径一致
    void indicators; // 避免 unused 警告（可在未来扩展时使用）

    return "none";
  },
};

// 自动注册（import 时触发）
registerStrategy(breakoutStrategy);

export { breakoutStrategy };

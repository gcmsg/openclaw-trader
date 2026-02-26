/**
 * MTF（多时间框架）趋势过滤
 *
 * 统一供 monitor.ts 和 live-monitor.ts 调用，避免代码重复。
 * 审计发现 A-001 修复。
 */

import { getKlines } from "../exchange/binance.js";
import { calculateIndicators } from "./indicators.js";
import type { DataProvider } from "../exchange/data-provider.js";
import type { RuntimeConfig, SignalType } from "../types.js";

export interface MtfResult {
  /** 大趋势是否为多头（null = 未启用或获取失败） */
  trendBull: boolean | null;
  /** 信号是否被 MTF 过滤 */
  filtered: boolean;
  /** 过滤原因 */
  reason?: string;
}

/**
 * 检查 MTF 趋势过滤
 *
 * @param symbol    交易标的
 * @param signalType 当前信号类型（buy/short 才需过滤）
 * @param cfg       运行时配置
 * @param provider  DataProvider（可选，用于缓存）
 * @returns MTF 检查结果
 */
export async function checkMtfFilter(
  symbol: string,
  signalType: SignalType,
  cfg: RuntimeConfig,
  provider?: DataProvider,
): Promise<MtfResult> {
  // 非开仓信号不需要 MTF 过滤
  if (signalType !== "buy" && signalType !== "short") {
    return { trendBull: null, filtered: false };
  }

  // 未配置 MTF
  if (!cfg.trend_timeframe || cfg.trend_timeframe === cfg.timeframe) {
    return { trendBull: null, filtered: false };
  }

  try {
    const trendLimit = cfg.strategy.ma.long + 10;
    const trendKlines = provider?.get(symbol, cfg.trend_timeframe)
      ?? await getKlines(symbol, cfg.trend_timeframe, trendLimit);
    const trendInd = calculateIndicators(
      trendKlines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd,
    );

    if (!trendInd) {
      return { trendBull: null, filtered: false };
    }

    const trendBull = trendInd.maShort > trendInd.maLong;

    // 买入需要多头，做空需要空头
    if (signalType === "buy" && !trendBull) {
      return {
        trendBull,
        filtered: true,
        reason: `MTF(${cfg.trend_timeframe}) 空头，忽略买入`,
      };
    }
    if (signalType === "short" && trendBull) {
      return {
        trendBull,
        filtered: true,
        reason: `MTF(${cfg.trend_timeframe}) 多头，忽略开空`,
      };
    }

    return { trendBull, filtered: false };
  } catch (err: unknown) {
    return { trendBull: null, filtered: false, reason: `MTF 获取失败: ${String(err)}` };
  }
}

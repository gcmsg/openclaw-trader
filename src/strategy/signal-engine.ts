/**
 * 统一信号引擎（F3）
 *
 * 将 monitor.ts 和 backtest/runner.ts 的核心信号处理逻辑抽取为共享模块：
 *   calculateIndicators → detectSignal → regime → R:R → correlation → protections
 *
 * 实时模式 (monitor.ts)：传入 CVD / 资金费率 / BTC 主导率 / heldKlinesMap
 * 回测模式 (runner.ts)：只传 heldKlinesMap，不传实时外部数据
 */

import type { Kline, StrategyConfig, Signal, Indicators, RiskConfig } from "../types.js";
import { calculateIndicators } from "./indicators.js";
import { detectSignal } from "./signals.js";
import { classifyRegime } from "./regime.js";
import { checkRiskReward } from "./rr-filter.js";
import { checkCorrelation } from "./correlation.js";
import { checkProtections } from "./protection-manager.js";
import type { TradeRecord } from "./protection-manager.js";

// ── F4 Strategy Plugin 支持 ──────────────────────────
// 副作用 import：注册所有内置策略（default / rsi-reversal / breakout）
import "../strategies/index.js";
import { getStrategy } from "../strategies/registry.js";
import type { StrategyContext } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface ExternalContext {
  /** 累计成交量差值（实时模式注入） */
  cvd?: number;
  /** 资金费率百分比（实时模式注入） */
  fundingRate?: number;
  /** BTC 主导率百分比（实时模式注入） */
  btcDominance?: number;
  /** BTC 主导率 7 日变化量（实时模式注入） */
  btcDomChange?: number;
  /** 当前持仓方向（用于 detectSignal 优先级判断） */
  currentPosSide?: "long" | "short";
  /** 已持仓各 symbol 的 K 线（用于相关性检查）*/
  heldKlinesMap?: Record<string, Kline[]>;
}

export interface SignalEngineResult {
  /** 指标计算结果（null = 数据不足，直接跳过）*/
  indicators: Indicators | null;
  /** 信号（type="none" = 无信号）*/
  signal: Signal;
  /** 有效仓位比例（相关性调整后，若有则覆盖 cfg.risk.position_ratio）*/
  effectivePositionRatio?: number;
  /** 有效 risk 配置（合并 regime 参数覆盖）*/
  effectiveRisk: RiskConfig;
  /** 是否被过滤（regime/R:R/protection 拒绝）*/
  rejected: boolean;
  /** 拒绝原因（rejected=true 时有值）*/
  rejectionReason?: string;
  /** Regime 标签（buy/short 信号才有值）*/
  regimeLabel?: string;
}

// ─────────────────────────────────────────────────────
// 核心函数
// ─────────────────────────────────────────────────────

/**
 * 处理单个 symbol 的完整信号流水线
 *
 * @param symbol        交易标的
 * @param klines        该 symbol 的历史 K 线（足够计算指标）
 * @param cfg           运行时配置（已合并策略 + 场景）
 * @param external      外部实时上下文（可选）
 * @param recentTrades  近期平仓记录（用于 ProtectionManager，可选）
 */
export function processSignal(
  symbol: string,
  klines: Kline[],
  cfg: StrategyConfig,
  external: ExternalContext = {},
  recentTrades?: TradeRecord[]
): SignalEngineResult {
  // ── 空信号占位（用于失败时返回）──────────────────────
  const emptyIndicators: Indicators = {
    maShort: 0, maLong: 0, rsi: 0, price: 0, volume: 0, avgVolume: 0,
  };
  const noneSignal: Signal = {
    symbol, type: "none", price: 0, indicators: emptyIndicators, reason: [], timestamp: Date.now(),
  };

  // ── 1. 计算指标 ───────────────────────────────────────
  const indicators = calculateIndicators(
    klines,
    cfg.strategy.ma.short,
    cfg.strategy.ma.long,
    cfg.strategy.rsi.period,
    cfg.strategy.macd
  );

  if (!indicators) {
    return {
      indicators: null,
      signal: noneSignal,
      effectiveRisk: cfg.risk,
      rejected: true,
      rejectionReason: "指标计算失败（数据不足）",
    };
  }

  // ── 2. 注入外部上下文到 indicators ───────────────────
  if (external.cvd !== undefined) indicators.cvd = external.cvd;
  if (external.fundingRate !== undefined) indicators.fundingRate = external.fundingRate;
  if (external.btcDominance !== undefined) indicators.btcDominance = external.btcDominance;
  if (external.btcDomChange !== undefined) indicators.btcDomChange = external.btcDomChange;

  // ── 3. 信号检测 ───────────────────────────────────────
  //
  // F4 Strategy Plugin 支持：
  //   strategy_id === "default" 或未配置 → 走现有 detectSignal 逻辑（完全不变）
  //   strategy_id 为其他值 → 从注册中心获取插件，调用 populateSignal()
  const strategyId = cfg.strategy_id ?? "default";

  let signal: Signal;

  if (strategyId !== "default") {
    // ── 策略插件路径 ─────────────────────────────────
    const plugin = getStrategy(strategyId);
    const ctx: StrategyContext = {
      klines,
      cfg,
      indicators,
      ...(external.currentPosSide !== undefined ? { currentPosSide: external.currentPosSide } : {}),
    };
    const signalType = plugin.populateSignal(ctx);
    signal = {
      symbol,
      type: signalType,
      price: indicators.price,
      indicators,
      reason: [`strategy:${strategyId}`],
      timestamp: Date.now(),
    };
  } else {
    // ── 默认路径（现有逻辑，完全不变）──────────────
    signal = detectSignal(symbol, indicators, cfg, external.currentPosSide);
  }

  if (signal.type === "none" || signal.type === "sell" || signal.type === "cover") {
    // 平仓信号和无信号直接放行，不做额外过滤
    return {
      indicators,
      signal,
      effectiveRisk: cfg.risk,
      rejected: false,
    };
  }

  // ── 以下仅对 buy / short 开仓信号执行过滤 ────────────

  let effectiveRisk: RiskConfig = cfg.risk;
  let effectivePositionRatio: number | undefined;
  let regimeLabel: string | undefined;

  // ── 4a. Regime 感知过滤 ────────────────────────────────
  const regime = classifyRegime(klines);
  if (regime.confidence >= 60) {
    regimeLabel = regime.label;

    if (regime.signalFilter === "breakout_watch") {
      return {
        indicators,
        signal,
        effectiveRisk,
        rejected: true,
        rejectionReason: `Regime 过滤 [${regime.label}] ${regime.detail}`,
        regimeLabel,
      };
    }

    if (regime.signalFilter === "reduced_size") {
      effectivePositionRatio = cfg.risk.position_ratio * 0.5;
    }

    // 合并 regime_overrides
    const override = cfg.regime_overrides?.[regime.signalFilter];
    if (override) {
      effectiveRisk = { ...cfg.risk, ...override };
    }
  }

  // ── 4b. R:R 过滤（仅当 effectiveRisk.min_rr > 0）─────
  if ((effectiveRisk.min_rr ?? 0) > 0) {
    const minRr = effectiveRisk.min_rr ?? 1.5;
    const rrResult = checkRiskReward(
      klines,
      indicators.price,
      signal.type === "short" ? "short" : "long",
      minRr
    );
    if (!rrResult.passed) {
      return buildResult(indicators, signal, effectiveRisk, true, `R:R 过滤 — ${rrResult.reason}`, regimeLabel, effectivePositionRatio);
    }
  }

  // ── 4c. 相关性过滤（有 heldKlinesMap 时执行）────────
  const heldKlinesMap = external.heldKlinesMap;
  if (cfg.risk.correlation_filter?.enabled && heldKlinesMap) {
    const heldKeys = Object.keys(heldKlinesMap).filter((s) => s !== symbol);
    if (heldKeys.length > 0) {
      const corrCfg = cfg.risk.correlation_filter;
      const heldMap = new Map<string, Kline[]>();
      for (const s of heldKeys) {
        const k = heldKlinesMap[s];
        if (k) heldMap.set(s, k);
      }
      const corrResult = checkCorrelation(symbol, klines, heldMap, corrCfg.threshold);
      if (corrResult.correlated) {
        // 高相关：缩减仓位 50%（连续缩减，不直接拒绝）
        const baseRatio = effectivePositionRatio ?? effectiveRisk.position_ratio;
        effectivePositionRatio = baseRatio * 0.5;
      }
    }
  }

  // ── 4d. Protection Manager ────────────────────────────
  const protectionCfg = cfg.protections;
  if (protectionCfg && recentTrades && recentTrades.length > 0) {
    const candleIntervalMs = candleMs(cfg.timeframe);
    const protResult = checkProtections(symbol, protectionCfg, recentTrades, candleIntervalMs);
    if (!protResult.allowed) {
      return buildResult(indicators, signal, effectiveRisk, true, `Protection 过滤 — ${protResult.reason ?? "protection triggered"}`, regimeLabel, effectivePositionRatio);
    }
  }

  return buildResult(indicators, signal, effectiveRisk, false, undefined, regimeLabel, effectivePositionRatio);
}

// ─────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────

/** 构建 SignalEngineResult，正确处理 exactOptionalPropertyTypes */
function buildResult(
  indicators: Indicators,
  signal: Signal,
  effectiveRisk: RiskConfig,
  rejected: boolean,
  rejectionReason: string | undefined,
  regimeLabel: string | undefined,
  effectivePositionRatio: number | undefined
): SignalEngineResult {
  const base: SignalEngineResult = { indicators, signal, effectiveRisk, rejected };
  if (rejectionReason !== undefined) base.rejectionReason = rejectionReason;
  if (regimeLabel !== undefined) base.regimeLabel = regimeLabel;
  if (effectivePositionRatio !== undefined) base.effectivePositionRatio = effectivePositionRatio;
  return base;
}

/** 将 Timeframe 字符串转换为毫秒 */
export function candleMs(timeframe: string): number {
  const map: Record<string, number> = {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  };
  return map[timeframe] ?? 60 * 60_000; // 默认 1h
}

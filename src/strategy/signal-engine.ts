/**
 * 统一信号引擎（F3）
 *
 * 将 monitor.ts 和 backtest/runner.ts 的核心信号处理逻辑抽取为共享模块：
 *   calculateIndicators → regime（P5.3 前置） → detectSignal → R:R → correlation → protections
 *
 * 实时模式 (monitor.ts)：传入 CVD / 资金费率 / BTC 主导率 / heldKlinesMap
 * 回测模式 (runner.ts)：只传 heldKlinesMap，不传实时外部数据
 *
 * P5.3 Regime 感知信号过滤（已前置到 detectSignal 之前）：
 *   trend_signals_only     → 过滤掉 RSI 反转类条件，只保留 MA/MACD/CVD 趋势条件
 *   reversal_signals_only  → 过滤掉 MA/MACD 趋势类条件，只保留 RSI/价格极值反转条件
 *   breakout_watch         → 直接拒绝所有信号（等待突破确认）
 *   reduced_size           → 允许所有信号，但仓位减半
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
// Regime 信号条件分类（P5.3）
// ─────────────────────────────────────────────────────

/**
 * 趋势类信号条件（trend_signals_only 时保留）
 *   这些条件依赖价格动量/方向，在趋势市有效，在震荡市会产生大量假信号
 */
const TREND_CONDITIONS = new Set([
  "ma_bullish",
  "ma_bearish",
  "macd_bullish",
  "macd_bearish",
  "cvd_bullish",
  "cvd_bearish",
  "volume_spike",
  // RSI 守卫条件：防止在超买超卖区域开趋势仓（趋势市仍然有用）
  "rsi_not_overbought",
  "rsi_not_oversold",
  // 资金费率条件：成本管控，趋势市适用
  "funding_rate_overlong",
  "funding_rate_overshort",
]);

/**
 * 反转类信号条件（reversal_signals_only 时保留）
 *   这些条件依赖价格极值/均值回归，在震荡市有效，在趋势市会逆势操作
 */
const REVERSAL_CONDITIONS = new Set([
  "rsi_oversold",
  "rsi_overbought",
  "rsi_bullish_zone",
  "rsi_not_overbought",
  "rsi_not_oversold",
  "rsi_overbought_exit",
  "rsi_oversold_exit",
  // 资金费率：也是反转触发器（资金费率极端 → 拥挤交易反转）
  "funding_rate_overlong",
  "funding_rate_overshort",
  // CVD：也可用于反转判断（卖压/买压极值）
  "cvd_bullish",
  "cvd_bearish",
]);

type SignalConditionSet = StrategyConfig["signals"];

/**
 * 根据 signalFilter 过滤信号条件集。
 *
 * - trend_signals_only：只保留 TREND_CONDITIONS 中的条件
 * - reversal_signals_only：只保留 REVERSAL_CONDITIONS 中的条件
 * - 其他：保持原样（返回原对象）
 *
 * 如果 cfg 配置了 regime_strategies[signalFilter]，则 YAML 显式覆盖优先。
 */
function applyRegimeSignalFilter(
  cfg: StrategyConfig,
  signalFilter: string
): SignalConditionSet {
  // YAML 显式覆盖优先（regime_strategies 配置了就直接用）
  const explicit = cfg.regime_strategies?.[signalFilter];
  if (explicit) {
    return explicit.signals;
  }

  // 自动分类过滤（auto-categorization）
  const filterFn = (keep: Set<string>) =>
    (conditions: string[]): string[] => conditions.filter((c) => keep.has(c));

  if (signalFilter === "trend_signals_only") {
    const f = filterFn(TREND_CONDITIONS);
    return {
      buy: f(cfg.signals.buy),
      sell: f(cfg.signals.sell),
      short: cfg.signals.short ? f(cfg.signals.short) : [],
      cover: cfg.signals.cover ? f(cfg.signals.cover) : [],
    };
  }

  if (signalFilter === "reversal_signals_only") {
    const f = filterFn(REVERSAL_CONDITIONS);
    return {
      buy: f(cfg.signals.buy),
      sell: f(cfg.signals.sell),
      short: cfg.signals.short ? f(cfg.signals.short) : [],
      cover: cfg.signals.cover ? f(cfg.signals.cover) : [],
    };
  }

  // all / reduced_size → 原样返回
  return cfg.signals;
}

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
  /**
   * BTC 期权 PCR（Put/Call Ratio），由 derivatives-data 获取
   * > 1.5 = 极度看空（市场恐惧），可用作反转买入信号
   * < 0.5 = 极度看涨（市场贪婪），可用作反转卖出信号
   */
  putCallRatio?: number;
  /**
   * 链上稳定币流量信号，由 onchain-data 计算
   * accumulation = 净流入交易所（潜在买压） → 偏多
   * distribution = 净流出交易所（潜在卖压）  → 偏空
   * neutral = 无明显方向
   */
  stablecoinSignal?: "accumulation" | "distribution" | "neutral";
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
  if (external.putCallRatio !== undefined) indicators.putCallRatio = external.putCallRatio;
  if (external.stablecoinSignal !== undefined) indicators.stablecoinSignal = external.stablecoinSignal;

  // ── 2b. Regime 前置分类（P5.3）─────────────────────────
  //
  // 前置目的：让 regime.signalFilter 能在信号检测（步骤 3）之前过滤信号条件集。
  // 以前 regime 在步骤 4 才检测，只能影响 risk 参数，无法过滤信号条件 —— 这是 Bug。
  //
  // 激活条件（保持向后兼容）：
  //   cfg.regime_strategies 有显式映射 → 激活信号条件过滤
  //   未配置时：regime 只影响 risk 参数（旧行为），不过滤信号条件。
  //   （如需自动分类过滤，在 YAML 中配置 regime_strategies 任意一条即可）
  const regime = classifyRegime(klines);
  const regimeSigFilterEnabled =
    cfg.regime_strategies !== undefined && Object.keys(cfg.regime_strategies).length > 0;
  const effectiveSignals =
    regimeSigFilterEnabled && regime.confidence >= 60
      ? applyRegimeSignalFilter(cfg, regime.signalFilter)
      : cfg.signals;
  // 把过滤后的信号条件合并成新 cfg（只影响 signals 字段，其余不变）
  const cfgWithRegimeSignals: StrategyConfig =
    effectiveSignals !== cfg.signals
      ? { ...cfg, signals: effectiveSignals }
      : cfg;

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
      cfg: cfgWithRegimeSignals,   // 传入 regime 过滤后的信号条件
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
    signal = detectSignal(symbol, indicators, cfgWithRegimeSignals, external.currentPosSide);
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

  // ── 4a. Regime 感知过滤 ─────────────────────────────────
  // regime 已在步骤 2b 前置计算，此处直接复用（无需重复调用 classifyRegime）
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

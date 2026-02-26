// ─────────────────────────────────────────────────────
// Global Types for openclaw-trader
// ─────────────────────────────────────────────────────
import type { ProtectionConfig } from "./strategy/protection-manager.js";

export type SignalType = "buy" | "sell" | "short" | "cover" | "none";
export type PositionSide = "long" | "short";
export type TradeMode = "notify_only" | "paper" | "testnet" | "live" | "auto";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type MarketType = "spot" | "margin" | "futures";
export type ContractType = "perpetual" | "quarterly";
export type MarginMode = "isolated" | "cross";
export type OrderType = "market" | "limit";

// ─────────────────────────────────────────────────────
// Market / Candle Data
// ─────────────────────────────────────────────────────

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
  prevMacd?: number;
  prevSignal?: number;
  prevHistogram?: number;
  prevPrevHistogram?: number; // 第 -3 根柱，用于三根连续收缩检测
}

export interface Indicators {
  maShort: number;
  maLong: number;
  rsi: number;
  price: number;
  volume: number;
  avgVolume: number;
  prevMaShort?: number;
  prevMaLong?: number;
  macd?: MacdResult;
  atr?: number;  // ATR（平均真实波幅），用于动态仓位和止损距离计算
  cvd?: number;         // 累计成交量差值（K 线近似：收>开=买盘，收<开=卖盘；正=净买压）
  fundingRate?: number; // 当前资金费率百分比（如 +0.03 = +0.03%/8h，仅期货市场有效）
  // VWAP 成交量加权均价（日内，按自然日重置）
  vwap?: number;        // VWAP 主线
  vwapUpper1?: number;  // VWAP + 1σ（一阶偏差带上沿）
  vwapLower1?: number;  // VWAP - 1σ
  vwapUpper2?: number;  // VWAP + 2σ（二阶偏差带上沿）
  vwapLower2?: number;  // VWAP - 2σ
  prevPrice?: number;   // 前一根 K 线收盘价（用于 vwap_bounce 等跨 K 信号）
  btcDominance?: number; // BTC 市值主导率百分比（如 54.3），由 market-analysis 注入
  btcDomChange?: number; // 7 日主导率变化量（正=上升=山寨风险；负=下降=山寨机会）
}

export interface Signal {
  symbol: string;
  type: SignalType;
  price: number;
  indicators: Indicators;
  reason: string[];
  timestamp: number;
}

// ─────────────────────────────────────────────────────
// Shared Config Sections (strategy.yaml)
// ─────────────────────────────────────────────────────

/** 分批止盈的单个档位 */
export interface TakeProfitStage {
  at_percent: number;   // 达到此盈利比例时触发（如 8 = +8%）
  close_ratio: number;  // 平掉仓位的比例（如 0.5 = 平掉 50%）
}

export interface RiskConfig {
  stop_loss_percent: number;
  take_profit_percent: number;
  trailing_stop: {
    enabled: boolean;
    activation_percent: number;
    callback_percent: number;
  };
  position_ratio: number;
  max_positions: number;
  max_position_per_symbol: number;
  max_total_loss_percent: number;
  daily_loss_limit_percent: number;

  // ── ATR 动态仓位（可选，优先于 position_ratio）──
  atr_position?: {
    enabled: boolean;
    risk_per_trade_percent: number; // 每笔最多亏占总资金的比例（如 2 = 2%）
    atr_multiplier: number;         // 止损 = ATR × 此倍数（默认 1.5）
    max_position_ratio: number;     // 仓位上限（防 ATR 极小时过重仓，如 0.3）
  };

  // ── 增强型 Trailing Stop（Freqtrade-inspired，可选）──
  /**
   * trailing_stop_positive: 盈利激活后使用更紧的 trailing 幅度（如 0.02 = 2%）
   * 替代 trailing_stop.callback_percent（仅当盈利超过 trailing_stop_positive_offset 后）
   */
  trailing_stop_positive?: number;
  /**
   * trailing_stop_positive_offset: 盈利超过此值后激活 positive trailing（如 0.02 = 2% 盈利）
   * 默认不配置 = 不使用 positive trailing
   */
  trailing_stop_positive_offset?: number;
  /**
   * trailing_only_offset_is_reached: 仅在 offset 达到后才激活 trailing（true = Freqtrade 默认）
   * false = 立即激活 trailing（不等待 offset）
   */
  trailing_only_offset_is_reached?: boolean;

  // ── 分批止盈（可选，配合 take_profit_percent 使用）──
  take_profit_stages?: TakeProfitStage[];

  // ── 时间止损（可选）──
  time_stop_hours?: number; // 持仓超过 N 小时后若无盈利则强制出场

  // ── 相关性过滤（可选）──
  correlation_filter?: {
    enabled: boolean;
    /** 皮尔逊相关系数阈值，超过此值跳过买入（默认 0.7） */
    threshold: number;
    /** 用于计算相关性的 K 线数量（默认 60） */
    lookback: number;
  };

  // ── 风险/回报比过滤（可选）──
  /** 最低可接受 R:R 比率（默认 1.5，0 = 禁用）
   *  多头：距阻力 / 距支撑 ≥ min_rr
   *  空头：距支撑 / 距阻力 ≥ min_rr */
  min_rr?: number;

  // ── 分批建仓 DCA（可选）──
  dca?: {
    enabled: boolean;
    /** 分几批建仓（默认 3），第一批 = 正常 positionRatio，后续每批相同比例 */
    tranches: number;
    /** 触发下一批的价格下跌百分比（默认 3%） */
    drop_pct: number;
    /** DCA 最长持续时间（小时），超时停止追加（默认 48h） */
    max_hours: number;
  };

  // ── Kelly 动态仓位（可选）──
  /** 仓位计算模式：fixed（默认，使用 position_ratio） | kelly（Kelly 公式动态计算） */
  position_sizing?: "fixed" | "kelly";
  /** Kelly：参考最近 N 笔平仓（默认 30，样本 < 10 退化到 fixed） */
  kelly_lookback?: number;
  /** Kelly：是否使用半 Kelly（默认 true，降低方差） */
  kelly_half?: boolean;
  /** Kelly：仓位下限（默认 0.05 = 5%） */
  kelly_min_ratio?: number;
  /** Kelly：仓位上限（默认 0.40 = 40%） */
  kelly_max_ratio?: number;

  // ── ROI Table 时间衰减止盈（可选，优先于固定 take_profit_percent）──
  /**
   * 持仓时间（分钟）→ 最低盈利比率（0.05 = 5%）的映射表。
   * 规则：找到 key ≤ 当前持仓分钟的最大 key，对应的 value 即为当前止盈目标。
   * 示例：{ "0": 0.08, "60": 0.04, "120": 0.02, "480": 0 }
   * 若不配置则回退到固定 take_profit_percent。
   */
  minimal_roi?: Record<string, number>;
}

export interface ExecutionConfig {
  order_type: OrderType;
  limit_order_offset_percent: number;
  min_order_usdt: number;
  limit_order_timeout_seconds: number;
  /**
   * 入场前价格偏离保护（参考 Freqtrade confirm_trade_entry）。
   * 若当前价格偏离信号价格超过此比率则取消入场（防闪崩误买/误空）。
   * 默认 0（禁用）。建议值：0.005（0.5%）。
   */
  max_entry_slippage?: number;
  /**
   * 订单超时：市价单下单后若 N 秒内 executedQty=0 则视为失败（默认 30s）。
   * 部分成交时按实际成交量记账。
   */
  order_timeout_seconds?: number;
}

export interface NotifyConfig {
  on_signal: boolean;
  on_trade: boolean;
  on_stop_loss: boolean;
  on_take_profit: boolean;
  on_error: boolean;
  on_daily_summary: boolean;
  min_interval_minutes: number;
}

/** strategy.yaml — 纯策略配置，不含交易所/市场信息 */
export interface StrategyConfig {
  symbols: string[];
  timeframe: Timeframe;
  /**
   * F4 Strategy Plugin ID（可选）。
   * 指定使用哪个策略插件（src/strategies/*.ts）。
   * 默认 "default" = 走现有 YAML 条件匹配逻辑（行为完全不变）。
   * 可选值："default" | "rsi-reversal" | "breakout" | 自定义
   */
  strategy_id?: string;
  protections?: ProtectionConfig;
  /** 趋势确认时间框架（可选）。如设置，只有该时间框架 MA 多头时才允许买入。
   *  例：主策略 1h，trend_timeframe: "4h" → 4h MA多头才开 1h 买单。 */
  trend_timeframe?: Timeframe;
  strategy: {
    name: string;
    enabled: boolean;
    ma: { short: number; long: number };
    rsi: { period: number; oversold: number; overbought: number; overbought_exit?: number };
    macd: { enabled: boolean; fast: number; slow: number; signal: number };
    volume?: { surge_ratio: number; low_ratio: number };
    /** 资金费率逆向信号阈值（可选，不配置则使用默认值） */
    funding_rate?: {
      long_threshold?: number;  // 多头极端阈值 %，默认 0.30
      short_threshold?: number; // 空头极端阈值 % (绝对值)，默认 0.15
    };
  };
  signals: {
    buy: string[];
    sell: string[];
    /** 开空条件（仅 futures/margin 市场有效） */
    short?: string[];
    /** 平空条件（仅 futures/margin 市场有效） */
    cover?: string[];
  };
  risk: RiskConfig;
  execution: ExecutionConfig;
  notify: NotifyConfig;
  news: {
    enabled: boolean;
    interval_hours: number;
    price_alert_threshold: number;
    fear_greed_alert: number;
  };
  schedule?: Record<
    string,
    {
      enabled: boolean;
      cron: string;
      timeout_minutes: number;
    }
  >;
  mode: TradeMode;
  /**
   * P5.2 Regime 自适应参数覆盖
   * 当检测到特定市场状态时，自动覆盖对应的 risk 参数。
   * key = SignalFilter（"breakout_watch" | "reduced_size" | "all_clear"）
   * value = Partial<RiskConfig>（仅需列出需要覆盖的字段）
   *
   * 示例（震荡市快进快出）：
   *   regime_overrides:
   *     reduced_size:
   *       take_profit_percent: 5
   *       stop_loss_percent: 1.5
   *       minimal_roi:
   *         "0": 0.03
   *         "30": 0.01
   */
  regime_overrides?: Partial<Record<string, Partial<RiskConfig>>>;
}

// ─────────────────────────────────────────────────────
// Exchange Config (shared between paper scenarios & live)
// ─────────────────────────────────────────────────────

export interface ExchangeConfig {
  name?: string;             // 默认 "binance"
  credentials_path?: string; // API Key/Secret 路径
  testnet?: boolean;         // true = 使用 testapi.binance.vision，false = 生产环境
  market: MarketType;
  futures?: {
    contract_type: ContractType;
    margin_mode: MarginMode;
  };
  leverage?: {
    enabled: boolean;
    default: number;
    max: number;
  };
}

// ─────────────────────────────────────────────────────
// Strategy Profile (config/strategies/*.yaml)
// ─────────────────────────────────────────────────────

export interface StrategyProfile {
  name: string;
  description?: string;
  /**
   * F4 Strategy Plugin ID（可选）。
   * 在策略 profile YAML（config/strategies/*.yaml）中设置，
   * 指定使用哪个策略插件（"rsi-reversal" | "breakout" | 自定义）。
   * 默认不设置 = "default"（YAML 条件匹配）。
   */
  strategy_id?: string;
  symbols?: string[];
  timeframe?: Timeframe;
  trend_timeframe?: Timeframe;
  strategy?: {
    ma?: { short: number; long: number };
    rsi?: { period?: number; oversold?: number; overbought?: number; overbought_exit?: number };
    macd?: { enabled?: boolean; fast?: number; slow?: number; signal?: number };
    volume?: { surge_ratio?: number; low_ratio?: number };
  };
  signals?: {
    buy?: string[];
    sell?: string[];
    short?: string[];
    cover?: string[];
  };
  risk?: Partial<RiskConfig>;
}

// ─────────────────────────────────────────────────────
// Paper Trading Config (paper.yaml)
// ─────────────────────────────────────────────────────

export interface PaperScenario {
  id: string;
  name: string;
  enabled: boolean;
  strategy_id: string; // 引用 config/strategies/{id}.yaml
  initial_usdt: number;
  fee_rate: number;
  slippage_percent: number;
  exchange: ExchangeConfig;
  symbols?: string[]; // 覆盖策略/全局 symbols
  risk?: Partial<RiskConfig>; // 覆盖策略 risk
}

export interface PaperFileConfig {
  report_interval_hours: number;
  scenarios: PaperScenario[];
}

// ─────────────────────────────────────────────────────
// Live Trading Config (live.yaml)
// ─────────────────────────────────────────────────────

export interface LiveConfig {
  exchange: ExchangeConfig & {
    name: string;
    credentials_path: string;
  };
  symbols?: string[];
  risk?: Partial<RiskConfig>;
}

// ─────────────────────────────────────────────────────
// Merged runtime config (strategy.yaml + paper/live scenario)
// ─────────────────────────────────────────────────────

/** monitor.ts 和 engine.ts 实际使用的合并配置 */
export interface RuntimeConfig extends StrategyConfig {
  exchange: ExchangeConfig;
  paper: {
    scenarioId: string;
    initial_usdt: number;
    fee_rate: number;
    slippage_percent: number;
    report_interval_hours: number;
    /** G5: 启用 SQLite 持久化（更换 better-sqlite3 记录开/平仓，config.paper.use_sqlite: true）*/
    use_sqlite?: boolean;
  };
}

// ─────────────────────────────────────────────────────
// Trading Entities
// ─────────────────────────────────────────────────────

export interface Position {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop?: {
    active: boolean;
    highestPrice: number;
    stopPrice: number;
  };
}

export interface TradeResult {
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  orderId: string;
  timestamp: number;
  status: "filled" | "failed";
  fee?: number;
  slippage?: number;
  error?: string | undefined;
}

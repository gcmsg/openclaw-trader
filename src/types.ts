// ─────────────────────────────────────────────────────
// Global Types for openclaw-trader
// ─────────────────────────────────────────────────────

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
  atr?: number; // ATR（平均真实波幅），用于动态仓位和止损距离计算
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
}

export interface ExecutionConfig {
  order_type: OrderType;
  limit_order_offset_percent: number;
  min_order_usdt: number;
  limit_order_timeout_seconds: number;
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

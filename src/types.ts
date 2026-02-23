// ─────────────────────────────────────────────────────
// Global Types for openclaw-trader
// ─────────────────────────────────────────────────────

export type SignalType = "buy" | "sell" | "none";
export type TradeMode = "notify_only" | "paper" | "auto";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type MarketType = "spot" | "margin" | "futures";
export type ContractType = "perpetual" | "quarterly";
export type MarginMode = "isolated" | "cross";
export type OrderType = "market" | "limit";

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
// Config Sections
// ─────────────────────────────────────────────────────

export interface ExchangeConfig {
  name: string;
  credentials_path: string;
  market: MarketType;
  futures: {
    contract_type: ContractType;
    margin_mode: MarginMode;
  };
  leverage: {
    enabled: boolean;
    default: number;
    max: number;
  };
}

export interface RiskConfig {
  stop_loss_percent: number;
  take_profit_percent: number;
  trailing_stop: {
    enabled: boolean;
    activation_percent: number;  // 盈利达到此值后启动追踪
    callback_percent: number;    // 回撤超过此值触发止损
  };
  position_ratio: number;
  max_positions: number;
  max_position_per_symbol: number;
  max_total_loss_percent: number;
  daily_loss_limit_percent: number;
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

export interface PaperConfig {
  initial_usdt: number;
  fee_rate: number;
  slippage_percent: number;
  report_interval_hours: number;
}

export interface StrategyConfig {
  exchange: ExchangeConfig;
  symbols: string[];
  timeframe: Timeframe;
  strategy: {
    name: string;
    enabled: boolean;
    ma: { short: number; long: number };
    rsi: { period: number; oversold: number; overbought: number };
    macd: { enabled: boolean; fast: number; slow: number; signal: number };
    volume?: { surge_ratio: number; low_ratio: number };
  };
  signals: {
    buy: string[];
    sell: string[];
  };
  risk: RiskConfig;
  execution: ExecutionConfig;
  notify: NotifyConfig;
  paper: PaperConfig;
  news: {
    enabled: boolean;
    interval_hours: number;
    price_alert_threshold: number;
    fear_greed_alert: number;
  };
  schedule: {
    [taskName: string]: {
      enabled: boolean;
      cron: string;
      timeout_minutes: number;
    };
  };
  mode: TradeMode;
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
    highestPrice: number;  // 持仓期间最高价（用于追踪止损）
    stopPrice: number;     // 当前追踪止损价
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
  fee?: number;        // 实际手续费（USDT）
  slippage?: number;   // 实际滑点（%）
  error?: string;
}

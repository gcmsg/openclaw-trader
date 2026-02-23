// ─────────────────────────────────────────────────────
// Global Types for openclaw-trader
// ─────────────────────────────────────────────────────

export type SignalType = "buy" | "sell" | "none";
export type TradeMode = "notify_only" | "paper" | "auto";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

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
  macd: number;       // MACD 线（快线 - 慢线）
  signal: number;     // 信号线（MACD 的 EMA）
  histogram: number;  // 柱状图（MACD - Signal）
  prevMacd?: number;
  prevSignal?: number;
  prevHistogram?: number;
}

export interface Indicators {
  maShort: number;
  maLong: number;
  rsi: number;
  price: number;
  volume: number;          // 当前 K 线成交量
  avgVolume: number;       // 近期平均成交量
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

export interface StrategyConfig {
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
  risk: {
    stop_loss_percent: number;      // 单笔止损百分比（如 5 = 5%）
    take_profit_percent: number;    // 单笔止盈百分比
    max_total_loss_percent: number; // 总亏损上限百分比（如 20 = 20%）
    position_ratio: number;         // 单笔仓位比例（如 0.2 = 20%）
  };
  notify: {
    on_signal: boolean;
    on_trade: boolean;
    on_stop_loss: boolean;
    on_error: boolean;
    min_interval_minutes: number;
  };
  paper: {
    initial_usdt: number;
    report_interval_hours: number;
  };
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

export interface Position {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
}

export interface TradeResult {
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  orderId: string;
  timestamp: number;
  status: "filled" | "failed";
  error?: string;
}

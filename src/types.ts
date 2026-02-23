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

export interface Indicators {
  maShort: number;
  maLong: number;
  rsi: number;
  price: number;
  prevMaShort?: number;
  prevMaLong?: number;
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
    initial_usdt: number;           // 模拟盘初始资金
    report_interval_hours: number;  // 定期汇报间隔
  };
  news: {
    enabled: boolean;
    interval_hours: number;
    price_alert_threshold: number;
    fear_greed_alert: number;
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

// ─────────────────────────────────────────────────────
// Global Types for openclaw-trader
// ─────────────────────────────────────────────────────

export type SignalType = "buy" | "sell" | "none";
export type TradeMode = "notify_only" | "auto";
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
    max_loss_per_trade: number;
    max_total_loss: number;
    position_size: number;
    stop_loss: number;
    take_profit: number;
  };
  notify: {
    on_signal: boolean;
    on_trade: boolean;
    on_stop_loss: boolean;
    on_error: boolean;
    min_interval_minutes: number;
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

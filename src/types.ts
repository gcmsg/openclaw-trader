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
  prevPrevHistogram?: number; // Bar -3, used for detecting three consecutive histogram contractions
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
  atr?: number;  // ATR (Average True Range), used for dynamic position sizing and stop-loss distance calculation
  cvd?: number;         // Cumulative Volume Delta (kline approximation: close>open=buy, close<open=sell; positive=net buy pressure)
  fundingRate?: number; // Current funding rate percentage (e.g. +0.03 = +0.03%/8h, only valid for futures markets)
  // VWAP Volume Weighted Average Price (intraday, resets on calendar day)
  vwap?: number;        // VWAP main line
  vwapUpper1?: number;  // VWAP + 1σ (first standard deviation upper band)
  vwapLower1?: number;  // VWAP - 1σ
  vwapUpper2?: number;  // VWAP + 2σ (second standard deviation upper band)
  vwapLower2?: number;  // VWAP - 2σ
  prevPrice?: number;   // Previous kline close price (used for vwap_bounce and other cross-bar signals)
  btcDominance?: number; // BTC market dominance percentage (e.g. 54.3), injected by market-analysis
  btcDomChange?: number; // 7-day dominance change (positive=rising=altcoin risk; negative=falling=altcoin opportunity)
  // ── Derivatives / On-chain data (injected by market-analysis/monitor) ───────────────
  putCallRatio?: number;  // Options PCR (> 1.5 = extreme bearish/reversal buy opportunity, < 0.5 = extreme bullish/reversal sell opportunity)
  /** On-chain stablecoin flow signal */
  stablecoinSignal?: "accumulation" | "distribution" | "neutral";
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
// Ensemble Strategy Config
// ─────────────────────────────────────────────────────

/**
 * Ensemble voting strategy config (used when strategy_id = "ensemble").
 * Reference this interface without importing directly from strategies/ensemble.ts,
 * to avoid circular dependencies; type structure is identical to EnsembleConfig.
 */
export interface EnsembleConfig {
  strategies: {
    id: string;     // Strategy ID (e.g. "default", "rsi-reversal", "breakout")
    weight: number; // Voting weight (0~1), defaults to 1/N each
  }[];
  /** Weighted ratio threshold that majority signals must reach to trigger. Default 0.5 */
  threshold?: number;
  /** Require all strategies to agree before triggering (unanimous mode). Default false */
  unanimous?: boolean;
}

// ─────────────────────────────────────────────────────
// Shared Config Sections (strategy.yaml)
// ─────────────────────────────────────────────────────

/** A single stage for staged take-profit */
export interface TakeProfitStage {
  at_percent: number;   // Trigger when profit reaches this percentage (e.g. 8 = +8%)
  close_ratio: number;  // Ratio of position to close (e.g. 0.5 = close 50%)
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

  // ── ATR dynamic position sizing (optional, takes priority over position_ratio) ──
  atr_position?: {
    enabled: boolean;
    risk_per_trade_percent: number; // Max loss per trade as ratio of total capital (e.g. 2 = 2%)
    atr_multiplier: number;         // Stop-loss = ATR × this multiplier (default 1.5)
    max_position_ratio: number;     // Position cap (prevents over-leveraging when ATR is tiny, e.g. 0.3)
  };

  // ── Enhanced Trailing Stop (Freqtrade-inspired, optional) ──
  /**
   * trailing_stop_positive: Use a tighter trailing distance after profit activation (e.g. 0.02 = 2%)
   * Replaces trailing_stop.callback_percent (only after profit exceeds trailing_stop_positive_offset)
   */
  trailing_stop_positive?: number;
  /**
   * trailing_stop_positive_offset: Activate positive trailing after profit exceeds this value (e.g. 0.02 = 2% profit)
   * Not configured by default = positive trailing disabled
   */
  trailing_stop_positive_offset?: number;
  /**
   * trailing_only_offset_is_reached: Only activate trailing after offset is reached (true = Freqtrade default)
   * false = Activate trailing immediately (don't wait for offset)
   */
  trailing_only_offset_is_reached?: boolean;

  // ── Staged take-profit (optional, works with take_profit_percent) ──
  take_profit_stages?: TakeProfitStage[];

  // ── Time-based stop (optional) ──
  time_stop_hours?: number; // Force exit if position held for N hours without profit

  // ── Correlation filter (optional) ──
  correlation_filter?: {
    enabled: boolean;
    /** Pearson correlation threshold; skip entry if exceeded (default 0.7) */
    threshold: number;
    /** Number of klines used for correlation calculation (default 60) */
    lookback: number;
  };

  // ── Risk/Reward ratio filter (optional) ──
  /** Minimum acceptable R:R ratio (default 1.5, 0 = disabled)
   *  Long: distance to resistance / distance to support >= min_rr
   *  Short: distance to support / distance to resistance >= min_rr */
  min_rr?: number;

  // ── DCA (Dollar Cost Averaging) position building (optional) ──
  dca?: {
    enabled: boolean;
    /** Number of tranches (default 3); first tranche = normal positionRatio, subsequent tranches same ratio */
    tranches: number;
    /** Price drop percentage to trigger next tranche (default 3%) */
    drop_pct: number;
    /** Max DCA duration in hours; stop adding after timeout (default 48h) */
    max_hours: number;
  };

  // ── Kelly dynamic position sizing (optional) ──
  /** Position sizing mode: fixed (default, uses position_ratio) | kelly (Kelly formula dynamic calculation) */
  position_sizing?: "fixed" | "kelly";
  /** Kelly: reference last N closed trades (default 30, falls back to fixed when samples < 10) */
  kelly_lookback?: number;
  /** Kelly: use half-Kelly (default true, reduces variance) */
  kelly_half?: boolean;
  /** Kelly: minimum position ratio (default 0.05 = 5%) */
  kelly_min_ratio?: number;
  /** Kelly: maximum position ratio (default 0.40 = 40%) */
  kelly_max_ratio?: number;

  // ── ROI Table time-decaying take-profit (optional, takes priority over fixed take_profit_percent) ──
  /**
   * Mapping of holding time (minutes) to minimum profit ratio (0.05 = 5%).
   * Rule: find the largest key <= current holding minutes; the corresponding value is the current take-profit target.
   * Example: { "0": 0.08, "60": 0.04, "120": 0.02, "480": 0 }
   * Falls back to fixed take_profit_percent if not configured.
   */
  minimal_roi?: Record<string, number>;

  // ── Break-Even Stop (optional) ──
  /** Minimum profit ratio to activate break-even stop. e.g. 0.03 = activate after +3% profit */
  break_even_profit?: number;
  /** Break-even stop offset from entry price (positive = above entry). Default 0.001 = entry price +0.1% */
  break_even_stop?: number;

  // ── Bid/Ask Spread modeling (backtest only, optional) ──
  /** Simulated bid/ask spread in basis points (bps) for backtesting. e.g. 5 = 0.05%. Default 0 (disabled) */
  spread_bps?: number;
}

export interface ExecutionConfig {
  order_type: OrderType;
  limit_order_offset_percent: number;
  min_order_usdt: number;
  limit_order_timeout_seconds: number;
  /**
   * Pre-entry price deviation protection (inspired by Freqtrade confirm_trade_entry).
   * Cancel entry if current price deviates from signal price by more than this ratio (prevents flash crash false entries).
   * Default 0 (disabled). Recommended: 0.005 (0.5%).
   */
  max_entry_slippage?: number;
  /**
   * Order timeout: if executedQty=0 after N seconds of placing a market order, treat as failed (default 30s).
   * Partial fills are accounted based on actual executed quantity.
   */
  order_timeout_seconds?: number;
  /**
   * Exit confirmation: reject exit when price deviation exceeds this ratio (flash crash protection). Default 0.15 (15%)
   * Only applies to stop_loss exits; take_profit/force_exit etc. are unrestricted.
   */
  max_exit_price_deviation?: number;
  /**
   * Exit confirmation: cooldown seconds after rejection (prevents repetitive logging). Default 300 (5min)
   */
  exit_rejection_cooldown_seconds?: number;
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

/** strategy.yaml — Pure strategy config, without exchange/market info */
export interface StrategyConfig {
  symbols: string[];
  timeframe: Timeframe;
  /**
   * F4 Strategy Plugin ID (optional).
   * Specifies which strategy plugin to use (src/strategies/*.ts).
   * Default "default" = use existing YAML condition matching logic (behavior unchanged).
   * Options: "default" | "rsi-reversal" | "breakout" | custom
   */
  strategy_id?: string;
  protections?: ProtectionConfig;
  /** Trend confirmation timeframe (optional). If set, only allow buy when MA is bullish on this timeframe.
   *  Example: main strategy 1h, trend_timeframe: "4h" -> only open 1h buy when 4h MA is bullish. */
  trend_timeframe?: Timeframe;
  strategy: {
    name: string;
    enabled: boolean;
    ma: { short: number; long: number };
    rsi: { period: number; oversold: number; overbought: number; overbought_exit?: number };
    macd: { enabled: boolean; fast: number; slow: number; signal: number };
    volume?: { surge_ratio: number; low_ratio: number };
    /** Funding rate contrarian signal thresholds (optional, uses defaults if not configured) */
    funding_rate?: {
      long_threshold?: number;  // Long extreme threshold %, default 0.30
      short_threshold?: number; // Short extreme threshold % (absolute value), default 0.15
    };
  };
  signals: {
    buy: string[];
    sell: string[];
    /** Short entry conditions (only valid for futures/margin markets) */
    short?: string[];
    /** Short cover conditions (only valid for futures/margin markets) */
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
      script?: string; // Optional: specify script path directly (takes priority over TASK_SCRIPTS hardcoded mapping)
    }
  >;
  mode: TradeMode;
  /**
   * P5.2 Regime-adaptive parameter overrides
   * Automatically override risk parameters when a specific market regime is detected.
   * key = SignalFilter ("breakout_watch" | "reduced_size" | "all_clear")
   * value = Partial<RiskConfig> (only list fields that need overriding)
   *
   * Example (range-bound market, quick in/out):
   *   regime_overrides:
   *     reduced_size:
   *       take_profit_percent: 5
   *       stop_loss_percent: 1.5
   *       minimal_roi:
   *         "0": 0.03
   *         "30": 0.01
   */
  regime_overrides?: Partial<Record<string, Partial<RiskConfig>>>;
  /**
   * Regime-adaptive signal condition overrides (P5.3)
   *
   * Automatically switch signal condition sets when a specific market regime is detected.
   * key = SignalFilter ("trend_signals_only" | "reversal_signals_only" | "reduced_size" | "all")
   * value = { signals: { buy, sell, short?, cover? } } (overrides the entire signal condition array)
   *
   * If not configured, the system auto-classifies:
   *   trend_signals_only     -> Keep only MA/MACD/CVD trend signals, filter out RSI reversal signals
   *   reversal_signals_only  -> Keep only RSI/price extreme reversal signals, filter out MA/MACD trend signals
   *
   * Example (MA for trending markets, RSI for ranging markets):
   *   regime_strategies:
   *     trend_signals_only:
   *       signals:
   *         buy: ["ma_bullish", "rsi_not_overbought"]
   *         sell: ["ma_bearish"]
   *     reversal_signals_only:
   *       signals:
   *         buy: ["rsi_oversold", "ma_bullish"]
   *         sell: ["rsi_overbought"]
   */
  regime_strategies?: Partial<Record<string, {
    signals: {
      buy: string[];
      sell: string[];
      short?: string[];
      cover?: string[];
    };
  }>>;
  /** Ensemble voting config. Used when strategy_id = "ensemble" */
  ensemble?: EnsembleConfig;
}

// ─────────────────────────────────────────────────────
// Exchange Config (shared between paper scenarios & live)
// ─────────────────────────────────────────────────────

export interface ExchangeConfig {
  name?: string;             // Default "binance"
  credentials_path?: string; // API Key/Secret path
  testnet?: boolean;         // true = use testapi.binance.vision, false = production
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
   * F4 Strategy Plugin ID (optional).
   * Set in strategy profile YAML (config/strategies/*.yaml),
   * specifies which strategy plugin to use ("rsi-reversal" | "breakout" | custom).
   * Not set by default = "default" (YAML condition matching).
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
  strategy_id: string; // References config/strategies/{id}.yaml
  initial_usdt: number;
  fee_rate: number;
  slippage_percent: number;
  exchange: ExchangeConfig;
  symbols?: string[]; // Override strategy/global symbols
  risk?: Partial<RiskConfig>; // Override strategy risk
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

/** Merged runtime config actually used by monitor.ts and engine.ts */
export interface RuntimeConfig extends StrategyConfig {
  exchange: ExchangeConfig;
  paper: {
    scenarioId: string;
    initial_usdt: number;
    fee_rate: number;
    slippage_percent: number;
    report_interval_hours: number;
    /** G5: Enable SQLite persistence (use better-sqlite3 to record open/close trades, config.paper.use_sqlite: true) */
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

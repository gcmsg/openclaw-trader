/**
 * Protection Manager (Freqtrade-inspired)
 *
 * Checks protection conditions based on recent trade records before opening positions:
 *   - CooldownPeriod:         This pair has stop-loss records within last N candles -> pause this pair
 *   - StoplossGuard:          Stop-loss count in lookback window >= limit -> global/per-pair pause
 *   - MaxDrawdownProtection:  Total pnlRatio in lookback window exceeds max drawdown limit -> global pause
 *   - LowProfitPairs:         This pair's avg pnlRatio in lookback window < required profit -> pause this pair
 *
 * Reference:
 *   freqtrade/plugins/protections/cooldown_period.py
 *   freqtrade/plugins/protections/stoploss_guard.py
 *   freqtrade/plugins/protections/max_drawdown_protection.py
 *   freqtrade/plugins/protections/low_profit_pairs.py
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface CooldownConfig {
  enabled: boolean;
  /** Number of candles to cool down after stop-loss (no opening this pair during this period) */
  stop_duration_candles: number;
}

export interface StoplossGuardConfig {
  enabled: boolean;
  /** Lookback time window (number of candles) */
  lookback_period_candles: number;
  /** Maximum stop-loss count allowed in window (pause when reached or exceeded) */
  trade_limit: number;
  /** Pause duration (number of candles, currently used for recording, actual pause indicated by allowed=false) */
  stop_duration_candles: number;
  /** Count only for this pair (false = count across all pairs globally) */
  only_per_pair?: boolean;
}

export interface MaxDrawdownConfig {
  enabled: boolean;
  /** Lookback time window (number of candles) */
  lookback_period_candles: number;
  /** Minimum closed trade records in window required to trigger (below this count, won't trigger) */
  trade_limit: number;
  /** Maximum allowed total pnlRatio (negative, e.g. -0.15 = -15%) */
  max_allowed_drawdown: number;
  /** Pause duration (number of candles) */
  stop_duration_candles: number;
}

export interface LowProfitPairsConfig {
  enabled: boolean;
  /** Lookback time window (number of candles) */
  lookback_period_candles: number;
  /** Minimum closed trade records in window required */
  trade_limit: number;
  /** Minimum required avg pnlRatio for this pair (e.g. 0 = no loss, -0.01 = allow 1% loss) */
  required_profit: number;
  /** Pause duration (number of candles) */
  stop_duration_candles: number;
}

export interface ProtectionConfig {
  cooldown?: CooldownConfig;
  stoploss_guard?: StoplossGuardConfig;
  max_drawdown?: MaxDrawdownConfig;
  low_profit_pairs?: LowProfitPairsConfig;
}

/** Recent closed trade records (for ProtectionManager use) */
export interface TradeRecord {
  /** Trading symbol */
  symbol: string;
  /** Close time (millisecond timestamp) */
  closedAt: number;
  /** P&L ratio (pnl / costBasis, positive=profit, negative=loss) */
  pnlRatio: number;
  /** Whether exit was a stop-loss */
  wasStopLoss: boolean;
}

export interface ProtectionResult {
  allowed: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────
// Core Check Function
// ─────────────────────────────────────────────────────

/**
 * Check whether all protection conditions are met (all enabled protections must pass to allow opening)
 *
 * @param symbol            Symbol to open position for
 * @param config            Protection config
 * @param recentTrades      Recent closed trade records (sorted by closedAt ascending)
 * @param candleIntervalMs  Candle time interval (milliseconds), used to convert candle count to time range
 * @param now               Current time (milliseconds, defaults to Date.now(), injectable for testing)
 */
export function checkProtections(
  symbol: string,
  config: ProtectionConfig,
  recentTrades: TradeRecord[],
  candleIntervalMs: number,
  now?: number
): ProtectionResult {
  const currentTime = now ?? Date.now();

  // ── 1. CooldownPeriod ──────────────────────────────────
  const cooldown = config.cooldown;
  if (cooldown?.enabled) {
    const windowMs = cooldown.stop_duration_candles * candleIntervalMs;
    const windowStart = currentTime - windowMs;
    const pairStoplossTrades = recentTrades.filter(
      (t) => t.symbol === symbol && t.wasStopLoss && t.closedAt >= windowStart
    );
    if (pairStoplossTrades.length > 0) {
      return {
        allowed: false,
        reason: `CooldownPeriod: ${symbol} has stop-loss records within last ${cooldown.stop_duration_candles} candles, cooling down`,
      };
    }
  }

  // ── 2. StoplossGuard ───────────────────────────────────
  const sg = config.stoploss_guard;
  if (sg?.enabled) {
    const windowMs = sg.lookback_period_candles * candleIntervalMs;
    const windowStart = currentTime - windowMs;
    const onlyPerPair = sg.only_per_pair === true;

    const stoplossTrades = recentTrades.filter((t) => {
      if (!t.wasStopLoss) return false;
      if (t.closedAt < windowStart) return false;
      if (onlyPerPair && t.symbol !== symbol) return false;
      return true;
    });

    if (stoplossTrades.length >= sg.trade_limit) {
      const scope = onlyPerPair ? `${symbol} ` : "global ";
      return {
        allowed: false,
        reason: `StoplossGuard: ${scope}had ${stoplossTrades.length} stop-losses within last ${sg.lookback_period_candles} candles (limit ${sg.trade_limit}), pausing`,
      };
    }
  }

  // ── 3. MaxDrawdownProtection ───────────────────────────
  const md = config.max_drawdown;
  if (md?.enabled) {
    const windowMs = md.lookback_period_candles * candleIntervalMs;
    const windowStart = currentTime - windowMs;
    const tradesInWindow = recentTrades.filter((t) => t.closedAt >= windowStart);

    if (tradesInWindow.length >= md.trade_limit) {
      const totalPnl = tradesInWindow.reduce((sum, t) => sum + t.pnlRatio, 0);
      // max_allowed_drawdown is typically negative (e.g. -0.15 = total loss exceeds 15%)
      const threshold = md.max_allowed_drawdown < 0
        ? md.max_allowed_drawdown
        : -md.max_allowed_drawdown; // Auto-convert to negative

      if (totalPnl <= threshold) {
        return {
          allowed: false,
          reason: `MaxDrawdown: total loss ${(totalPnl * 100).toFixed(1)}% within last ${md.lookback_period_candles} candles exceeds limit ${(threshold * 100).toFixed(1)}%, global pause`,
        };
      }
    }
  }

  // ── 4. LowProfitPairs ──────────────────────────────────
  const lp = config.low_profit_pairs;
  if (lp?.enabled) {
    const windowMs = lp.lookback_period_candles * candleIntervalMs;
    const windowStart = currentTime - windowMs;
    const pairTradesInWindow = recentTrades.filter(
      (t) => t.symbol === symbol && t.closedAt >= windowStart
    );

    if (pairTradesInWindow.length >= lp.trade_limit) {
      const avgPnl = pairTradesInWindow.reduce((sum, t) => sum + t.pnlRatio, 0) / pairTradesInWindow.length;
      if (avgPnl < lp.required_profit) {
        return {
          allowed: false,
          reason: `LowProfitPairs: ${symbol} avg P&L ${(avgPnl * 100).toFixed(2)}% within last ${lp.lookback_period_candles} candles < required ${(lp.required_profit * 100).toFixed(2)}%, pausing this pair`,
        };
      }
    }
  }

  return { allowed: true };
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/**
 * Convert signal history records (signal-history.jsonl) format to TradeRecord[]
 * (for live mode reading recent trades from log files)
 */
export function parseTradeRecords(
  jsonLines: string[],
  sinceMs: number
): TradeRecord[] {
  const records: TradeRecord[] = [];
  for (const line of jsonLines) {
    try {
      const entry = JSON.parse(line) as {
        status?: string;
        symbol?: string;
        closedAt?: number;
        pnlPercent?: number;
        exitReason?: string;
      };
      if (
        entry.status === "closed" &&
        entry.symbol &&
        entry.closedAt !== undefined &&
        entry.closedAt >= sinceMs &&
        entry.pnlPercent !== undefined
      ) {
        records.push({
          symbol: entry.symbol,
          closedAt: entry.closedAt,
          pnlRatio: entry.pnlPercent / 100,
          wasStopLoss:
            entry.exitReason === "stop_loss" ||
            entry.exitReason === "trailing_stop",
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

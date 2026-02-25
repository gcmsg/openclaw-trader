/**
 * Protection Manager（仿 Freqtrade）
 *
 * 基于近期交易记录，在开仓前检查是否满足保护条件：
 *   - CooldownPeriod:         该 pair 最近 N 根 K 线内有止损记录 → 暂停该 pair
 *   - StoplossGuard:          所有/该 pair 回看窗口内止损次数 ≥ 上限 → 全局/per-pair 暂停
 *   - MaxDrawdownProtection:  回看窗口内总 pnlRatio 超过最大回撤上限 → 全局暂停
 *   - LowProfitPairs:         该 pair 回看窗口内平均 pnlRatio < 要求盈利 → 暂停该 pair
 *
 * 参考：
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
  /** 止损后冷却的 K 线根数（该时间段内不开该 pair）*/
  stop_duration_candles: number;
}

export interface StoplossGuardConfig {
  enabled: boolean;
  /** 回看时间窗口（K 线根数）*/
  lookback_period_candles: number;
  /** 窗口内允许的最大止损次数（达到或超过则暂停）*/
  trade_limit: number;
  /** 暂停持续时间（K 线根数，目前用于记录，实际以 allowed=false 表示暂停）*/
  stop_duration_candles: number;
  /** 仅对该 pair 计数（false = 全局所有 pair 计数）*/
  only_per_pair?: boolean;
}

export interface MaxDrawdownConfig {
  enabled: boolean;
  /** 回看时间窗口（K 线根数）*/
  lookback_period_candles: number;
  /** 窗口内最少需要的平仓记录数（低于此数则不触发）*/
  trade_limit: number;
  /** 最大允许的 pnlRatio 总和（负数，如 -0.15 = -15%）*/
  max_allowed_drawdown: number;
  /** 暂停持续时间（K 线根数）*/
  stop_duration_candles: number;
}

export interface LowProfitPairsConfig {
  enabled: boolean;
  /** 回看时间窗口（K 线根数）*/
  lookback_period_candles: number;
  /** 窗口内最少需要的平仓记录数*/
  trade_limit: number;
  /** 该 pair 平均 pnlRatio 的最低要求（如 0 = 不亏损，-0.01 = 允许 1% 亏损）*/
  required_profit: number;
  /** 暂停持续时间（K 线根数）*/
  stop_duration_candles: number;
}

export interface ProtectionConfig {
  cooldown?: CooldownConfig;
  stoploss_guard?: StoplossGuardConfig;
  max_drawdown?: MaxDrawdownConfig;
  low_profit_pairs?: LowProfitPairsConfig;
}

/** 近期平仓交易记录（供 ProtectionManager 使用）*/
export interface TradeRecord {
  /** 交易标的 */
  symbol: string;
  /** 平仓时间（毫秒时间戳）*/
  closedAt: number;
  /** 盈亏比率（pnl / costBasis，正=盈利，负=亏损）*/
  pnlRatio: number;
  /** 是否为止损出场 */
  wasStopLoss: boolean;
}

export interface ProtectionResult {
  allowed: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────
// 核心检查函数
// ─────────────────────────────────────────────────────

/**
 * 检查是否满足所有 protection 条件（所有启用的 protection 均通过才允许开仓）
 *
 * @param symbol            要开仓的标的
 * @param config            protection 配置
 * @param recentTrades      近期平仓记录（按 closedAt 升序）
 * @param candleIntervalMs  K 线时间间隔（毫秒），用于将 candles 数量转换为时间范围
 * @param now               当前时间（毫秒，默认 Date.now()，可在测试中注入）
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
        reason: `CooldownPeriod: ${symbol} 在最近 ${cooldown.stop_duration_candles} 根K线内有止损记录，冷却中`,
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
      const scope = onlyPerPair ? `${symbol} ` : "全局 ";
      return {
        allowed: false,
        reason: `StoplossGuard: ${scope}在最近 ${sg.lookback_period_candles} 根K线内发生 ${stoplossTrades.length} 次止损（上限 ${sg.trade_limit}），暂停开仓`,
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
      // max_allowed_drawdown 通常为负数（如 -0.15 = 总亏损超过 15%）
      const threshold = md.max_allowed_drawdown < 0
        ? md.max_allowed_drawdown
        : -md.max_allowed_drawdown; // 自动转为负数

      if (totalPnl <= threshold) {
        return {
          allowed: false,
          reason: `MaxDrawdown: 最近 ${md.lookback_period_candles} 根K线内总亏损 ${(totalPnl * 100).toFixed(1)}% 超过上限 ${(threshold * 100).toFixed(1)}%，全局暂停`,
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
          reason: `LowProfitPairs: ${symbol} 最近 ${lp.lookback_period_candles} 根K线内平均盈亏 ${(avgPnl * 100).toFixed(2)}% < 要求 ${(lp.required_profit * 100).toFixed(2)}%，暂停该 pair`,
        };
      }
    }
  }

  return { allowed: true };
}

// ─────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────

/**
 * 将信号历史记录（signal-history.jsonl）格式转换为 TradeRecord[]
 * （适用于实时模式从日志文件读取近期交易）
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
      // 跳过格式错误的行
    }
  }
  return records;
}

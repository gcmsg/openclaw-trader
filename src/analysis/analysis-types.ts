/**
 * Unified trade record interface
 *
 * Used for signal statistical analysis. Sources can be:
 * - Backtest results (mapped from BacktestTrade)
 * - signal-history.jsonl (live/paper records)
 */

export interface TradeRecord {
  symbol: string;
  side: "long" | "short";
  signalConditions: string[]; // list of triggered signal conditions
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlUsdt: number;
  exitReason: string; // "stop_loss" | "take_profit" | "signal" | "roi_table" | "trailing_stop" | "time_stop"
  holdMs: number;
  entryTime: number; // timestamp ms
  exitTime: number; // timestamp ms
}

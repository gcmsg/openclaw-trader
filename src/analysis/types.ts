/**
 * 交易记录统一接口
 *
 * 用于信号统计分析，来源可以是：
 * - 回测结果（BacktestTrade 映射）
 * - signal-history.jsonl（实盘/paper 记录）
 */

export interface TradeRecord {
  symbol: string;
  side: "long" | "short";
  signalConditions: string[]; // 触发的信号条件列表
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlUsdt: number;
  exitReason: string; // "stop_loss" | "take_profit" | "signal" | "roi_table" | "trailing_stop" | "time_stop"
  holdMs: number;
  entryTime: number; // timestamp ms
  exitTime: number; // timestamp ms
}

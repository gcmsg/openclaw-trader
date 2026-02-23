/**
 * Paper Trading 引擎
 * 接收信号 → 执行模拟交易 → 止损检查
 */

import type { Signal, StrategyConfig } from "../types.js";
import {
  loadAccount,
  saveAccount,
  paperBuy,
  paperSell,
  calcTotalEquity,
  getAccountSummary,
  type PaperTrade,
  type PaperAccount,
} from "./account.js";

export interface PaperEngineResult {
  trade: PaperTrade | null;
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
}

/**
 * 处理信号：尝试开仓/平仓
 */
export function handleSignal(
  signal: Signal,
  cfg: StrategyConfig
): PaperEngineResult {
  const account = loadAccount();
  let trade: PaperTrade | null = null;
  let stopLossTriggered = false;
  let stopLossTrade: PaperTrade | null = null;

  if (signal.type === "buy") {
    trade = paperBuy(
      account,
      signal.symbol,
      signal.price,
      signal.reason.join(", "),
      cfg.risk.position_ratio
    );
  } else if (signal.type === "sell") {
    trade = paperSell(
      account,
      signal.symbol,
      signal.price,
      signal.reason.join(", ")
    );
  }

  saveAccount(account);
  return { trade, stopLossTriggered, stopLossTrade, account };
}

/**
 * 检查所有持仓是否触发止损
 */
export function checkStopLoss(
  prices: Record<string, number>,
  cfg: StrategyConfig
): Array<{ symbol: string; trade: PaperTrade; loss: number }> {
  const account = loadAccount();
  const triggered: Array<{ symbol: string; trade: PaperTrade; loss: number }> = [];

  for (const [symbol, pos] of Object.entries(account.positions)) {
    const currentPrice = prices[symbol];
    if (!currentPrice) continue;

    const lossPercent = (currentPrice - pos.entryPrice) / pos.entryPrice;

    if (lossPercent <= -cfg.risk.stop_loss_percent / 100) {
      const trade = paperSell(
        account,
        symbol,
        currentPrice,
        `止损触发：亏损 ${(lossPercent * 100).toFixed(2)}%`
      );
      if (trade) {
        triggered.push({ symbol, trade, loss: lossPercent });
      }
    }
  }

  if (triggered.length > 0) {
    saveAccount(account);
  }

  return triggered;
}

/**
 * 检查总资金是否触发暂停线
 */
export function checkMaxDrawdown(
  prices: Record<string, number>,
  cfg: StrategyConfig
): boolean {
  const account = loadAccount();
  const equity = calcTotalEquity(account, prices);
  const drawdown = (equity - account.initialUsdt) / account.initialUsdt;
  return drawdown <= -cfg.risk.max_total_loss_percent / 100;
}

/**
 * 获取账户摘要（含当前价格）
 */
export function getPaperSummary(prices: Record<string, number>) {
  const account = loadAccount();
  return getAccountSummary(account, prices);
}

/**
 * 格式化汇报消息
 */
export function formatSummaryMessage(
  prices: Record<string, number>,
  mode: "full" | "brief" = "full"
): string {
  const summary = getPaperSummary(prices);
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";

  const lines: string[] = [
    `📊 **[模拟盘账户]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `💰 USDT 余额: $${summary.usdt.toFixed(2)}`,
    `💼 总资产: $${summary.totalEquity.toFixed(2)}`,
    `${pnlEmoji} 总盈亏: ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`,
  ];

  if (summary.positions.length > 0) {
    lines.push(``, `📋 当前持仓 (${summary.positions.length} 个):`);
    for (const pos of summary.positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? "+" : "";
      const pnlEmoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      lines.push(
        `  ${pnlEmoji} ${pos.symbol}: 买入=$${pos.entryPrice.toFixed(4)} → 现价=$${pos.currentPrice.toFixed(4)} | ${pnlSign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`
      );
    }
  } else {
    lines.push(``, `📭 当前无持仓`);
  }

  if (mode === "full") {
    lines.push(
      ``,
      `📈 总交易次数: ${summary.tradeCount}`,
      `🎯 胜率: ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "暂无数据"}`
    );
  }

  return lines.join("\n");
}

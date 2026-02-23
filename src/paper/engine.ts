/**
 * Paper Trading 引擎
 * 接收信号 → 执行模拟交易 → 止损/止盈/追踪止损检查
 */

import type { Signal, StrategyConfig } from "../types.js";
import {
  loadAccount,
  saveAccount,
  paperBuy,
  paperSell,
  calcTotalEquity,
  getAccountSummary,
  updateTrailingStop,
  resetDailyLossIfNeeded,
  type PaperTrade,
  type PaperAccount,
} from "./account.js";

export interface PaperEngineResult {
  trade: PaperTrade | null;
  skipped?: string;           // 跳过原因（如超过最大持仓数）
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
}

/** 从配置提取 paper 相关参数 */
function paperOpts(cfg: StrategyConfig) {
  return {
    feeRate: cfg.paper.fee_rate,
    slippagePercent: cfg.paper.slippage_percent,
    minOrderUsdt: cfg.execution.min_order_usdt,
    stopLossPercent: cfg.risk.stop_loss_percent,
    takeProfitPercent: cfg.risk.take_profit_percent,
    positionRatio: cfg.risk.position_ratio,
  };
}

/**
 * 处理信号：尝试开仓/平仓
 * 含仓位数量、单币占比、每日亏损检查
 */
export function handleSignal(
  signal: Signal,
  cfg: StrategyConfig
): PaperEngineResult {
  const account = loadAccount(cfg.paper.initial_usdt);
  resetDailyLossIfNeeded(account);

  let trade: PaperTrade | null = null;
  let skipped: string | undefined;

  if (signal.type === "buy") {
    // ① 检查最大持仓数
    const openCount = Object.keys(account.positions).length;
    if (openCount >= cfg.risk.max_positions) {
      skipped = `已达最大持仓数 ${cfg.risk.max_positions}，跳过 ${signal.symbol}`;
    }
    // ② 检查单币最大持仓比例
    else {
      const prices = { [signal.symbol]: signal.price };
      const equity = calcTotalEquity(account, prices);
      const symbolValue = account.positions[signal.symbol]
        ? (account.positions[signal.symbol].quantity * signal.price)
        : 0;
      const symbolRatio = symbolValue / equity;
      if (symbolRatio >= cfg.risk.max_position_per_symbol) {
        skipped = `${signal.symbol} 已达单币最大仓位 ${(cfg.risk.max_position_per_symbol * 100).toFixed(0)}%，跳过`;
      }
    }

    // ③ 检查每日亏损限制
    if (!skipped) {
      const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
      const dailyLossPercent = (account.dailyLoss.loss / equity) * 100;
      if (dailyLossPercent >= cfg.risk.daily_loss_limit_percent) {
        skipped = `今日亏损已达 ${dailyLossPercent.toFixed(1)}%，暂停当日开仓`;
      }
    }

    if (!skipped) {
      trade = paperBuy(
        account,
        signal.symbol,
        signal.price,
        signal.reason.join(", "),
        paperOpts(cfg)
      );
    }
  } else if (signal.type === "sell") {
    trade = paperSell(
      account,
      signal.symbol,
      signal.price,
      signal.reason.join(", "),
      paperOpts(cfg)
    );
  }

  saveAccount(account);
  return { trade, skipped, stopLossTriggered: false, stopLossTrade: null, account };
}

/**
 * 检查所有持仓的止损/止盈/追踪止损
 */
export function checkExitConditions(
  prices: Record<string, number>,
  cfg: StrategyConfig
): Array<{ symbol: string; trade: PaperTrade; reason: "stop_loss" | "take_profit" | "trailing_stop"; pnlPercent: number }> {
  const account = loadAccount(cfg.paper.initial_usdt);
  resetDailyLossIfNeeded(account);
  const triggered: Array<{ symbol: string; trade: PaperTrade; reason: "stop_loss" | "take_profit" | "trailing_stop"; pnlPercent: number }> = [];

  for (const [symbol, pos] of Object.entries(account.positions)) {
    const currentPrice = prices[symbol];
    if (!currentPrice) continue;

    const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    let exitReason: "stop_loss" | "take_profit" | "trailing_stop" | null = null;
    let exitLabel = "";

    // 固定止损
    if (currentPrice <= pos.stopLoss) {
      exitReason = "stop_loss";
      exitLabel = `止损触发：亏损 ${pnlPercent.toFixed(2)}%`;
    }
    // 固定止盈
    else if (currentPrice >= pos.takeProfit) {
      exitReason = "take_profit";
      exitLabel = `止盈触发：盈利 ${pnlPercent.toFixed(2)}%`;
    }
    // 追踪止损
    else if (cfg.risk.trailing_stop.enabled) {
      const shouldExit = updateTrailingStop(pos, currentPrice, {
        activationPercent: cfg.risk.trailing_stop.activation_percent,
        callbackPercent: cfg.risk.trailing_stop.callback_percent,
      });
      if (shouldExit) {
        exitReason = "trailing_stop";
        exitLabel = `追踪止损触发：从最高价回撤 ${cfg.risk.trailing_stop.callback_percent}%`;
      }
    }

    if (exitReason) {
      const trade = paperSell(account, symbol, currentPrice, exitLabel, paperOpts(cfg));
      if (trade) {
        triggered.push({ symbol, trade, reason: exitReason, pnlPercent });
      }
    }
  }

  if (triggered.length > 0) {
    saveAccount(account);
  }

  return triggered;
}

/**
 * 兼容旧接口：检查止损（只返回止损触发）
 * @deprecated 请使用 checkExitConditions
 */
export function checkStopLoss(
  prices: Record<string, number>,
  cfg: StrategyConfig
): Array<{ symbol: string; trade: PaperTrade; loss: number }> {
  return checkExitConditions(prices, cfg)
    .filter((r) => r.reason === "stop_loss")
    .map((r) => ({ symbol: r.symbol, trade: r.trade, loss: r.pnlPercent / 100 }));
}

/**
 * 检查总资金是否触发全局暂停线
 */
export function checkMaxDrawdown(
  prices: Record<string, number>,
  cfg: StrategyConfig
): boolean {
  const account = loadAccount(cfg.paper.initial_usdt);
  const equity = calcTotalEquity(account, prices);
  const drawdown = (equity - account.initialUsdt) / account.initialUsdt;
  return drawdown <= -cfg.risk.max_total_loss_percent / 100;
}

/**
 * 检查每日亏损是否触发当日暂停
 */
export function checkDailyLossLimit(
  prices: Record<string, number>,
  cfg: StrategyConfig
): boolean {
  const account = loadAccount(cfg.paper.initial_usdt);
  resetDailyLossIfNeeded(account);
  const equity = calcTotalEquity(account, prices);
  const dailyLossPercent = (account.dailyLoss.loss / equity) * 100;
  return dailyLossPercent >= cfg.risk.daily_loss_limit_percent;
}

/**
 * 获取账户摘要
 */
export function getPaperSummary(prices: Record<string, number>, cfg: StrategyConfig) {
  const account = loadAccount(cfg.paper.initial_usdt);
  return getAccountSummary(account, prices);
}

/**
 * 格式化汇报消息
 */
export function formatSummaryMessage(
  prices: Record<string, number>,
  cfg: StrategyConfig,
  mode: "full" | "brief" = "full"
): string {
  const summary = getPaperSummary(prices, cfg);
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";

  const lines: string[] = [
    `📊 **[模拟盘账户]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `💰 USDT 余额: $${summary.usdt.toFixed(2)}`,
    `💼 总资产: $${summary.totalEquity.toFixed(2)}`,
    `${pnlEmoji} 总盈亏: ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`,
    `🔴 今日亏损: $${summary.dailyLoss.toFixed(2)}`,
  ];

  if (summary.positions.length > 0) {
    lines.push(``, `📋 当前持仓 (${summary.positions.length}/${cfg.risk.max_positions}):`);
    for (const pos of summary.positions) {
      const posSign = pos.unrealizedPnl >= 0 ? "+" : "";
      const posEmoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      lines.push(
        `  ${posEmoji} ${pos.symbol}: $${pos.entryPrice.toFixed(4)} → $${pos.currentPrice.toFixed(4)} | ${posSign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`,
        `     止损: $${pos.stopLoss.toFixed(4)} | 止盈: $${pos.takeProfit.toFixed(4)}`
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

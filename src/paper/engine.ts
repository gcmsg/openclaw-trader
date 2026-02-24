/**
 * Paper Trading 引擎
 * 接收信号 → 执行模拟交易 → 止损/止盈/追踪止损检查
 * 每个场景使用独立的账户文件（logs/paper-{scenarioId}.json）
 */

import type { Signal, RuntimeConfig } from "../types.js";
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
  skipped?: string | undefined;
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
}

function scenarioId(cfg: RuntimeConfig): string {
  return cfg.paper.scenarioId;
}

function paperOpts(cfg: RuntimeConfig) {
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
 * 处理信号：开仓/平仓（含仓位数量、单币占比、每日亏损检查）
 */
export function handleSignal(signal: Signal, cfg: RuntimeConfig): PaperEngineResult {
  const sid = scenarioId(cfg);
  const account = loadAccount(cfg.paper.initial_usdt, sid);
  resetDailyLossIfNeeded(account);

  let trade: PaperTrade | null = null;
  let skipped: string | undefined;

  if (signal.type === "buy") {
    const openCount = Object.keys(account.positions).length;
    if (openCount >= cfg.risk.max_positions) {
      skipped = `已达最大持仓数 ${cfg.risk.max_positions}，跳过 ${signal.symbol}`;
    } else {
      const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
      const existingPos = account.positions[signal.symbol];
      const symbolValue = existingPos ? existingPos.quantity * signal.price : 0;
      if (symbolValue / equity >= cfg.risk.max_position_per_symbol) {
        skipped = `${signal.symbol} 已达单币最大仓位 ${(cfg.risk.max_position_per_symbol * 100).toFixed(0)}%，跳过`;
      } else if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) {
        skipped = `今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`;
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

  saveAccount(account, sid);
  return { trade, skipped, stopLossTriggered: false, stopLossTrade: null, account };
}

/**
 * 检查所有持仓的止损/止盈/追踪止损
 */
export function checkExitConditions(
  prices: Record<string, number>,
  cfg: RuntimeConfig
): {
  symbol: string;
  trade: PaperTrade;
  reason: "stop_loss" | "take_profit" | "trailing_stop";
  pnlPercent: number;
}[] {
  const sid = scenarioId(cfg);
  const account = loadAccount(cfg.paper.initial_usdt, sid);
  resetDailyLossIfNeeded(account);
  const triggered: {
    symbol: string;
    trade: PaperTrade;
    reason: "stop_loss" | "take_profit" | "trailing_stop";
    pnlPercent: number;
  }[] = [];

  for (const [symbol, pos] of Object.entries(account.positions)) {
    const currentPrice = prices[symbol];
    if (!currentPrice) continue;

    const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    let exitReason: "stop_loss" | "take_profit" | "trailing_stop" | null = null;
    let exitLabel = "";

    if (currentPrice <= pos.stopLoss) {
      exitReason = "stop_loss";
      exitLabel = `止损触发：亏损 ${pnlPercent.toFixed(2)}%`;
    } else if (currentPrice >= pos.takeProfit) {
      exitReason = "take_profit";
      exitLabel = `止盈触发：盈利 ${pnlPercent.toFixed(2)}%`;
    } else if (cfg.risk.trailing_stop.enabled) {
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
      if (trade) triggered.push({ symbol, trade, reason: exitReason, pnlPercent });
    }
  }

  if (triggered.length > 0) saveAccount(account, sid);
  return triggered;
}

/** compat shim */
export function checkStopLoss(
  prices: Record<string, number>,
  cfg: RuntimeConfig
): { symbol: string; trade: PaperTrade; loss: number }[] {
  return checkExitConditions(prices, cfg)
    .filter((r) => r.reason === "stop_loss")
    .map((r) => ({ symbol: r.symbol, trade: r.trade, loss: r.pnlPercent / 100 }));
}

export function checkMaxDrawdown(prices: Record<string, number>, cfg: RuntimeConfig): boolean {
  const account = loadAccount(cfg.paper.initial_usdt, scenarioId(cfg));
  const equity = calcTotalEquity(account, prices);
  return (
    (equity - account.initialUsdt) / account.initialUsdt <= -cfg.risk.max_total_loss_percent / 100
  );
}

export function checkDailyLossLimit(prices: Record<string, number>, cfg: RuntimeConfig): boolean {
  const account = loadAccount(cfg.paper.initial_usdt, scenarioId(cfg));
  resetDailyLossIfNeeded(account);
  const equity = calcTotalEquity(account, prices);
  return (account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent;
}

export function getPaperSummary(prices: Record<string, number>, cfg: RuntimeConfig) {
  return getAccountSummary(loadAccount(cfg.paper.initial_usdt, scenarioId(cfg)), prices);
}

export function formatSummaryMessage(
  prices: Record<string, number>,
  cfg: RuntimeConfig,
  mode: "full" | "brief" = "full"
): string {
  const summary = getPaperSummary(prices, cfg);
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";
  const marketLabel = cfg.exchange.market.toUpperCase();
  const leverageLabel = cfg.exchange.leverage?.enabled ? ` ${cfg.exchange.leverage.default}x` : "";

  const lines: string[] = [
    `📊 **[${marketLabel}${leverageLabel}]** ${new Date().toLocaleString("zh-CN")}`,
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

/**
 * 回测报告格式化
 * - 控制台友好输出
 * - JSON 结果保存到 logs/backtest/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { BacktestResult } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(__dirname, "../../logs/backtest");

// ─────────────────────────────────────────────────────
// 控制台输出
// ─────────────────────────────────────────────────────

function pad(str: string, len: number, right = false): string {
  const s = str;
  return right ? s.padStart(len) : s.padEnd(len);
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsdt(n: number): string {
  if (n >= 0) return `+$${n.toFixed(2)}`;
  return `-$${Math.abs(n).toFixed(2)}`;
}

function fmtRatio(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toFixed(2);
}

function line(char = "─", width = 50): string {
  return char.repeat(width);
}

/**
 * 生成人类可读的控制台报告文本
 */
export function formatReport(result: BacktestResult): string {
  const { metrics: m, perSymbol, config: c } = result;
  const lines: string[] = [];

  const titleWidth = 52;
  lines.push(line("━", titleWidth));
  lines.push(`📊 回测报告 — ${c.strategy}`);
  lines.push(line("━", titleWidth));
  lines.push("");
  lines.push(`📅 时间范围  ${c.startDate} → ${c.endDate}（${c.days} 天）`);
  lines.push(`⏱️  时间框架  ${c.timeframe}`);
  lines.push(`🪙  监控币种  ${c.symbols.join("  ")}`);
  lines.push(`💵  初始资金  $${c.initialUsdt.toFixed(2)}`);
  if ((c.spreadBps ?? 0) > 0) {
    lines.push(`📏  Spread    ${c.spreadBps} bps（${((c.spreadBps ?? 0) / 100).toFixed(3)}%，模拟 bid/ask 价差）`);
  }
  if (c.signalToNextOpen) {
    lines.push(`⚡  执行模式  下一根 K 线开盘成交（无前视偏差，更接近实盘）`);
  } else {
    lines.push(`⚠️  执行模式  当根 K 线收盘成交（存在前视偏差）— 建议加 --next-open`);
  }
  lines.push("");

  // ── 收益 ──
  lines.push(line("─", titleWidth));
  lines.push("📈 收益");
  lines.push(line("─", titleWidth));
  const retEmoji = m.totalReturn >= 0 ? "🟢" : "🔴";
  lines.push(
    `${retEmoji} 总收益          ${pad(fmtUsdt(m.totalReturn), 12, true)}  (${fmtPct(m.totalReturnPercent)})`
  );
  lines.push(
    `   最大回撤        ${pad("-" + fmt(m.maxDrawdown) + "%", 12, true)}  ($${fmt(m.maxDrawdownUsdt)})`
  );
  lines.push(`   夏普比率        ${pad(fmtRatio(m.sharpeRatio), 12, true)}`);
  lines.push(`   索提诺比率      ${pad(fmtRatio(m.sortinoRatio), 12, true)}`);
  lines.push(`   卡玛比率        ${pad(fmtRatio(m.calmarRatio), 12, true)}  (年化收益/最大回撤)`);
  if (m.benchmarkReturn !== undefined) {
    const bSign = m.benchmarkReturn >= 0 ? "+" : "";
    lines.push(
      `🏆 BTC持有收益    ${pad(bSign + fmt(m.benchmarkReturn) + "%", 12, true)}  (同期基准)`
    );
    if (m.alpha !== undefined) {
      const aSign = m.alpha >= 0 ? "+" : "";
      const alphaEmoji = m.alpha >= 0 ? "✅" : "⚠️";
      lines.push(
        `${alphaEmoji} Alpha超额收益   ${pad(aSign + fmt(m.alpha) + "%", 12, true)}  (策略 - BTC持有)`
      );
    }
  }
  lines.push("");

  // ── 交易统计 ──
  lines.push(line("─", titleWidth));
  lines.push("🎯 交易统计");
  lines.push(line("─", titleWidth));
  lines.push(`   总交易次数      ${pad(String(m.totalTrades), 12, true)}`);
  lines.push(
    `   胜率            ${pad(fmt(m.winRate * 100) + "%", 12, true)}  (${m.wins} 赢 / ${m.losses} 输)`
  );
  lines.push(`   利润因子        ${pad(fmtRatio(m.profitFactor), 12, true)}`);
  lines.push(
    `   盈亏比          ${pad(fmtRatio(m.winLossRatio) + ":1", 12, true)}  (均盈 ${fmtPct(m.avgWinPercent)} / 均亏 -${fmt(m.avgLossPercent)}%)`
  );
  lines.push(`   平均持仓        ${pad(fmt(m.avgHoldingHours) + " 小时", 12, true)}`);
  lines.push(`   最佳单笔        ${pad(fmtPct(m.bestTradePct), 12, true)}`);
  lines.push(`   最差单笔        ${pad(fmtPct(m.worstTradePct), 12, true)}`);
  lines.push("");

  // ── 出场原因 ──
  lines.push(line("─", titleWidth));
  lines.push("🚪 出场原因");
  lines.push(line("─", titleWidth));
  if (m.totalTrades > 0) {
    const total = m.totalTrades;
    lines.push(
      `   信号卖出        ${pad(String(m.signalExitCount), 6, true)}  (${fmt((m.signalExitCount / total) * 100)}%)`
    );
    lines.push(
      `   止盈            ${pad(String(m.takeProfitCount), 6, true)}  (${fmt((m.takeProfitCount / total) * 100)}%)`
    );
    lines.push(
      `   止损            ${pad(String(m.stopLossCount), 6, true)}  (${fmt((m.stopLossCount / total) * 100)}%)`
    );
    if (m.trailingStopCount > 0) {
      lines.push(
        `   追踪止损        ${pad(String(m.trailingStopCount), 6, true)}  (${fmt((m.trailingStopCount / total) * 100)}%)`
      );
    }
    if (m.endOfDataCount > 0) {
      lines.push(
        `   强制平仓        ${pad(String(m.endOfDataCount), 6, true)}  (${fmt((m.endOfDataCount / total) * 100)}%)`
      );
    }
  } else {
    lines.push("   暂无交易数据");
  }
  lines.push("");

  // ── 各币种表现 ──
  lines.push(line("─", titleWidth));
  lines.push("🪙  各币种表现");
  lines.push(line("─", titleWidth));
  const symEntries = Object.entries(perSymbol).sort(([, a], [, b]) => b.pnl - a.pnl);
  for (const [sym, stats] of symEntries) {
    const wr = stats.trades > 0 ? `${fmt(stats.winRate * 100)}%` : "─";
    const pnlStr = stats.pnl >= 0 ? `+$${fmt(stats.pnl)}` : `-$${fmt(Math.abs(stats.pnl))}`;
    const emoji = stats.pnl > 0 ? "🟢" : stats.pnl < 0 ? "🔴" : "⚪";
    lines.push(
      `  ${emoji} ${pad(sym.replace("USDT", ""), 6)}  ${pad(`${stats.trades} 笔`, 7, true)}  胜率 ${pad(wr, 7, true)}  ${pnlStr}`
    );
  }
  lines.push("");

  lines.push(line("━", titleWidth));

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// JSON 报告保存
// ─────────────────────────────────────────────────────

/**
 * 将回测结果保存为 JSON 文件
 * 返回保存路径
 */
export function saveReport(result: BacktestResult, label?: string): string {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const stratSlug = result.config.strategy.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const suffix = label ? `-${label}` : "";
  const filename = `backtest-${stratSlug}-${result.config.days}d-${dateStr}${suffix}.json`;
  const filePath = path.join(REPORT_DIR, filename);

  // 保存时精简权益曲线（每 10 个点采样一次，避免文件过大）
  const SAMPLE = 10;
  const sampledCurve = result.metrics.equityCurve.filter((_, i) => i % SAMPLE === 0);

  const reportData = {
    ...result,
    metrics: {
      ...result.metrics,
      equityCurve: sampledCurve,
    },
    // 只保留平仓记录（完整交易）：sell（平多）+ cover（平空）
    trades: result.trades.filter((t) => t.side === "sell" || t.side === "cover"),
  };

  fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2));
  return filePath;
}

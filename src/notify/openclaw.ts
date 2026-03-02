import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Signal, TradeResult } from "../types.js";
import type { PaperTrade, PaperAccount } from "../paper/account.js";

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ── 跨场景通知去重 ────────────────────────────────────────
// 多个场景同时运行时，相同币种的信号只发送一次（30分钟窗口）
const DEDUP_MINUTES = 30;
const DEDUP_PATH = path.resolve(
  fileURLToPath(import.meta.url), "../../..", "logs/signal-notify-dedup.json"
);

type DedupState = Record<string, number>; // key: "SYMBOL:type", value: last notify timestamp

function readDedup(): DedupState {
  try { return JSON.parse(fs.readFileSync(DEDUP_PATH, "utf-8")) as DedupState; }
  catch { return {}; }
}

function shouldSendSignal(symbol: string, type: string): boolean {
  const key = `${symbol}:${type}`;
  const last = readDedup()[key] ?? 0;
  return (Date.now() - last) / 60000 >= DEDUP_MINUTES;
}

function markSignalSent(symbol: string, type: string): void {
  const state = readDedup();
  state[`${symbol}:${type}`] = Date.now();
  try {
    fs.mkdirSync(path.dirname(DEDUP_PATH), { recursive: true });
    fs.writeFileSync(DEDUP_PATH, JSON.stringify(state, null, 2));
  } catch { /* ignore write errors */ }
}

// ── notifyError 冷却（同一 context 30 分钟内只发一次）────────────
const ERROR_COOLDOWN_MS = 30 * 60_000;
const _errorLastNotified = new Map<string, number>();

/** 向 OpenClaw 主会话注入系统事件，触发 Mia 决策 */
function sendToAgent(message: string): void {
  try {
    // 用参数数组避免 shell 解析 $ 符号
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", message);
    const result = spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
    if (result.status !== 0 && result.stderr) {
      console.error("sendToAgent failed:", result.stderr.slice(0, 200));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sendToAgent failed:", msg);
  }
}

function formatPrice(price: number): string {
  return price >= 1000
    ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${price.toFixed(4)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** 通用 Telegram 文本消息发送 */
export function sendTelegramMessage(text: string): void {
  sendToAgent(text);
}

/** 信号通知 */
export function notifySignal(signal: Signal): void {
  // 跨场景去重：同一币种同方向信号 30 分钟内只发一次
  if (!shouldSendSignal(signal.symbol, signal.type)) return;
  markSignalSent(signal.symbol, signal.type);

  const emoji = signal.type === "buy" ? "🟢" : "🔴";
  const action = signal.type === "buy" ? "买入信号" : "卖出信号";
  const { maShort, maLong, rsi } = signal.indicators;

  const msg = [
    `${emoji} **[交易信号] ${signal.symbol} ${action}**`,
    ``,
    `💰 当前价格: ${formatPrice(signal.price)}`,
    `📊 指标:`,
    `  • MA短期: ${maShort.toFixed(2)}`,
    `  • MA长期: ${maLong.toFixed(2)}`,
    `  • RSI: ${rsi.toFixed(1)}`,
    `📋 触发条件: ${signal.reason.join(", ")}`,
    `🕐 时间: ${new Date(signal.timestamp).toLocaleString("zh-CN")}`,
    ``,
    `是否执行此交易？请回复 **是** 或 **否**。`,
  ].join("\n");

  sendToAgent(msg);
}

/** 交易执行通知 */
export function notifyTrade(trade: TradeResult): void {
  const emoji = trade.status === "filled" ? "✅" : "❌";
  const side = trade.side === "buy" ? "买入" : "卖出";

  const msg = [
    `${emoji} **[交易执行] ${trade.symbol} ${side}**`,
    ``,
    `💰 成交价: ${formatPrice(trade.price)}`,
    `📦 数量: ${trade.quantity}`,
    `🔖 订单ID: ${trade.orderId}`,
    `📋 状态: ${trade.status === "filled" ? "成功" : "失败"}`,
    trade.error ? `❗ 错误: ${trade.error}` : "",
    `🕐 时间: ${new Date(trade.timestamp).toLocaleString("zh-CN")}`,
  ]
    .filter(Boolean)
    .join("\n");

  sendToAgent(msg);
}

/** 止损触发通知 */
export function notifyStopLoss(
  symbol: string,
  entryPrice: number,
  currentPrice: number,
  loss: number
): void {
  const msg = [
    `🚨 **[止损触发] ${symbol}**`,
    ``,
    `📉 买入价: ${formatPrice(entryPrice)}`,
    `📉 当前价: ${formatPrice(currentPrice)}`,
    `💸 亏损: ${formatPercent(loss)}`,
    `🕐 时间: ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `已自动执行止损卖出。`,
  ].join("\n");

  sendToAgent(msg);
}

/** 错误通知（同一 context 30 分钟内只发一次，防止持续故障轰炸）*/
export function notifyError(context: string, error: Error): void {
  const now = Date.now();
  const last = _errorLastNotified.get(context) ?? 0;
  if (now - last < ERROR_COOLDOWN_MS) {
    console.warn(`[notifyError] cooldown: ${context} (${Math.round((now - last) / 60000)}min ago)`);
    return;
  }
  _errorLastNotified.set(context, now);

  const msg = [
    `⚠️ **[监控脚本错误]**`,
    ``,
    `📍 位置: ${context}`,
    `❗ 错误: ${error.message}`,
    `🕐 时间: ${new Date().toLocaleString("zh-CN")}`,
  ].join("\n");

  sendToAgent(msg);
}

/** 模拟盘交易通知 */
export function notifyPaperTrade(trade: PaperTrade, account: PaperAccount): void {
  // 准确显示多头/空头操作方向
  const side =
    trade.side === "buy" ? "买入(开多)" :
    trade.side === "short" ? "开空" :
    trade.side === "cover" ? "平空" :
    "卖出(平多)";
  const emoji =
    trade.side === "buy" ? "🟢" :
    trade.side === "short" ? "🔵" :
    trade.side === "cover" ? "🟣" :
    "🔴";
  const pnlLine =
    trade.pnl !== undefined
      ? `💰 本笔盈亏: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)} (${trade.pnl >= 0 ? "+" : ""}${((trade.pnlPercent ?? 0) * 100).toFixed(2)}%)`
      : "";

  const msg = [
    `${emoji} **[模拟盘] ${trade.symbol} ${side}**`,
    ``,
    `💲 成交价: $${trade.price.toFixed(4)}`,
    `📦 数量: ${trade.quantity.toFixed(6)}`,
    `💵 金额: $${trade.usdtAmount.toFixed(2)}（含手续费 $${trade.fee.toFixed(3)}）`,
    pnlLine,
    `📋 原因: ${trade.reason}`,
    ``,
    `💼 当前余额: $${account.usdt.toFixed(2)} USDT`,
    `🔖 订单号: ${trade.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  sendToAgent(msg);
}

/** 新闻情绪分析报告 */
export function sendNewsReport(data: {
  fearGreed: { value: number; label: string };
  fearGreedInterpret: string;
  globalMarket: {
    totalMarketCapUsd: number;
    marketCapChangePercent24h: number;
    btcDominance: number;
  };
  sentiment: "bullish" | "bearish" | "neutral";
  importantNews: { title: string; source: string; publishedAt: string }[];
  bigMovers: { symbol: string; priceChangePercent: number; price: number }[];
  fgAlert: boolean;
  fgDelta: number;
}): void {
  const sentimentEmoji =
    data.sentiment === "bullish" ? "🟢 偏多" : data.sentiment === "bearish" ? "🔴 偏空" : "⚪ 中性";

  const fgEmoji =
    data.fearGreed.value <= 25
      ? "😱"
      : data.fearGreed.value <= 45
        ? "😰"
        : data.fearGreed.value <= 55
          ? "😐"
          : data.fearGreed.value <= 75
            ? "😏"
            : "🤑";

  const totalMcap = (data.globalMarket.totalMarketCapUsd / 1e12).toFixed(2);
  const mcapChange = data.globalMarket.marketCapChangePercent24h.toFixed(2);
  const mcapEmoji = parseFloat(mcapChange) >= 0 ? "📈" : "📉";

  const lines: string[] = [
    `📰 **[市场情绪报告]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `${fgEmoji} **恐惧贪婪指数**: ${data.fearGreed.value}/100 (${data.fearGreed.label})`,
    `   ${data.fearGreedInterpret}`,
    data.fgAlert
      ? `   ⚠️ 指数变化: ${data.fgDelta > 0 ? "+" : ""}${data.fgDelta} 点（显著变化）`
      : "",
    ``,
    `${mcapEmoji} **全球总市值**: $${totalMcap}T (24h: ${mcapChange}%)`,
    `🔶 **BTC 占比**: ${data.globalMarket.btcDominance.toFixed(1)}%`,
    ``,
    `**综合情绪**: ${sentimentEmoji}`,
  ];

  if (data.bigMovers.length > 0) {
    lines.push(``, `🚀 **价格异动（24h ±5%）**:`);
    for (const m of data.bigMovers) {
      const arrow = m.priceChangePercent >= 0 ? "🟢" : "🔴";
      lines.push(
        `  ${arrow} ${m.symbol}: ${m.priceChangePercent > 0 ? "+" : ""}${m.priceChangePercent.toFixed(2)}%`
      );
    }
  }

  if (data.importantNews.length > 0) {
    lines.push(``, `📋 **重要新闻** (${data.importantNews.length} 条):`);
    for (const n of data.importantNews.slice(0, 5)) {
      lines.push(`  • ${n.title}`);
      lines.push(`    _${n.source}_`);
    }
  }

  const msg = lines.filter((l) => l !== "").join("\n");
  sendToAgent(msg);
}

/** 定期状态汇报 */
export function notifyStatus(
  summary: { symbol: string; price: number; rsi: number; trend: string }[]
): void {
  const rows = summary
    .map(
      (s) =>
        `  ${s.symbol.padEnd(10)} ${formatPrice(s.price).padStart(12)}  RSI:${s.rsi.toFixed(0).padStart(3)}  ${s.trend}`
    )
    .join("\n");

  const msg = [`📊 **[市场状态汇报]** ${new Date().toLocaleString("zh-CN")}`, ``, rows].join("\n");

  sendToAgent(msg);
}

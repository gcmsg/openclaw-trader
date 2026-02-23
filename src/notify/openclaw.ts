import { execSync } from "child_process";
import type { Signal, TradeResult } from "../types.js";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

/** 向 OpenClaw 主会话注入系统事件，触发 Mia 决策 */
async function sendToAgent(message: string): Promise<void> {
  try {
    const tokenFlag = GATEWAY_TOKEN ? `--token ${GATEWAY_TOKEN}` : "";
    execSync(
      `${OPENCLAW_BIN} system event --mode now ${tokenFlag} --text ${JSON.stringify(message)}`,
      { stdio: "pipe", timeout: 15000 }
    );
  } catch (err) {
    console.error("sendToAgent failed:", (err as Error).message);
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

/** 信号通知 */
export async function notifySignal(signal: Signal): Promise<void> {
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

  await sendToAgent(msg);
}

/** 交易执行通知 */
export async function notifyTrade(trade: TradeResult): Promise<void> {
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

  await sendToAgent(msg);
}

/** 止损触发通知 */
export async function notifyStopLoss(
  symbol: string,
  entryPrice: number,
  currentPrice: number,
  loss: number
): Promise<void> {
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

  await sendToAgent(msg);
}

/** 错误通知 */
export async function notifyError(context: string, error: Error): Promise<void> {
  const msg = [
    `⚠️ **[监控脚本错误]**`,
    ``,
    `📍 位置: ${context}`,
    `❗ 错误: ${error.message}`,
    `🕐 时间: ${new Date().toLocaleString("zh-CN")}`,
  ].join("\n");

  await sendToAgent(msg);
}

/** 新闻情绪分析报告 */
export async function sendNewsReport(data: {
  fearGreed: { value: number; label: string };
  fearGreedInterpret: string;
  globalMarket: { totalMarketCapUsd: number; marketCapChangePercent24h: number; btcDominance: number };
  sentiment: "bullish" | "bearish" | "neutral";
  importantNews: Array<{ title: string; source: string; publishedAt: string }>;
  bigMovers: Array<{ symbol: string; priceChangePercent: number; price: number }>;
  fgAlert: boolean;
  fgDelta: number;
}): Promise<void> {
  const sentimentEmoji =
    data.sentiment === "bullish" ? "🟢 偏多" :
    data.sentiment === "bearish" ? "🔴 偏空" : "⚪ 中性";

  const fgEmoji =
    data.fearGreed.value <= 25 ? "😱" :
    data.fearGreed.value <= 45 ? "😰" :
    data.fearGreed.value <= 55 ? "😐" :
    data.fearGreed.value <= 75 ? "😏" : "🤑";

  const totalMcap = (data.globalMarket.totalMarketCapUsd / 1e12).toFixed(2);
  const mcapChange = data.globalMarket.marketCapChangePercent24h.toFixed(2);
  const mcapEmoji = parseFloat(mcapChange) >= 0 ? "📈" : "📉";

  const lines: string[] = [
    `📰 **[市场情绪报告]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `${fgEmoji} **恐惧贪婪指数**: ${data.fearGreed.value}/100 (${data.fearGreed.label})`,
    `   ${data.fearGreedInterpret}`,
    data.fgAlert ? `   ⚠️ 指数变化: ${data.fgDelta > 0 ? "+" : ""}${data.fgDelta} 点（显著变化）` : "",
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
      lines.push(`  ${arrow} ${m.symbol}: ${m.priceChangePercent > 0 ? "+" : ""}${m.priceChangePercent.toFixed(2)}%`);
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
  await sendToAgent(msg);
}

/** 定期状态汇报 */
export async function notifyStatus(
  summary: Array<{ symbol: string; price: number; rsi: number; trend: string }>
): Promise<void> {
  const rows = summary
    .map(
      (s) =>
        `  ${s.symbol.padEnd(10)} ${formatPrice(s.price).padStart(12)}  RSI:${s.rsi.toFixed(0).padStart(3)}  ${s.trend}`
    )
    .join("\n");

  const msg = [
    `📊 **[市场状态汇报]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    rows,
  ].join("\n");

  await sendToAgent(msg);
}

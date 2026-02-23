import https from "https";
import type { Signal, TradeResult } from "../types.js";

const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";

/** 向 OpenClaw Gateway 发送消息，触发 Mia 决策 */
async function sendToAgent(message: string): Promise<void> {
  const body = JSON.stringify({
    message,
    sessionKey: "agent:main:main",
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: parseInt(GATEWAY_PORT),
        path: "/api/agent/message",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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

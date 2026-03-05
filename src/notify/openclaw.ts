import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Signal, TradeResult } from "../types.js";
import type { PaperTrade, PaperAccount } from "../paper/account.js";

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ── Cross-scenario notification dedup ────────────────────────────────────────
// When multiple scenarios run simultaneously, same symbol signals are sent only once (30-minute window)
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

// ── notifyError cooldown (same context sent only once per 30 minutes) ────────────
const ERROR_COOLDOWN_MS = 30 * 60_000;
const _errorLastNotified = new Map<string, number>();

/** Inject system event into OpenClaw main session, trigger AI agent decision */
function sendToAgent(message: string): void {
  try {
    // Use argument array to avoid shell parsing of $ signs
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

/** General Telegram text message sender */
export function sendTelegramMessage(text: string): void {
  sendToAgent(text);
}

/** Signal notification */
export function notifySignal(signal: Signal): void {
  // Cross-scenario dedup: same symbol same direction signal sent only once per 30 minutes
  if (!shouldSendSignal(signal.symbol, signal.type)) return;
  markSignalSent(signal.symbol, signal.type);

  const emoji = signal.type === "buy" ? "🟢" : "🔴";
  const action = signal.type === "buy" ? "Buy Signal" : "Sell Signal";
  const { maShort, maLong, rsi } = signal.indicators;

  const msg = [
    `${emoji} **[Trade Signal] ${signal.symbol} ${action}**`,
    ``,
    `💰 Current Price: ${formatPrice(signal.price)}`,
    `📊 Indicators:`,
    `  • MA Short: ${maShort.toFixed(2)}`,
    `  • MA Long: ${maLong.toFixed(2)}`,
    `  • RSI: ${rsi.toFixed(1)}`,
    `📋 Triggered Rules: ${signal.reason.join(", ")}`,
    `🕐 Time: ${new Date(signal.timestamp).toLocaleString("en-US")}`,
    ``,
    `Execute this trade? Reply **Yes** or **No**.`,
  ].join("\n");

  sendToAgent(msg);
}

/** Trade execution notification */
export function notifyTrade(trade: TradeResult): void {
  const emoji = trade.status === "filled" ? "✅" : "❌";
  const side = trade.side === "buy" ? "Buy" : "Sell";

  const msg = [
    `${emoji} **[Trade Execution] ${trade.symbol} ${side}**`,
    ``,
    `💰 Fill Price: ${formatPrice(trade.price)}`,
    `📦 Quantity: ${trade.quantity}`,
    `🔖 Order ID: ${trade.orderId}`,
    `📋 Status: ${trade.status === "filled" ? "Filled" : "Failed"}`,
    trade.error ? `❗ Error: ${trade.error}` : "",
    `🕐 Time: ${new Date(trade.timestamp).toLocaleString("en-US")}`,
  ]
    .filter(Boolean)
    .join("\n");

  sendToAgent(msg);
}

/** Stop-loss trigger notification */
export function notifyStopLoss(
  symbol: string,
  entryPrice: number,
  currentPrice: number,
  loss: number
): void {
  const msg = [
    `🚨 **[Stop-Loss Triggered] ${symbol}**`,
    ``,
    `📉 Entry Price: ${formatPrice(entryPrice)}`,
    `📉 Current Price: ${formatPrice(currentPrice)}`,
    `💸 Loss: ${formatPercent(loss)}`,
    `🕐 Time: ${new Date().toLocaleString("en-US")}`,
    ``,
    `Stop-loss sell executed automatically.`,
  ].join("\n");

  sendToAgent(msg);
}

/** Error notification (same context sent only once per 30 minutes, prevents continuous fault bombardment) */
export function notifyError(context: string, error: Error): void {
  const now = Date.now();
  const last = _errorLastNotified.get(context) ?? 0;
  if (now - last < ERROR_COOLDOWN_MS) {
    console.warn(`[notifyError] cooldown: ${context} (${Math.round((now - last) / 60000)}min ago)`);
    return;
  }
  _errorLastNotified.set(context, now);

  const msg = [
    `⚠️ **[Monitor Script Error]**`,
    ``,
    `📍 Location: ${context}`,
    `❗ Error: ${error.message}`,
    `🕐 Time: ${new Date().toLocaleString("en-US")}`,
  ].join("\n");

  sendToAgent(msg);
}

/** Paper trade notification */
export function notifyPaperTrade(trade: PaperTrade, account: PaperAccount): void {
  // Accurately display long/short operation direction
  const side =
    trade.side === "buy" ? "Buy(OpenLong)" :
    trade.side === "short" ? "OpenShort" :
    trade.side === "cover" ? "CoverShort" :
    "Sell(CloseLong)";
  const emoji =
    trade.side === "buy" ? "🟢" :
    trade.side === "short" ? "🔵" :
    trade.side === "cover" ? "🟣" :
    "🔴";
  const pnlLine =
    trade.pnl !== undefined
      ? `💰 PnL: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)} (${trade.pnl >= 0 ? "+" : ""}${((trade.pnlPercent ?? 0) * 100).toFixed(2)}%)`
      : "";

  const msg = [
    `${emoji} **[Paper Trade] ${trade.symbol} ${side}**`,
    ``,
    `💲 Fill Price: $${trade.price.toFixed(4)}`,
    `📦 Quantity: ${trade.quantity.toFixed(6)}`,
    `💵 Amount: $${trade.usdtAmount.toFixed(2)} (incl. fee $${trade.fee.toFixed(3)})`,
    pnlLine,
    `📋 Reason: ${trade.reason}`,
    ``,
    `💼 Current Balance: $${account.usdt.toFixed(2)} USDT`,
    `🔖 Order ID: ${trade.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  sendToAgent(msg);
}

/** News sentiment analysis report */
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
    data.sentiment === "bullish" ? "🟢 Bullish" : data.sentiment === "bearish" ? "🔴 Bearish" : "⚪ Neutral";

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
    `📰 **[Market Sentiment Report]** ${new Date().toLocaleString("en-US")}`,
    ``,
    `${fgEmoji} **Fear & Greed Index**: ${data.fearGreed.value}/100 (${data.fearGreed.label})`,
    `   ${data.fearGreedInterpret}`,
    data.fgAlert
      ? `   ⚠️ Index Change: ${data.fgDelta > 0 ? "+" : ""}${data.fgDelta} pts (significant change)`
      : "",
    ``,
    `${mcapEmoji} **Global Market Cap**: $${totalMcap}T (24h: ${mcapChange}%)`,
    `🔶 **BTC Dominance**: ${data.globalMarket.btcDominance.toFixed(1)}%`,
    ``,
    `**Overall Sentiment**: ${sentimentEmoji}`,
  ];

  if (data.bigMovers.length > 0) {
    lines.push(``, `🚀 **Price Movers (24h ±5%)**:`);
    for (const m of data.bigMovers) {
      const arrow = m.priceChangePercent >= 0 ? "🟢" : "🔴";
      lines.push(
        `  ${arrow} ${m.symbol}: ${m.priceChangePercent > 0 ? "+" : ""}${m.priceChangePercent.toFixed(2)}%`
      );
    }
  }

  if (data.importantNews.length > 0) {
    lines.push(``, `📋 **Important News** (${data.importantNews.length}):`);
    for (const n of data.importantNews.slice(0, 5)) {
      lines.push(`  • ${n.title}`);
      lines.push(`    _${n.source}_`);
    }
  }

  const msg = lines.filter((l) => l !== "").join("\n");
  sendToAgent(msg);
}

/** Periodic status report */
export function notifyStatus(
  summary: { symbol: string; price: number; rsi: number; trend: string }[]
): void {
  const rows = summary
    .map(
      (s) =>
        `  ${s.symbol.padEnd(10)} ${formatPrice(s.price).padStart(12)}  RSI:${s.rsi.toFixed(0).padStart(3)}  ${s.trend}`
    )
    .join("\n");

  const msg = [`📊 **[Market Status Report]** ${new Date().toLocaleString("en-US")}`, ``, rows].join("\n");

  sendToAgent(msg);
}

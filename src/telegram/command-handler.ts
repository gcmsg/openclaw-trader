/**
 * Telegram interactive command handler (P7.3)
 *
 * Parses and handles commands from the user, returns Markdown formatted response text.
 * Does not send messages directly; the caller decides the delivery method.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadAccount,
  saveAccount,
  paperSell,
  paperCoverShort,
} from "../paper/account.js";
import { getPrice } from "../exchange/binance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─────────────────────────────────────────────────────
// Supported commands
// ─────────────────────────────────────────────────────

const SUPPORTED_COMMANDS = [
  "/profit",
  "/positions",
  "/balance",
  "/status",
  "/forcesell",
  "/help",
];

// ─────────────────────────────────────────────────────
// Type definitions
// ─────────────────────────────────────────────────────

export interface TelegramCommand {
  command: string; // "/profit"
  args: string[]; // ["BTCUSDT", "testnet-default"]
  rawText: string;
}

// ─────────────────────────────────────────────────────
// Price fetching (overridable in tests)
// ─────────────────────────────────────────────────────

type PriceFetcher = (symbol: string) => Promise<number | null>;

let _priceFetcher: PriceFetcher = defaultFetchPrice;

/** For testing only: replace the price fetcher function */
export function _setPriceFetcher(fn: PriceFetcher): void {
  _priceFetcher = fn;
}

/** Reset to default price fetcher function */
export function _resetPriceFetcher(): void {
  _priceFetcher = defaultFetchPrice;
}

function defaultFetchPrice(symbol: string): Promise<number | null> {
  return getPrice(symbol).catch(() => null);
}

// ─────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────

/** Scan logs directory and return all scenario ID list */
function listScenarioIds(logsDir: string): string[] {
  try {
    const files = fs.readdirSync(logsDir);
    return files
      .filter((f) => f.startsWith("paper-") && f.endsWith(".json"))
      .map((f) => f.slice("paper-".length, -".json".length));
  } catch {
    return [];
  }
}

/** Format holding time (ms to human-readable string) */
function formatHoldTime(entryTime: number): string {
  const ms = Date.now() - entryTime;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** Format signed amount: +$1.23 or -$1.23 */
function fmtPnl(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** Format signed percentage: +2.30% or -1.50% */
function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────
// parseCommand
// ─────────────────────────────────────────────────────

/**
 * Parse message text into a command.
 * Returns null if not starting with "/" or not in the supported list.
 * Command names are case-insensitive.
 */
export function parseCommand(text: string): TelegramCommand | null {
  if (!text.startsWith("/")) return null;

  const parts = text.trim().split(/\s+/);
  const rawCmd = parts[0];
  if (!rawCmd) return null;

  const cmd = rawCmd.toLowerCase();
  if (!SUPPORTED_COMMANDS.includes(cmd)) return null;

  return {
    command: cmd,
    args: parts.slice(1),
    rawText: text,
  };
}

// ─────────────────────────────────────────────────────
// handleCommand — command dispatch
// ─────────────────────────────────────────────────────

/**
 * Handle a parsed command, return Markdown formatted response text.
 * Does not send messages directly.
 */
export async function handleCommand(
  cmd: TelegramCommand,
  logsDir?: string
): Promise<string> {
  const dir = logsDir ?? DEFAULT_LOGS_DIR;

  switch (cmd.command) {
    case "/profit":
      return handleProfit(dir);
    case "/positions":
      return handlePositions(dir);
    case "/balance":
      return handleBalance(dir);
    case "/status":
      return handleStatus(dir);
    case "/forcesell":
      return handleForceSell(cmd.args, dir);
    case "/help":
      return handleHelp();
    default:
      return "❓ Unknown command. Send /help to see the command list.";
  }
}

// ─────────────────────────────────────────────────────
// /help
// ─────────────────────────────────────────────────────

export function handleHelp(): string {
  return (
    `📖 *Command List*\n\n` +
    `/profit — Total PnL across all scenarios (unrealized + realized)\n` +
    `/positions — Current position details\n` +
    `/balance — USDT balance per scenario\n` +
    `/status — System status (uptime, signal dedup)\n` +
    `/forcesell <symbol> [scenarioId] — Force close position\n` +
    `/help — Show this help`
  );
}

// ─────────────────────────────────────────────────────
// /balance
// ─────────────────────────────────────────────────────

export function handleBalance(logsDir: string): string {
  const scenarios = listScenarioIds(logsDir);
  if (scenarios.length === 0) return "💰 *USDT Balance*\n\nNo data available";

  const lines = ["💰 *USDT Balance*", ""];
  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);
    lines.push(`${scenarioId}：$${account.usdt.toFixed(2)}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// /profit
// ─────────────────────────────────────────────────────

export function handleProfit(logsDir: string): string {
  const scenarios = listScenarioIds(logsDir);
  if (scenarios.length === 0) return "📊 *Profit Summary*\n\nNo data available";

  let totalRealizedPnl = 0;
  const lines = ["📊 *Profit Summary*", ""];

  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);

    // Realized PnL: sum of pnl from sell / cover trades
    const realized = account.trades
      .filter(
        (t) =>
          (t.side === "sell" || t.side === "cover") && t.pnl !== undefined
      )
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    // Total equity (estimate position value at entry price, no real-time price)
    let positionValue = 0;
    for (const pos of Object.values(account.positions)) {
      if (pos.side === "short") {
        const margin = pos.marginUsdt ?? pos.quantity * pos.entryPrice;
        positionValue += margin;
      } else {
        positionValue += pos.quantity * pos.entryPrice;
      }
    }
    const totalEquity = account.usdt + positionValue;
    const totalPnl = totalEquity - account.initialUsdt;
    const totalPnlPct =
      account.initialUsdt > 0 ? (totalPnl / account.initialUsdt) * 100 : 0;

    totalRealizedPnl += realized;

    lines.push(
      `${scenarioId}：$${totalEquity.toFixed(2)} (${fmtPct(totalPnlPct)})`
    );
  }

  lines.push("");
  lines.push(`*Realized PnL: ${fmtPnl(totalRealizedPnl)}*`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// /positions
// ─────────────────────────────────────────────────────

export function handlePositions(logsDir: string): string {
  const scenarios = listScenarioIds(logsDir);

  const lines: string[] = [];
  let hasAnyPosition = false;

  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);
    const posEntries = Object.values(account.positions);
    if (posEntries.length === 0) continue;

    hasAnyPosition = true;
    lines.push(`📋 *Current Positions* (${scenarioId})`);
    lines.push("");

    for (const pos of posEntries) {
      const holdTime = formatHoldTime(pos.entryTime);
      const side = pos.side === "short" ? "Short" : "Long";
      const entryFmt = `$${pos.entryPrice.toFixed(4)}`;
      lines.push(
        `• ${pos.symbol} ${entryFmt} (${side}) | Held ${holdTime}`
      );
    }
    lines.push("");
  }

  if (!hasAnyPosition) {
    return "📋 *Current Positions*\n\nNo positions";
  }

  return lines.join("\n").trimEnd();
}

// ─────────────────────────────────────────────────────
// /status
// ─────────────────────────────────────────────────────

export function handleStatus(logsDir: string): string {
  const lines = ["⚙️ *System Status*", ""];

  // Signal dedup status
  const dedupPath = path.join(logsDir, "signal-notify-dedup.json");
  try {
    const raw = fs.readFileSync(dedupPath, "utf-8");
    const dedup = JSON.parse(raw) as Record<string, number>;
    const keys = Object.keys(dedup);
    lines.push(`📡 *Signal Dedup (signal-notify-dedup)*`);
    if (keys.length === 0) {
      lines.push("  No dedup records");
    } else {
      const displayKeys = keys.slice(0, 8);
      for (const key of displayKeys) {
        const ts = dedup[key];
        const ago = ts !== undefined
          ? `${Math.round((Date.now() - ts) / 60_000)}min ago`
          : "unknown";
        lines.push(`  ${key}：${ago}`);
      }
      if (keys.length > 8) {
        lines.push(`  ...total ${keys.length} entries`);
      }
    }
  } catch {
    lines.push("📡 *Signal Dedup (signal-notify-dedup)*: No data");
  }

  lines.push("");

  // Scenario list
  const scenarios = listScenarioIds(logsDir);
  lines.push(`📂 *Scenario Count*: ${scenarios.length}`);
  if (scenarios.length > 0) {
    const preview = scenarios.slice(0, 5).join(", ");
    const suffix = scenarios.length > 5 ? "..." : "";
    lines.push(`  ${preview}${suffix}`);
  }

  // Live-monitor log last modified time
  const liveLogPath = path.join(logsDir, "live-monitor.log");
  try {
    const stat = fs.statSync(liveLogPath);
    const agoMin = Math.round((Date.now() - stat.mtimeMs) / 60_000);
    const statusStr =
      agoMin < 5 ? "Running" : `Last active ${String(agoMin)}min ago`;
    lines.push(`\n🏃 *live-monitor*: ${statusStr}`);
  } catch {
    lines.push("\n🏃 *live-monitor*: Unknown");
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// /forcesell
// ─────────────────────────────────────────────────────

export async function handleForceSell(
  args: string[],
  logsDir: string
): Promise<string> {
  const symbol = args[0];
  if (!symbol) {
    return "❌ Usage: `/forcesell <symbol> [scenarioId]`\nExample: `/forcesell BTCUSDT testnet-default`";
  }

  const symbolUpper = symbol.toUpperCase();
  const targetScenarioId = args[1] ?? null;

  // Find the scenario containing this position
  let foundScenarioId: string | null = null;

  if (targetScenarioId !== null) {
    const account = loadAccount(1000, targetScenarioId);
    if (account.positions[symbolUpper]) {
      foundScenarioId = targetScenarioId;
    }
  } else {
    const scenarios = listScenarioIds(logsDir);
    for (const sid of scenarios) {
      const account = loadAccount(1000, sid);
      if (account.positions[symbolUpper]) {
        foundScenarioId = sid;
        break;
      }
    }
  }

  if (foundScenarioId === null) {
    return `❌ Position not found: ${symbolUpper}${targetScenarioId !== null ? ` (${targetScenarioId})` : ""}`;
  }

  // Get current price
  const price = await _priceFetcher(symbolUpper);

  const account = loadAccount(1000, foundScenarioId);
  const pos = account.positions[symbolUpper];

  if (!pos) {
    return `❌ Position not found: ${symbolUpper} (${foundScenarioId})`;
  }

  const execPrice = price ?? pos.entryPrice;
  const priceSource = price !== null ? "Real-time price" : "Entry price (fetch failed)";

  let trade: ReturnType<typeof paperSell>  ;

  if (pos.side === "short") {
    trade = paperCoverShort(account, symbolUpper, execPrice, "telegram_forcesell");
  } else {
    trade = paperSell(account, symbolUpper, execPrice, "telegram_forcesell");
  }

  if (!trade) {
    return `❌ Close position failed: ${symbolUpper}`;
  }

  saveAccount(account, foundScenarioId);

  const pnl = trade.pnl ?? 0;
  const pnlPct = (trade.pnlPercent ?? 0) * 100;

  return (
    `✅ *Force Close Successful*\n\n` +
    `• Symbol: ${symbolUpper}\n` +
    `• Scenario: ${foundScenarioId}\n` +
    `• Fill Price: $${execPrice.toFixed(4)} (${priceSource})\n` +
    `• PnL: ${fmtPnl(pnl)} (${fmtPct(pnlPct)})\n` +
    `• Account Balance: $${account.usdt.toFixed(2)}`
  );
}

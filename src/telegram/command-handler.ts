/**
 * Telegram 交互式命令处理器（P7.3）
 *
 * 解析并处理来自主人的命令，返回 Markdown 格式响应文本。
 * 不直接发送消息，由调用方决定发送方式。
 */

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import {
  loadAccount,
  saveAccount,
  paperSell,
  paperCoverShort,
} from "../paper/account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─────────────────────────────────────────────────────
// 支持的命令列表
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
// 类型定义
// ─────────────────────────────────────────────────────

export interface TelegramCommand {
  command: string; // "/profit"
  args: string[]; // ["BTCUSDT", "testnet-default"]
  rawText: string;
}

// ─────────────────────────────────────────────────────
// 价格获取（可在测试中覆盖）
// ─────────────────────────────────────────────────────

type PriceFetcher = (symbol: string) => Promise<number | null>;

let _priceFetcher: PriceFetcher = defaultFetchPrice;

/** 仅供测试使用：替换价格获取函数 */
export function _setPriceFetcher(fn: PriceFetcher): void {
  _priceFetcher = fn;
}

/** 重置为默认价格获取函数 */
export function _resetPriceFetcher(): void {
  _priceFetcher = defaultFetchPrice;
}

function defaultFetchPrice(symbol: string): Promise<number | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.binance.com",
      path: `/api/v3/ticker/price?symbol=${symbol}`,
      method: "GET",
      agent: new https.Agent({ family: 4 }),
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as { price: string };
          resolve(parseFloat(parsed.price));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// ─────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────

/** 扫描 logs 目录，返回所有 scenario ID 列表 */
function listScenarioIds(logsDir: string): string[] {
  try {
    const files = fs.readdirSync(logsDir) as string[];
    return files
      .filter((f) => f.startsWith("paper-") && f.endsWith(".json"))
      .map((f) => f.slice("paper-".length, -".json".length));
  } catch {
    return [];
  }
}

/** 格式化持仓时间（ms 转可读字符串） */
function formatHoldTime(entryTime: number): string {
  const ms = Date.now() - entryTime;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** 格式化带符号的金额：+$1.23 或 -$1.23 */
function fmtPnl(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** 格式化带符号的百分比：+2.30% 或 -1.50% */
function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────
// parseCommand
// ─────────────────────────────────────────────────────

/**
 * 解析消息文本为命令。
 * 若不是 "/" 开头，或不在支持列表中，返回 null。
 * 命令名称不区分大小写。
 */
export function parseCommand(text: string): TelegramCommand | null {
  if (!text || !text.startsWith("/")) return null;

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
// handleCommand — 命令分发
// ─────────────────────────────────────────────────────

/**
 * 处理已解析的命令，返回 Markdown 格式响应文本。
 * 不直接发送消息。
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
      return "❓ 未知命令，请发送 /help 查看命令列表。";
  }
}

// ─────────────────────────────────────────────────────
// /help
// ─────────────────────────────────────────────────────

export function handleHelp(): string {
  return (
    `📖 *命令列表*\n\n` +
    `/profit — 所有 scenario 总盈亏（未实现+已实现）\n` +
    `/positions — 当前所有持仓详情\n` +
    `/balance — 各 scenario USDT 余额\n` +
    `/status — 系统状态（运行时间、信号去重）\n` +
    `/forcesell <symbol> [scenarioId] — 强制平仓\n` +
    `/help — 显示本帮助`
  );
}

// ─────────────────────────────────────────────────────
// /balance
// ─────────────────────────────────────────────────────

export async function handleBalance(logsDir: string): Promise<string> {
  const scenarios = listScenarioIds(logsDir);
  if (scenarios.length === 0) return "💰 *USDT 余额*\n\n暂无数据";

  const lines = ["💰 *USDT 余额*", ""];
  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);
    lines.push(`${scenarioId}：$${account.usdt.toFixed(2)}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// /profit
// ─────────────────────────────────────────────────────

export async function handleProfit(logsDir: string): Promise<string> {
  const scenarios = listScenarioIds(logsDir);
  if (scenarios.length === 0) return "📊 *收益汇总*\n\n暂无数据";

  let totalRealizedPnl = 0;
  const lines = ["📊 *收益汇总*", ""];

  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);

    // 已实现 PnL：sell / cover 交易的 pnl 累加
    const realized = account.trades
      .filter(
        (t) =>
          (t.side === "sell" || t.side === "cover") && t.pnl !== undefined
      )
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    // 总资产（以入场价估算持仓价值，无实时价格）
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
  lines.push(`*已实现 PnL：${fmtPnl(totalRealizedPnl)}*`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// /positions
// ─────────────────────────────────────────────────────

export async function handlePositions(logsDir: string): Promise<string> {
  const scenarios = listScenarioIds(logsDir);

  const lines: string[] = [];
  let hasAnyPosition = false;

  for (const scenarioId of scenarios) {
    const account = loadAccount(1000, scenarioId);
    const posEntries = Object.values(account.positions);
    if (posEntries.length === 0) continue;

    hasAnyPosition = true;
    lines.push(`📋 *当前持仓* (${scenarioId})`);
    lines.push("");

    for (const pos of posEntries) {
      const holdTime = formatHoldTime(pos.entryTime);
      const side = pos.side === "short" ? "空头" : "多头";
      const entryFmt = `$${pos.entryPrice.toFixed(4)}`;
      lines.push(
        `• ${pos.symbol} ${entryFmt} (${side}) | 持仓 ${holdTime}`
      );
    }
    lines.push("");
  }

  if (!hasAnyPosition) {
    return "📋 *当前持仓*\n\n当前无持仓";
  }

  return lines.join("\n").trimEnd();
}

// ─────────────────────────────────────────────────────
// /status
// ─────────────────────────────────────────────────────

export async function handleStatus(logsDir: string): Promise<string> {
  const lines = ["⚙️ *系统状态*", ""];

  // 信号去重状态
  const dedupPath = path.join(logsDir, "signal-notify-dedup.json");
  try {
    const raw = fs.readFileSync(dedupPath, "utf-8");
    const dedup = JSON.parse(raw) as Record<string, number>;
    const keys = Object.keys(dedup);
    lines.push(`📡 *信号去重 (signal-notify-dedup)*`);
    if (keys.length === 0) {
      lines.push("  无去重记录");
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
        lines.push(`  ...共 ${keys.length} 条`);
      }
    }
  } catch {
    lines.push("📡 *信号去重 (signal-notify-dedup)*：无数据");
  }

  lines.push("");

  // Scenario 列表
  const scenarios = listScenarioIds(logsDir);
  lines.push(`📂 *Scenario 数量*：${scenarios.length}`);
  if (scenarios.length > 0) {
    const preview = scenarios.slice(0, 5).join(", ");
    const suffix = scenarios.length > 5 ? "..." : "";
    lines.push(`  ${preview}${suffix}`);
  }

  // Live-monitor 日志最后修改时间
  const liveLogPath = path.join(logsDir, "live-monitor.log");
  try {
    const stat = fs.statSync(liveLogPath);
    const agoMin = Math.round((Date.now() - stat.mtimeMs) / 60_000);
    const statusStr =
      agoMin < 5 ? "运行中" : `最后活跃 ${String(agoMin)}min 前`;
    lines.push(`\n🏃 *live-monitor*：${statusStr}`);
  } catch {
    lines.push("\n🏃 *live-monitor*：未知");
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
    return "❌ 用法：`/forcesell <symbol> [scenarioId]`\n例：`/forcesell BTCUSDT testnet-default`";
  }

  const symbolUpper = symbol.toUpperCase();
  const targetScenarioId = args[1] ?? null;

  // 找到包含该持仓的 scenario
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
    return `❌ 未找到持仓：${symbolUpper}${targetScenarioId !== null ? ` (${targetScenarioId})` : ""}`;
  }

  // 获取当前价格
  const price = await _priceFetcher(symbolUpper);

  const account = loadAccount(1000, foundScenarioId);
  const pos = account.positions[symbolUpper];

  if (!pos) {
    return `❌ 未找到持仓：${symbolUpper} (${foundScenarioId})`;
  }

  const execPrice = price ?? pos.entryPrice;
  const priceSource = price !== null ? "实时价格" : "入场价（获取失败）";

  let trade: ReturnType<typeof paperSell> | ReturnType<typeof paperCoverShort>;

  if (pos.side === "short") {
    trade = paperCoverShort(account, symbolUpper, execPrice, "telegram_forcesell");
  } else {
    trade = paperSell(account, symbolUpper, execPrice, "telegram_forcesell");
  }

  if (!trade) {
    return `❌ 平仓失败：${symbolUpper}`;
  }

  saveAccount(account, foundScenarioId);

  const pnl = trade.pnl ?? 0;
  const pnlPct = (trade.pnlPercent ?? 0) * 100;

  return (
    `✅ *强制平仓成功*\n\n` +
    `• 交易对：${symbolUpper}\n` +
    `• Scenario：${foundScenarioId}\n` +
    `• 成交价：$${execPrice.toFixed(4)} (${priceSource})\n` +
    `• PnL：${fmtPnl(pnl)} (${fmtPct(pnlPct)})\n` +
    `• 账户余额：$${account.usdt.toFixed(2)}`
  );
}

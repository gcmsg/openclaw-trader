/**
 * P6.2 — Pairlist Refresh Script
 *
 * 定时拉取动态币种列表，与当前列表对比，若有变化发 Telegram 通知。
 * 用法：npx tsx src/scripts/refresh-pairlist.ts
 * 定时：通过 npm run cron:sync 注册 cron（每天凌晨 0:00）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { fetchDynamicPairlist, diffPairlist, formatPairlistReport } from "../exchange/pairlist.js";
import { ping } from "../health/heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const PAIRLIST_PATH = path.join(LOGS_DIR, "current-pairlist.json");

interface PairlistSnapshot {
  symbols: string[];
  updatedAt: number;
  pairs: {
    symbol: string;
    volume24hUsd: number;
    priceChangePercent: number;
    volatility: number;
    score: number;
  }[];
}

function loadCurrentPairlist(): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(PAIRLIST_PATH, "utf-8")) as PairlistSnapshot;
    return data.symbols;
  } catch {
    return [];
  }
}

function savePairlist(snapshot: PairlistSnapshot): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PAIRLIST_PATH, JSON.stringify(snapshot, null, 2));
}

/** 发送通知（通过 openclaw system event） */
function notify(message: string): void {
  try {
    const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
    const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", message);
    spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
  } catch {
    console.log("[notify]", message);
  }
}

async function main(): Promise<void> {
  const done = ping("pairlist_refresh");
  console.log("[pairlist] 🔄 刷新动态币种列表...");

  // 拉取最新列表
  let pairs;
  try {
    pairs = await fetchDynamicPairlist({
      minVolume24hUsd: 50_000_000,
      maxPairs: 15,
      sortBy: "volume",
      // 默认排除常见稳定币和问题代币
      blacklist: ["USDCUSDT", "BUSDUSDT", "FDUSDUSDT", "TUSDUSDT"],
      // 始终包含 BTC 和 ETH
      whitelist: ["BTCUSDT", "ETHUSDT"],
    });
  } catch (err) {
    console.error("[pairlist] ❌ 拉取失败:", err);
    process.exit(1);
  }

  const nextSymbols = pairs.map((p) => p.symbol);
  const currentSymbols = loadCurrentPairlist();
  const diff = diffPairlist(currentSymbols, nextSymbols);

  const hasChanges = diff.added.length > 0 || diff.removed.length > 0;

  if (hasChanges) {
    console.log("[pairlist] ✅ 检测到币种变化");
    const report = formatPairlistReport(pairs, diff);
    console.log(report);

    // 发 Telegram 通知
    const notifyMsg = [
      "📊 动态币种列表已更新",
      diff.added.length > 0 ? `✅ 新增: ${diff.added.join(", ")}` : "",
      diff.removed.length > 0 ? `❌ 移除: ${diff.removed.join(", ")}` : "",
      `共 ${nextSymbols.length} 个交易对`,
    ]
      .filter(Boolean)
      .join("\n");

    notify(notifyMsg);
  } else {
    console.log("[pairlist] ✅ 币种列表无变化（共", nextSymbols.length, "个）");
  }

  // 保存快照
  savePairlist({
    symbols: nextSymbols,
    updatedAt: Date.now(),
    pairs,
  });

  console.log("[pairlist] 💾 已保存至", PAIRLIST_PATH);
  done();
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error("[pairlist] Fatal:", err);
  process.exit(1);
});

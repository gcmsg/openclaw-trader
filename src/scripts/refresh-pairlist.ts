/**
 * P6.2 — Pairlist Refresh Script
 *
 * Periodically fetches the dynamic symbol list, compares with the current list,
 * and sends a Telegram notification if changes are detected.
 * Usage: npx tsx src/scripts/refresh-pairlist.ts
 * Schedule: registered via npm run cron:sync (daily at 00:00)
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

/** Send notification (via openclaw system event) */
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
  console.log("[pairlist] 🔄 Refreshing dynamic symbol list...");

  // Fetch latest list
  let pairs;
  try {
    pairs = await fetchDynamicPairlist({
      minVolume24hUsd: 50_000_000,
      maxPairs: 15,
      sortBy: "volume",
      // Exclude common stablecoins and problematic tokens (PEPE on Binance is 1000PEPEUSDT, not PEPEUSDT)
      blacklist: ["USDCUSDT", "BUSDUSDT", "FDUSDUSDT", "TUSDUSDT", "PEPEUSDT"],
      // Always include BTC and ETH
      whitelist: ["BTCUSDT", "ETHUSDT"],
    });
  } catch (err) {
    console.error("[pairlist] ❌ Fetch failed:", err);
    process.exit(1);
  }

  const nextSymbols = pairs.map((p) => p.symbol);
  const currentSymbols = loadCurrentPairlist();
  const diff = diffPairlist(currentSymbols, nextSymbols);

  const hasChanges = diff.added.length > 0 || diff.removed.length > 0;

  if (hasChanges) {
    console.log("[pairlist] ✅ Symbol changes detected");
    const report = formatPairlistReport(pairs, diff);
    console.log(report);

    // Send Telegram notification
    const notifyMsg = [
      "📊 Dynamic symbol list updated",
      diff.added.length > 0 ? `✅ Added: ${diff.added.join(", ")}` : "",
      diff.removed.length > 0 ? `❌ Removed: ${diff.removed.join(", ")}` : "",
      `Total: ${nextSymbols.length} trading pairs`,
    ]
      .filter(Boolean)
      .join("\n");

    notify(notifyMsg);
  } else {
    console.log("[pairlist] ✅ Symbol list unchanged (total", nextSymbols.length, "pairs)");
  }

  // Save snapshot
  savePairlist({
    symbols: nextSymbols,
    updatedAt: Date.now(),
    pairs,
  });

  console.log("[pairlist] 💾 Saved to", PAIRLIST_PATH);
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

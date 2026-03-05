/**
 * Emergency News Monitor
 *
 * Polls every 5 minutes, detecting high-risk keywords:
 *   - Exchange hack / asset freeze / major security vulnerability
 *   - Regulatory prosecution / exchange shutdown / country ban
 *   - Stablecoin depeg / liquidation crisis / hacker attack
 *
 * Upon detecting a high-risk event:
 *   1. Writes to logs/news-emergency.json (halt = true + reason)
 *   2. Pulls sentiment-cache score down to -10 (extremely bearish)
 *   3. Sends immediate Telegram alert
 *
 * monitor.ts checks readEmergencyHalt() before each position opening:
 *   true -> skip opening, only allow stop-loss exits
 *
 * ## Enable
 *   npm run news:emergency   # Manual trigger
 *   cron: polls every 10 minutes
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { getLatestNews } from "./fetcher.js";
import { writeSentimentCache } from "./sentiment-cache.js";
import { ping } from "../health/heartbeat.js";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMERGENCY_PATH = path.resolve(__dirname, "../../logs/news-emergency.json");

const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ─── High-Risk Keywords ───────────────────────────────────────

const EMERGENCY_KEYWORDS: string[] = [
  // Security incidents
  "hack", "hacked", "exploit", "exploited", "stolen", "stolen funds",
  "security breach", "vulnerabilit", "rug pull", "exit scam",
  // Regulatory crackdown
  "sec charges", "sec sues", "doj charges", "arrested", "seized",
  "shut down", "shutdown", "banned", "ban crypto", "illegal",
  "criminal", "indicted", "enforcement action",
  // Exchange risk
  "insolvent", "insolvency", "bankrupt", "halted withdrawals",
  "withdrawal halt", "withdrawal suspended", "frozen funds",
  // Stablecoin/Systemic risk
  "depeg", "depegged", "usdt depeg", "usdc depeg", "dai depeg",
  "systemic risk", "contagion", "cascade", "black swan",
  // Major institutions
  "binance hack", "coinbase hack", "ftx", "luna crash",
];

// ─── Types ──────────────────────────────────────────────

export interface EmergencyState {
  halt: boolean;
  triggeredAt?: number;
  expiresAt?: number;       // Auto-expiry time (default 2 hours later)
  reason?: string;
  keywords: string[];
  source?: string;
  autoCleared?: boolean;
  /** Article URLs that have triggered halt -> expiry timestamp (24h), prevents same article from triggering repeatedly */
  seenUrls?: Record<string, number>;
}

// ─── File IO ──────────────────────────────────────────

export function readEmergencyHalt(): EmergencyState {
  try {
    const state = JSON.parse(fs.readFileSync(EMERGENCY_PATH, "utf-8")) as EmergencyState;
    // Check if expired (default 2-hour auto-clear)
    if (state.halt && state.expiresAt && Date.now() > state.expiresAt) {
      const cleared = { ...state, halt: false, autoCleared: true };
      fs.writeFileSync(EMERGENCY_PATH, JSON.stringify(cleared, null, 2));
      return cleared;
    }
    return state;
  } catch {
    return { halt: false, keywords: [] };
  }
}

export function writeEmergencyHalt(reason: string, keywords: string[], source?: string): void {
  // Read existing seenUrls (persisted across halt cycles, prevents same article from triggering repeatedly)
  let seenUrls: Record<string, number> = {};
  try {
    const existing = JSON.parse(fs.readFileSync(EMERGENCY_PATH, "utf-8")) as EmergencyState;
    if (existing.seenUrls) seenUrls = existing.seenUrls;
  } catch { /* First trigger, no history */ }

  // Record the triggering article URL with 24h cooldown
  if (source) seenUrls[source] = Date.now() + 24 * 3_600_000;

  // Clean up expired seenUrls
  const now = Date.now();
  for (const url of Object.keys(seenUrls)) {
    if ((seenUrls[url] ?? 0) < now) delete seenUrls[url];
  }

  const state: EmergencyState = {
    halt: true,
    triggeredAt: Date.now(),
    expiresAt: Date.now() + 2 * 3_600_000, // Auto-clear after 2 hours
    reason,
    keywords,
    seenUrls,
    ...(source !== undefined ? { source } : {}),
  };
  fs.mkdirSync(path.dirname(EMERGENCY_PATH), { recursive: true });
  fs.writeFileSync(EMERGENCY_PATH, JSON.stringify(state, null, 2));
}

export function clearEmergencyHalt(): void {
  const state = readEmergencyHalt();
  fs.writeFileSync(EMERGENCY_PATH, JSON.stringify({ ...state, halt: false }, null, 2));
}

// ─── Keyword Scanning ───────────────────────────────────────

export function scanEmergencyKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.filter((kw) => lower.includes(kw));
}

// ─── Notification ─────────────────────────────────────────────

const log = createLogger("emergency", path.resolve(__dirname, "../../logs/news-monitor.log"));

function sendAlert(message: string): void {
  try {
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", message);
    spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15_000 });
  } catch { /* Notification failure does not affect main flow */ }
}

// ─── Main Check Logic ───────────────────────────────────────

export interface EmergencyCheckResult {
  halt: boolean;
  triggered: boolean;     // Newly triggered this time (not pre-existing halt)
  matchedKeywords: string[];
  newsTitle?: string;
}

export async function checkEmergencyNews(): Promise<EmergencyCheckResult> {
  // Check existing halt state (may have expired)
  const existing = readEmergencyHalt();
  if (existing.halt) {
    log.info(`⛔ Emergency halt still active: ${existing.reason}`);
    return { halt: true, triggered: false, matchedKeywords: existing.keywords };
  }

  // Fetch latest news (most recent 30 items)
  let news: { title: string; url?: string; important?: boolean }[];
  try {
    news = await getLatestNews(30);
  } catch (err: unknown) {
    log.warn(`⚠️ News fetch failed: ${String(err)}`);
    return { halt: false, triggered: false, matchedKeywords: [] };
  }

  // Only scan news marked as important (reduce false positives)
  const importantNews = news.filter((n) => n.important);
  const scanTargets = importantNews.length > 0 ? importantNews : news.slice(0, 10);

  // Read seen URL cooldown table (persisted across halt cycles, prevents same article from triggering repeatedly)
  const seenUrls: Record<string, number> = existing.seenUrls ?? {};
  const nowMs = Date.now();

  for (const item of scanTargets) {
    // If this article URL has triggered halt within 24h cooldown, skip
    if (item.url && seenUrls[item.url] !== undefined && (seenUrls[item.url] ?? 0) > nowMs) {
      log.info(`⏭ Skipping previously triggered article (24h cooldown): ${item.title.slice(0, 60)}`);
      continue;
    }
    const matched = scanEmergencyKeywords(item.title);
    if (matched.length >= 2) {  // At least 2 keywords required to trigger (reduce false positives)
      const reason = `Emergency high-risk event: ${item.title}`;
      log.warn(`🚨 Emergency keyword match: ${matched.join(", ")} | ${item.title}`);

      // 1. Write halt state
      writeEmergencyHalt(reason, matched, item.url);

      // 2. Pull down sentiment cache (extremely bearish)
      writeSentimentCache({
        score: -10,
        label: "very_bearish",
        bearishReasons: [reason],
        headlineCount: 1,
        analyzedBy: "emergency-monitor",
      });

      // 3. Immediate alert
      const alert = [
        `🚨 **[Emergency Alert] High-risk news detected!**`,
        ``,
        `📰 Title: ${item.title}`,
        `🔑 Matched keywords: ${matched.join(", ")}`,
        ``,
        `⛔ **All entry signals auto-paused (2 hours)**`,
        `If confirmed false positive, run: \`npm run news:clear-halt\` to clear`,
      ].join("\n");
      sendAlert(alert);

      return { halt: true, triggered: true, matchedKeywords: matched, newsTitle: item.title };
    }
  }

  log.info(`✅ No high-risk news (scanned ${scanTargets.length} items)`);
  return { halt: false, triggered: false, matchedKeywords: [] };
}

// ─── CLI Entry Point ─────────────────────────────────────────

if (process.argv[1]?.includes("emergency-monitor")) {
  const taskName = "news_emergency";
  const done = ping(taskName);
  log.info("── Emergency news monitoring started ──");
  checkEmergencyNews()
    .then((result) => {
      if (result.triggered) {
        log.warn(`🚨 Emergency halt triggered! Keywords: ${result.matchedKeywords.join(", ")}`);
      } else if (result.halt) {
        log.info("⛔ Emergency halt still active");
      } else {
        log.info("✅ No anomalies");
      }
      done();
    })
    .catch((err: unknown) => {
      const msg = String(err);
      log.error(`❌ Fatal: ${msg}`);
      done(msg);
      process.exit(1);
    });
}

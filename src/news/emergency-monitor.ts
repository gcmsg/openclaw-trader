/**
 * 突发新闻监控（Emergency News Monitor）
 *
 * 每 5 分钟轮询一次，检测高危关键词：
 *   - 交易所 hack / 资产冻结 / 重大安全漏洞
 *   - 监管机构起诉 / 交易所被关闭 / 国家禁令
 *   - 稳定币脱锚 / 清算危机 / 黑客攻击
 *
 * 检测到高危事件后：
 *   1. 写入 logs/news-emergency.json（halt = true + 原因）
 *   2. 将 sentiment-cache 分数拉到 -10（极度利空）
 *   3. 发送立即 Telegram 告警
 *
 * monitor.ts 在每次开仓前检查 readEmergencyHalt()：
 *   true → 跳过开仓，只允许止损平仓
 *
 * ## 启用
 *   npm run news:emergency   # 手动触发
 *   cron: 每10分钟轮询一次
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

// ─── 高危关键词 ───────────────────────────────────────

const EMERGENCY_KEYWORDS: string[] = [
  // 安全事件
  "hack", "hacked", "exploit", "exploited", "stolen", "stolen funds",
  "security breach", "vulnerabilit", "rug pull", "exit scam",
  // 监管打击
  "sec charges", "sec sues", "doj charges", "arrested", "seized",
  "shut down", "shutdown", "banned", "ban crypto", "illegal",
  "criminal", "indicted", "enforcement action",
  // 交易所风险
  "insolvent", "insolvency", "bankrupt", "halted withdrawals",
  "withdrawal halt", "withdrawal suspended", "frozen funds",
  // 稳定币/系统性风险
  "depeg", "depegged", "usdt depeg", "usdc depeg", "dai depeg",
  "systemic risk", "contagion", "cascade", "black swan",
  // 主要机构
  "binance hack", "coinbase hack", "ftx", "luna crash",
];

// ─── 类型 ──────────────────────────────────────────────

export interface EmergencyState {
  halt: boolean;
  triggeredAt?: number;
  expiresAt?: number;       // 自动过期时间（默认 2 小时后）
  reason?: string;
  keywords: string[];
  source?: string;
  autoCleared?: boolean;
  /** 已触发过 halt 的文章 URL → 过期时间戳（24h），防止同一文章循环触发 */
  seenUrls?: Record<string, number>;
}

// ─── 文件 IO ──────────────────────────────────────────

export function readEmergencyHalt(): EmergencyState {
  try {
    const state = JSON.parse(fs.readFileSync(EMERGENCY_PATH, "utf-8")) as EmergencyState;
    // 检查是否已过期（默认 2 小时自动解除）
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
  // 读取现有 seenUrls（跨 halt 周期持久化，防止同一文章循环触发）
  let seenUrls: Record<string, number> = {};
  try {
    const existing = JSON.parse(fs.readFileSync(EMERGENCY_PATH, "utf-8")) as EmergencyState;
    if (existing.seenUrls) seenUrls = existing.seenUrls;
  } catch { /* 首次触发，无历史 */ }

  // 将触发文章的 URL 记录为 24h 冷却
  if (source) seenUrls[source] = Date.now() + 24 * 3_600_000;

  // 清理过期 seenUrls
  const now = Date.now();
  for (const url of Object.keys(seenUrls)) {
    if ((seenUrls[url] ?? 0) < now) delete seenUrls[url];
  }

  const state: EmergencyState = {
    halt: true,
    triggeredAt: Date.now(),
    expiresAt: Date.now() + 2 * 3_600_000, // 2 小时后自动解除
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

// ─── 关键词扫描 ───────────────────────────────────────

export function scanEmergencyKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.filter((kw) => lower.includes(kw));
}

// ─── 通知 ─────────────────────────────────────────────

const log = createLogger("emergency", path.resolve(__dirname, "../../logs/news-monitor.log"));

function sendAlert(message: string): void {
  try {
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", message);
    spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15_000 });
  } catch { /* 通知失败不影响主流程 */ }
}

// ─── 主检查逻辑 ───────────────────────────────────────

export interface EmergencyCheckResult {
  halt: boolean;
  triggered: boolean;     // 本次新触发（非已有 halt）
  matchedKeywords: string[];
  newsTitle?: string;
}

export async function checkEmergencyNews(): Promise<EmergencyCheckResult> {
  // 检查现有 halt 状态（可能已过期）
  const existing = readEmergencyHalt();
  if (existing.halt) {
    log.info(`⛔ 紧急暂停仍然有效：${existing.reason}`);
    return { halt: true, triggered: false, matchedKeywords: existing.keywords };
  }

  // 拉取最新新闻（最近 30 条）
  let news: { title: string; url?: string; important?: boolean }[];
  try {
    news = await getLatestNews(30);
  } catch (err: unknown) {
    log.warn(`⚠️ 新闻拉取失败：${String(err)}`);
    return { halt: false, triggered: false, matchedKeywords: [] };
  }

  // 只扫描 important 标记的新闻（减少误报）
  const importantNews = news.filter((n) => n.important);
  const scanTargets = importantNews.length > 0 ? importantNews : news.slice(0, 10);

  // 读取已见 URL 冷却表（持续跨 halt 周期，防止同一文章循环触发）
  const seenUrls: Record<string, number> = existing.seenUrls ?? {};
  const nowMs = Date.now();

  for (const item of scanTargets) {
    // 如果该文章 URL 在 24h 冷却内已触发过 halt，跳过
    if (item.url && seenUrls[item.url] !== undefined && (seenUrls[item.url] ?? 0) > nowMs) {
      log.info(`⏭ 跳过已触发过的文章（24h 冷却）：${item.title.slice(0, 60)}`);
      continue;
    }
    const matched = scanEmergencyKeywords(item.title);
    if (matched.length >= 2) {  // 至少 2 个关键词才触发（减少误报）
      const reason = `突发高危事件：${item.title}`;
      log.warn(`🚨 紧急关键词匹配：${matched.join(", ")} | ${item.title}`);

      // 1. 写入 halt 状态
      writeEmergencyHalt(reason, matched, item.url);

      // 2. 拉低情绪缓存（极度利空）
      writeSentimentCache({
        score: -10,
        label: "very_bearish",
        bearishReasons: [reason],
        headlineCount: 1,
        analyzedBy: "emergency-monitor",
      });

      // 3. 立即告警
      const alert = [
        `🚨 **[紧急告警] 突发高危新闻检测！**`,
        ``,
        `📰 标题：${item.title}`,
        `🔑 匹配关键词：${matched.join("、")}`,
        ``,
        `⛔ **已自动暂停所有开仓信号（2小时）**`,
        `如确认为误报，执行：\`npm run news:clear-halt\` 解除`,
      ].join("\n");
      sendAlert(alert);

      return { halt: true, triggered: true, matchedKeywords: matched, newsTitle: item.title };
    }
  }

  log.info(`✅ 无高危新闻（扫描 ${scanTargets.length} 条）`);
  return { halt: false, triggered: false, matchedKeywords: [] };
}

// ─── CLI 入口 ─────────────────────────────────────────

if (process.argv[1]?.includes("emergency-monitor")) {
  const taskName = "news_emergency";
  const done = ping(taskName);
  log.info("── 突发新闻监控开始 ──");
  checkEmergencyNews()
    .then((result) => {
      if (result.triggered) {
        log.warn(`🚨 触发紧急暂停！关键词：${result.matchedKeywords.join(", ")}`);
      } else if (result.halt) {
        log.info("⛔ 紧急暂停仍有效");
      } else {
        log.info("✅ 无异常");
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

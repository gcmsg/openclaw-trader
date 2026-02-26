/**
 * P6.4 — 期权市场信号
 *
 * 数据源：Deribit 公开 API（无需 Key）
 * GET https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 *
 * 提取：
 *   - iv30d: 近月合约隐含波动率（近似30天IV）
 *   - ivPercentile: IV 在近90天的百分位（由于 Deribit API 无历史 IV，使用当前IV粗估）
 *   - putCallRatio: 所有到期合约的 Put/Call 未平仓量之比
 *
 * 信号分类：
 *   ivSignal:  low(<30) / normal(30-60) / elevated(60-90) / extreme(>90)
 *   pcSignal:  bullish(<0.7) / neutral(0.7-1.2) / bearish(>1.2)
 *   positionSizeMultiplier: extreme→0.5, elevated→0.7, normal→1.0, low→1.2
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 强制 IPv4（服务器 IPv6 不可达时）
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_CACHE_PATH = path.resolve(__dirname, "../../logs/options-cache.json");
const OPTIONS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 小时

// ─── 类型定义 ──────────────────────────────────────────

export interface OptionsSummary {
  symbol: "BTC" | "ETH";
  iv30d: number;              // 近月合约隐含波动率（百分比，如 65.3 表示 65.3%）
  ivPercentile: number;       // IV 在过去 90 天的百分位估算（0-100）
  putCallRatio: number;       // Put 未平仓合约 / Call 未平仓合约
  ivSignal: "low" | "normal" | "elevated" | "extreme";
  pcSignal: "bullish" | "neutral" | "bearish";
  positionSizeMultiplier: number; // 仓位建议系数
  generatedAt: number;
}

interface DeribitOptionItem {
  instrument_name: string;
  open_interest: number;
  mark_iv: number;
  expiration_timestamp?: number;
  // 字段较多，只取用需要的
}

interface DeribitApiResponse {
  result: DeribitOptionItem[];
}

// ─── IV 分级逻辑 ──────────────────────────────────────────

export function classifyIvSignal(iv: number): OptionsSummary["ivSignal"] {
  if (iv < 30) return "low";
  if (iv < 60) return "normal";
  if (iv < 90) return "elevated";
  return "extreme";
}

export function classifyPcSignal(pcr: number): OptionsSummary["pcSignal"] {
  if (pcr < 0.7) return "bullish";
  if (pcr <= 1.2) return "neutral";
  return "bearish";
}

export function calcPositionSizeMultiplier(ivSignal: OptionsSummary["ivSignal"]): number {
  switch (ivSignal) {
    case "extreme":  return 0.5;
    case "elevated": return 0.7;
    case "normal":   return 1.0;
    case "low":      return 1.2;
  }
}

/**
 * 粗估 IV 百分位：基于当前IV，与历史常见区间对比估算
 * （由于无历史数据，使用线性插值：30=10th, 60=50th, 90=90th, 120=99th）
 */
export function estimateIvPercentile(iv: number): number {
  if (iv <= 20) return 5;
  if (iv <= 30) return 10 + ((iv - 20) / 10) * 15;   // 10-25
  if (iv <= 60) return 25 + ((iv - 30) / 30) * 40;   // 25-65
  if (iv <= 90) return 65 + ((iv - 60) / 30) * 25;   // 65-90
  if (iv <= 120) return 90 + ((iv - 90) / 30) * 9;   // 90-99
  return 99;
}

// ─── Deribit HTTP 请求 ──────────────────────────────────

function fetchDeribitOptions(currency: "BTC" | "ETH"): Promise<DeribitOptionItem[]> {
  return new Promise((resolve, reject) => {
    const hostname = "www.deribit.com";
    const path = `/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const req = https.request(
      {
        hostname,
        path,
        method: "GET",
        agent: ipv4Agent,
        headers: { "User-Agent": "curl/7.88", "Accept": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as DeribitApiResponse;
            resolve(parsed.result);
          } catch (e) {
            reject(new Error(`Deribit parse error: ${String(e)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Deribit timeout")); });
    req.end();
  });
}

// ─── 核心逻辑 ──────────────────────────────────────────

/**
 * 从 Deribit API 获取 BTC/ETH 期权市场数据，提取 IV 和 PCR
 */
export async function fetchOptionsSummary(symbol: "BTC" | "ETH"): Promise<OptionsSummary> {
  const items = await fetchDeribitOptions(symbol);

  if (items.length === 0) {
    throw new Error(`Deribit returned empty data for ${symbol}`);
  }

  // 分离 Put 和 Call
  const puts: DeribitOptionItem[] = [];
  const calls: DeribitOptionItem[] = [];

  for (const item of items) {
    const name = item.instrument_name;
    if (name.endsWith("-P")) {
      puts.push(item);
    } else if (name.endsWith("-C")) {
      calls.push(item);
    }
  }

  // PCR = sum(put OI) / sum(call OI)
  const totalPutOI = puts.reduce((sum, p) => sum + p.open_interest, 0);
  const totalCallOI = calls.reduce((sum, c) => sum + c.open_interest, 0);
  const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 1.0;

  // 近月合约 IV（到期日最近的合约，mark_iv > 0）
  // 使用 expiration_timestamp 排序找最近到期合约
  const now = Date.now();
  const validItems = items.filter(
    (item) =>
      typeof item.mark_iv === "number" &&
      item.mark_iv > 0 &&
      (item.expiration_timestamp === undefined || item.expiration_timestamp > now)
  );

  let iv30d = 0;
  if (validItems.length > 0) {
    // 按到期时间升序排列（无 expiration_timestamp 的排在后面）
    const sorted = [...validItems].sort((a, b) => {
      const ta = a.expiration_timestamp ?? Infinity;
      const tb = b.expiration_timestamp ?? Infinity;
      return ta - tb;
    });

    // 取最近到期合约的中位数 IV（避免单合约异常）
    const nearExpiry = sorted[0]?.expiration_timestamp;
    const nearContracts = sorted.filter(
      (i) => i.expiration_timestamp === nearExpiry || nearExpiry === undefined
    );
    const ivValues = nearContracts.map((i) => i.mark_iv).sort((a, b) => a - b);
    const mid = Math.floor(ivValues.length / 2);
    iv30d = ivValues[mid] ?? ivValues[0] ?? 0;
  }

  if (iv30d === 0) {
    // 降级：取所有合约 mark_iv 的中位数
    const allIvs = validItems.map((i) => i.mark_iv).sort((a, b) => a - b);
    const mid = Math.floor(allIvs.length / 2);
    iv30d = allIvs[mid] ?? 50; // 默认50%（正常水平）
  }

  const ivSignal = classifyIvSignal(iv30d);
  const pcSignal = classifyPcSignal(putCallRatio);
  const positionSizeMultiplier = calcPositionSizeMultiplier(ivSignal);
  const ivPercentile = estimateIvPercentile(iv30d);

  return {
    symbol,
    iv30d: Math.round(iv30d * 10) / 10,
    ivPercentile: Math.round(ivPercentile),
    putCallRatio: Math.round(putCallRatio * 100) / 100,
    ivSignal,
    pcSignal,
    positionSizeMultiplier,
    generatedAt: Date.now(),
  };
}

// ─── 缓存读写 ──────────────────────────────────────────

interface OptionsCache {
  BTC?: OptionsSummary;
  ETH?: OptionsSummary;
}

export function readOptionsCache(): OptionsCache {
  try {
    const raw = fs.readFileSync(OPTIONS_CACHE_PATH, "utf-8");
    return JSON.parse(raw) as OptionsCache;
  } catch {
    return {};
  }
}

export function writeOptionsCache(summary: OptionsSummary): void {
  try {
    fs.mkdirSync(path.dirname(OPTIONS_CACHE_PATH), { recursive: true });
    const existing = readOptionsCache();
    existing[summary.symbol] = summary;
    fs.writeFileSync(OPTIONS_CACHE_PATH, JSON.stringify(existing, null, 2));
  } catch { /* 写入失败静默跳过 */ }
}

export function getCachedOptionsSummary(symbol: "BTC" | "ETH"): OptionsSummary | null {
  const cache = readOptionsCache();
  const entry = cache[symbol];
  if (!entry) return null;
  if (Date.now() - entry.generatedAt > OPTIONS_CACHE_TTL_MS) return null;
  return entry;
}

// ─── 格式化报告 ──────────────────────────────────────────

export function formatOptionsReport(summary: OptionsSummary): string {
  const ivEmoji = {
    low:      "🟢",
    normal:   "🟡",
    elevated: "🟠",
    extreme:  "🔴",
  }[summary.ivSignal];

  const pcEmoji = {
    bullish: "🐂",
    neutral: "⚖️",
    bearish: "🐻",
  }[summary.pcSignal];

  const multiplierNote = summary.positionSizeMultiplier < 1.0
    ? `（建议仓位缩至 ${(summary.positionSizeMultiplier * 100).toFixed(0)}%）`
    : summary.positionSizeMultiplier > 1.0
    ? "（IV 偏低，可适当放大仓位）"
    : "";

  return [
    `📊 **${summary.symbol} 期权市场**`,
    `${ivEmoji} IV: ${summary.iv30d.toFixed(1)}%  [${summary.ivSignal}]  百分位 ${summary.ivPercentile}%`,
    `${pcEmoji} PCR: ${summary.putCallRatio.toFixed(2)}  [${summary.pcSignal}]`,
    `🎯 仓位系数: ×${summary.positionSizeMultiplier.toFixed(1)} ${multiplierNote}`,
  ].join("\n");
}

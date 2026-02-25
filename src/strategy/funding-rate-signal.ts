/**
 * 资金费率逆向策略信号
 *
 * 逻辑：资金费率极端 = 市场严重偏向一侧 = 反转前兆
 *
 *   资金费率 > +long_threshold%  → 多头极度拥挤 → 逆向做空信号（funding_rate_overlong）
 *   资金费率 < -short_threshold% → 空头极度拥挤 → 逆向做多信号（funding_rate_overshort）
 *
 * 参考阈值（Binance 永续合约 8h 资金费率）：
 *   多头极端：+0.30%（年化 ~328%），通常预示短期回调
 *   空头极端：-0.15%（年化 ~164%），空头过重，有轧空风险
 *
 * 使用方式：
 *   在 strategy.yaml 的 buy/sell/short/cover 条件中加入：
 *     buy:  [ma_bullish, funding_rate_overshort]   # 空头拥挤 + 趋势向上 = 强做多
 *     short: [ma_bearish, funding_rate_overlong]   # 多头拥挤 + 趋势向下 = 强做空
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFundingRate } from "../exchange/futures-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FR_CACHE_PATH = path.resolve(__dirname, "../../logs/funding-rate-cache.json");

// ─── 类型 ──────────────────────────────────────────────

export type FundingSignal = "overlong" | "overshort" | "neutral";

export type FundingRateCache = Record<string, {
  ratePct: number;   // 资金费率百分比（如 +0.03 = +0.03%）
  fetchedAt: number; // fetch 时间戳（ms）
}>;

// ─── 缓存 IO ──────────────────────────────────────────

/** 读取资金费率缓存（未命中或过期返回 undefined） */
export function readFundingRateCache(symbol: string, maxAgeMs = 10 * 60_000): number | undefined {
  try {
    if (!fs.existsSync(FR_CACHE_PATH)) return undefined;
    const cache = JSON.parse(fs.readFileSync(FR_CACHE_PATH, "utf-8")) as FundingRateCache;
    const entry = cache[symbol.toUpperCase()];
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > maxAgeMs) return undefined;
    return entry.ratePct;
  } catch {
    return undefined;
  }
}

/** 写入资金费率缓存 */
export function writeFundingRateCache(symbol: string, ratePct: number): void {
  let cache: FundingRateCache = {};
  try {
    if (fs.existsSync(FR_CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(FR_CACHE_PATH, "utf-8")) as FundingRateCache;
    }
  } catch { /* 读取失败则新建 */ }
  cache[symbol.toUpperCase()] = { ratePct, fetchedAt: Date.now() };
  fs.mkdirSync(path.dirname(FR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(FR_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ─── 核心判断 ─────────────────────────────────────────

/**
 * 判断资金费率是否处于极端区间
 *
 * @param ratePct        资金费率百分比（如 +0.03 = +0.03%）
 * @param longThreshold  多头极端阈值（默认 +0.30%）
 * @param shortThreshold 空头极端阈值（绝对值，默认 0.15%）
 */
export function checkFundingRateSignal(
  ratePct: number,
  longThreshold = 0.30,
  shortThreshold = 0.15
): FundingSignal {
  if (ratePct > longThreshold) return "overlong";
  if (ratePct < -shortThreshold) return "overshort";
  return "neutral";
}

// ─── 资金费率拉取（带缓存）───────────────────────────

/**
 * 拉取资金费率（优先读缓存，10 分钟有效）
 * 返回百分比值，如 +0.03 = +0.03%
 */
export async function fetchFundingRatePct(symbol: string): Promise<number | undefined> {
  // 先读缓存
  const cached = readFundingRateCache(symbol);
  if (cached !== undefined) return cached;

  // 缓存过期或不存在，拉取新数据
  try {
    const fr = await getFundingRate(symbol);
    const ratePct = fr.fundingRate * 100; // 小数转百分比
    writeFundingRateCache(symbol, ratePct);
    return ratePct;
  } catch {
    return undefined;
  }
}

/**
 * 历史 K 线数据获取器
 * - 支持分页拉取（Binance 每次最多 1000 条）
 * - 本地磁盘缓存，避免重复请求
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Kline } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../../logs/kline-cache");
const BASE_URL = "api.binance.com";
const BATCH_SIZE = 1000;
const REQUEST_DELAY_MS = 250; // 避免 Binance API 限频

/** Binance 错误响应结构（code 为负数时表示 API 错误） */
interface BinanceErrorBody {
  code: number;
  msg: string;
}

function isBinanceError(obj: unknown): obj is BinanceErrorBody {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "code" in obj &&
    typeof (obj as Record<string, unknown>)["code"] === "number" &&
    ((obj as Record<string, unknown>)["code"] as number) < 0
  );
}

function request(urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: BASE_URL, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(data) as unknown;
          if (isBinanceError(parsed)) {
            reject(new Error(`Binance API Error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch (_e: unknown) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("Request timeout")));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 缓存文件路径（按日期分片） */
function cachePath(symbol: string, interval: string, dateStr: string): string {
  return path.join(CACHE_DIR, `${symbol}_${interval}_${dateStr}.json`);
}

/** 读取缓存（不存在返回 null） */
function readCache(file: string): Kline[] | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Kline[];
  } catch (_e: unknown) {
    return null;
  }
}

/** 写入缓存 */
function writeCache(file: string, klines: Kline[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(klines));
}

/**
 * 拉取完整历史 K 线数据（分页 + 缓存）
 *
 * @param symbol   交易对，如 "BTCUSDT"
 * @param interval K 线周期，如 "1h"
 * @param startMs  开始时间戳（毫秒）
 * @param endMs    结束时间戳（毫秒）
 * @param onProgress 可选进度回调
 */
export async function fetchHistoricalKlines(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
  onProgress?: (fetched: number) => void
): Promise<Kline[]> {
  // 尝试读取整段缓存（以日期范围为 key）
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const cacheFile = cachePath(symbol, interval, `${startDate}_${endDate}`);
  const cached = readCache(cacheFile);
  if (cached) return cached;

  const allKlines: Kline[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const urlPath =
      `/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${BATCH_SIZE}`;

    const raw = (await request(urlPath)) as [
      number,
      string,
      string,
      string,
      string,
      string,
      number,
    ][];

    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      allKlines.push({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      });
    }

    onProgress?.(allKlines.length);

    // raw.length > 0 已在上方检查，末尾元素必存在
    cursor = raw[raw.length - 1]![6] + 1;
    if (raw.length < BATCH_SIZE) break; // 已到末尾

    await sleep(REQUEST_DELAY_MS);
  }

  // 写入缓存（今天之前的数据才缓存，避免缓存不完整的当天数据）
  const today = new Date().toISOString().slice(0, 10);
  if (endDate < today) {
    writeCache(cacheFile, allKlines);
  }

  return allKlines;
}

// ─────────────────────────────────────────────────────
// 历史资金费率获取（Futures 回测专用）
// ─────────────────────────────────────────────────────

export interface FundingRateRecord {
  ts: number;    // fundingTime（毫秒）
  rate: number;  // 资金费率，如 -0.0001 表示 -0.01%
}

/**
 * 获取 Binance Futures 历史资金费率
 * 每 8 小时结算一次（00:00 / 08:00 / 16:00 UTC）
 *
 * @param symbol  交易对，如 "BTCUSDT"
 * @param startMs 开始时间戳（毫秒）
 * @param endMs   结束时间戳（毫秒）
 */
export async function fetchHistoricalFundingRates(
  symbol: string,
  startMs: number,
  endMs: number
): Promise<FundingRateRecord[]> {
  const cacheFile = path.join(CACHE_DIR, `funding_${symbol}_${new Date(startMs).toISOString().slice(0, 10)}_${new Date(endMs).toISOString().slice(0, 10)}.json`);
  const cached = (() => {
    try { return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as FundingRateRecord[]; }
    catch { return null; }
  })();
  if (cached) return cached;

  interface BinanceFunding { symbol: string; fundingTime: number; fundingRate: string }
  const all: FundingRateRecord[] = [];
  let cursor = startMs;
  const LIMIT = 1000;

  while (cursor < endMs) {
    const urlPath = `/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT}`;
    let raw: BinanceFunding[];
    try {
      raw = (await (new Promise<unknown>((resolve, reject) => {
        const req = https.get({ hostname: "fapi.binance.com", path: urlPath }, (res) => {
          let data = "";
          res.on("data", (c: string) => data += c);
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); } });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
      }))) as BinanceFunding[];
    } catch { break; }

    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const r of raw) {
      all.push({ ts: r.fundingTime, rate: parseFloat(r.fundingRate) });
    }
    cursor = raw[raw.length - 1]!.fundingTime + 1;
    if (raw.length < LIMIT) break;
    await sleep(REQUEST_DELAY_MS);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (new Date(endMs).toISOString().slice(0, 10) < today) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(all));
  }
  return all;
}

/**
 * 清理过期缓存（默认保留 30 天内的缓存文件）
 */
export function pruneKlineCache(keepDays = 30): void {
  if (!fs.existsSync(CACHE_DIR)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const fullPath = path.join(CACHE_DIR, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}

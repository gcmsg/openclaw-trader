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

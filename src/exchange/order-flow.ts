/**
 * Order Flow — 真实 CVD（累计成交量差值）
 *
 * 通过 Binance aggTrade WebSocket 流，实时追踪每个 symbol 的买/卖主动成交量差值。
 *
 * ## 原理
 * 每笔逐笔成交（aggTrade）带有 `m`（maker）字段：
 *   - m = true：卖方挂单（maker），买方主动成交 → buyer-initiated → +volume
 *   - m = false：买方挂单（maker），卖方主动成交 → seller-initiated → -volume
 *
 * CVD = Σ( m=false(买方主动) ? +volume : -volume )，正 = 净买压，负 = 净卖压
 *
 * ## 用途
 * - 真实 CVD 上升但价格横盘 → 买压积累，可能突破上行
 * - 价格上涨但 CVD 下降 → 假突破（被动成交拉升，无主动买盘）
 *
 * ## 持久化
 * CVD 状态写入 logs/cvd-state.json，供 monitor.ts cron 读取。
 *
 * ## 升级说明
 * 当前 monitor.ts 默认使用 calculateIndicators() 的 K 线近似 CVD。
 * 若 ws-monitor.ts 已启动并写入 cvd-state.json，则 readCvdCache() 提供
 * 更精确的逐笔 CVD，可在 monitor.ts 中覆盖 indicators.cvd。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CVD_CACHE_PATH = path.resolve(__dirname, "../../logs/cvd-state.json");
const log = createLogger("cvd");

// ─── 类型 ──────────────────────────────────────────────

export interface CvdEntry {
  symbol: string;
  cvd: number;              // 当前滚动窗口内的累计差值（USDT 计价）
  buyVolume: number;        // 买方主动成交量（原始 base asset）
  sellVolume: number;       // 卖方主动成交量（原始 base asset）
  tradeCount: number;       // 累计笔数
  windowStartMs: number;    // 当前窗口开始时间（毫秒）
  updatedAt: number;        // 最后更新时间（毫秒）
}

type CvdCache = Record<string, CvdEntry>;

// ─── 文件缓存 ──────────────────────────────────────────

/** 读取 CVD 缓存（返回指定 symbol 或 undefined） */
export function readCvdCache(symbol?: string): CvdEntry | CvdCache | undefined {
  try {
    if (!fs.existsSync(CVD_CACHE_PATH)) return undefined;
    const raw = fs.readFileSync(CVD_CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as CvdCache;
    if (symbol) return cache[symbol];
    return cache;
  } catch {
    return undefined;
  }
}

/** 写入单个 symbol 的 CVD 状态 */
export function writeCvdEntry(entry: CvdEntry): void {
  let cache: CvdCache = {};
  try {
    if (fs.existsSync(CVD_CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CVD_CACHE_PATH, "utf-8")) as CvdCache;
    }
  } catch { /* 读取失败则新建 */ }
  cache[entry.symbol] = entry;
  fs.mkdirSync(path.dirname(CVD_CACHE_PATH), { recursive: true });
  fs.writeFileSync(CVD_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ─── WebSocket 管理器 ──────────────────────────────────

interface AggTrade {
  e: "aggTrade";     // 事件类型
  E: number;         // 事件时间
  s: string;         // 交易对
  p: string;         // 成交价格
  q: string;         // 成交数量
  m: boolean;        // maker 方向（true=买方主动，false=卖方主动）
}

/**
 * CVD 聚合流管理器
 *
 * 订阅多个 symbol 的 aggTrade 流，实时累计 CVD，定期写入缓存。
 *
 * @example
 * const mgr = new CvdManager(["BTCUSDT", "ETHUSDT"], { windowMs: 3_600_000 });
 * mgr.start();
 * // later: mgr.stop();
 */
export class CvdManager {
  private symbols: string[];
  private windowMs: number;   // CVD 滚动窗口（默认 1h）
  private ws: InstanceType<typeof WebSocket> | null = null;
  private state: Record<string, CvdEntry> = {};
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    symbols: string[],
    opts: { windowMs?: number } = {}
  ) {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.windowMs = opts.windowMs ?? 3_600_000; // 1h window
  }

  start(): void {
    this._initState();
    this._connect();
    // 每 30 秒持久化一次
    this.flushIntervalId = setInterval(() => { this._flush(); }, 30_000);
    log.info(`订阅 aggTrade: ${this.symbols.join(", ")} (窗口 ${this.windowMs / 60_000}min)`);
  }

  stop(): void {
    if (this.flushIntervalId) clearInterval(this.flushIntervalId);
    if (this.ws) this.ws.close();
    this._flush();
    log.info("已停止");
  }

  /** 获取当前 symbol CVD（原始数值） */
  getCvd(symbol: string): number | undefined {
    return this.state[symbol.toLowerCase()]?.cvd;
  }

  // ── 私有方法 ──────────────────────────────────────

  private _initState(): void {
    const nowMs = Date.now();
    for (const sym of this.symbols) {
      this.state[sym] = {
        symbol: sym.toUpperCase(),
        cvd: 0,
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0,
        windowStartMs: nowMs,
        updatedAt: nowMs,
      };
    }
  }

  private _connect(): void {
    // Binance 组合流格式：symbol@aggTrade/symbol@aggTrade/...
    const streams = this.symbols.map((s) => `${s}@aggTrade`).join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.addEventListener("message", (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as { data: AggTrade };
        this._onTrade(msg.data);
      } catch { /* 忽略解析错误 */ }
    });

    this.ws.addEventListener("error", () => {
      log.error("WebSocket 错误，3s 后重连...");
    });

    this.ws.addEventListener("close", () => {
      log.warn("连接断开，5s 后重连...");
      setTimeout(() => { this._connect(); }, 5_000);
    });
  }

  private _onTrade(trade: AggTrade): void {
    const sym = trade.s.toLowerCase();
    const entry = this.state[sym];
    if (!entry) return;

    const nowMs = trade.E;
    const qty = parseFloat(trade.q);

    // 滚动窗口：超过 windowMs 则重置
    if (nowMs - entry.windowStartMs > this.windowMs) {
      entry.cvd = 0;
      entry.buyVolume = 0;
      entry.sellVolume = 0;
      entry.tradeCount = 0;
      entry.windowStartMs = nowMs;
    }

    // Binance aggTrade: m = isBuyerMaker
    //   m = false → 买方是 taker（主动买，hit ask）→ 买压 → CVD +
    //   m = true  → 买方是 maker（卖方主动，hit bid）→ 卖压 → CVD -
    if (!trade.m) {
      entry.cvd += qty;
      entry.buyVolume += qty;
    } else {
      entry.cvd -= qty;
      entry.sellVolume += qty;
    }
    entry.tradeCount += 1;
    entry.updatedAt = nowMs;
  }

  private _flush(): void {
    for (const entry of Object.values(this.state)) {
      writeCvdEntry(entry);
    }
  }
}

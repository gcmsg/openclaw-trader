/**
 * Binance WebSocket K 线流管理器
 *
 * 支持多 symbol 合并流，自动断线重连（指数退避）
 * 只在 K 线收盘（kline.x === true）时回调，避免基于未完结 K 线做决策
 *
 * 使用方式：
 *   const mgr = new BinanceWsManager(["BTCUSDT", "ETHUSDT"], "1h");
 *   mgr.subscribe(async ({ symbol, kline, isClosed }) => {
 *     if (!isClosed) return; // 只处理已关闭 K 线
 *     // ... run strategy
 *   });
 *   mgr.start();
 *   // 停止时：mgr.stop();
 */

import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface KlineUpdate {
  symbol: string;
  interval: string;
  kline: Kline;
  /** K 线是否已收盘（true = 最终数据，false = 实时更新中） */
  isClosed: boolean;
}

export type KlineHandler = (update: KlineUpdate) => void | Promise<void>;

// ─────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────

const WS_BASE = "wss://stream.binance.com:9443/stream";
const PING_INTERVAL_MS = 3 * 60 * 1000; // 每 3 分钟 ping，防止连接超时
const RECONNECT_BASE_MS = 1000; // 重连起始等待 1s
const RECONNECT_MAX_MS = 30 * 1000; // 重连最大等待 30s

// ─────────────────────────────────────────────────────
// Binance WS 消息格式
// ─────────────────────────────────────────────────────

interface BinanceKlinePayload {
  t: number; // K 线开始时间
  T: number; // K 线结束时间
  s: string; // symbol（大写，如 BTCUSDT）
  i: string; // interval（如 "1h"）
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  x: boolean; // 是否收盘
}

interface BinanceCombinedMessage {
  stream: string;
  data: {
    e: string; // 事件类型，应为 "kline"
    s: string; // symbol
    k: BinanceKlinePayload;
  };
}

function isBinanceCombinedMessage(obj: unknown): obj is BinanceCombinedMessage {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "stream" in obj &&
    "data" in obj &&
    typeof (obj as Record<string, unknown>)["data"] === "object"
  );
}

function parseKline(k: BinanceKlinePayload): Kline {
  return {
    openTime: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    closeTime: k.T,
  };
}

// ─────────────────────────────────────────────────────
// BinanceWsManager
// ─────────────────────────────────────────────────────

export class BinanceWsManager {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private handlers: KlineHandler[] = [];
  private running = false;

  /** @param symbols 要监听的交易对列表（大写，如 ["BTCUSDT", "ETHUSDT"]） */
  constructor(
    private readonly symbols: string[],
    private readonly interval: string,
    private readonly onLog?: (msg: string) => void
  ) {}

  /** 注册 K 线更新回调（可多次调用注册多个）*/
  subscribe(handler: KlineHandler): void {
    this.handlers.push(handler);
  }

  /** 启动 WebSocket 连接 */
  start(): void {
    this.running = true;
    this.connect();
  }

  /** 停止连接，清理所有定时器 */
  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "client stop");
      this.ws = null;
    }
  }

  /** 是否当前已连接 */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─────────────────────────────────────────────────────

  private buildUrl(): string {
    const streams = this.symbols
      .map((s) => `${s.toLowerCase()}@kline_${this.interval}`)
      .join("/");
    return `${WS_BASE}?streams=${streams}`;
  }

  private connect(): void {
    const url = this.buildUrl();
    this.log(`连接中: ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err: unknown) {
      this.log(`创建 WebSocket 失败: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.log(`已连接，监听 ${this.symbols.length} 个 symbol (${this.interval})`);
      this.reconnectDelay = RECONNECT_BASE_MS; // 重置退避
      this.startPing();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.log(`连接断开 code=${event.code} reason="${event.reason}"`);
      this.stopPing();
      if (this.running) this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      this.log("WebSocket 连接错误");
    });
  }

  private handleMessage(raw: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (!isBinanceCombinedMessage(obj)) return;
    if (obj.data.e !== "kline") return;

    const k = obj.data.k;
    const update: KlineUpdate = {
      symbol: k.s,
      interval: k.i,
      kline: parseKline(k),
      isClosed: k.x,
    };

    for (const handler of this.handlers) {
      try {
        const result = handler(update);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            this.log(`handler 错误: ${String(err)}`);
          });
        }
      } catch (err: unknown) {
        this.log(`handler 同步错误: ${String(err)}`);
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Binance 接受 JSON ping frame
        this.ws.send(JSON.stringify({ method: "PING" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.log(`${this.reconnectDelay}ms 后重连...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // 指数退避，最大 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private log(msg: string): void {
    const line = `[WS ${new Date().toISOString()}] ${msg}`;
    if (this.onLog) {
      this.onLog(line);
    } else {
      console.log(line);
    }
  }
}

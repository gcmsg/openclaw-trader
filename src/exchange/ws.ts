/**
 * Binance WebSocket Kline Stream Manager
 *
 * Supports multi-symbol combined stream with auto-reconnect (exponential backoff).
 * Only triggers callback on kline close (kline.x === true) to avoid decisions on incomplete candles.
 *
 * Usage:
 *   const mgr = new BinanceWsManager(["BTCUSDT", "ETHUSDT"], "1h");
 *   mgr.subscribe(async ({ symbol, kline, isClosed }) => {
 *     if (!isClosed) return; // Only process closed klines
 *     // ... run strategy
 *   });
 *   mgr.start();
 *   // To stop: mgr.stop();
 */

import type { Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface KlineUpdate {
  symbol: string;
  interval: string;
  kline: Kline;
  /** Whether the kline has closed (true = final data, false = still updating) */
  isClosed: boolean;
}

export type KlineHandler = (update: KlineUpdate) => void | Promise<void>;

// ─────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────

const WS_BASE = "wss://stream.binance.com:9443/stream";
const PING_INTERVAL_MS = 3 * 60 * 1000; // Ping every 3 minutes to prevent connection timeout
const RECONNECT_BASE_MS = 1000; // Initial reconnect wait 1s
const RECONNECT_MAX_MS = 30 * 1000; // Max reconnect wait 30s

// ─────────────────────────────────────────────────────
// Binance WS Message Format
// ─────────────────────────────────────────────────────

interface BinanceKlinePayload {
  t: number; // Kline open time
  T: number; // Kline close time
  s: string; // symbol (uppercase, e.g. BTCUSDT)
  i: string; // interval (e.g. "1h")
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  x: boolean; // Whether closed
}

interface BinanceCombinedMessage {
  stream: string;
  data: {
    e: string; // Event type, should be "kline"
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

  /** @param symbols List of trading pairs to subscribe (uppercase, e.g. ["BTCUSDT", "ETHUSDT"]) */
  constructor(
    private readonly symbols: string[],
    private readonly interval: string,
    private readonly onLog?: (msg: string) => void
  ) {}

  /** Register a kline update callback (can be called multiple times) */
  subscribe(handler: KlineHandler): void {
    this.handlers.push(handler);
  }

  /** Start WebSocket connection */
  start(): void {
    this.running = true;
    this.connect();
  }

  /** Stop connection and clean up all timers */
  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "client stop");
      this.ws = null;
    }
  }

  /** Whether currently connected */
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
    this.log(`Connecting: ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err: unknown) {
      this.log(`Failed to create WebSocket: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.log(`Connected, listening to ${this.symbols.length} symbols (${this.interval})`);
      this.reconnectDelay = RECONNECT_BASE_MS; // Reset backoff
      this.startPing();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.log(`Disconnected code=${event.code} reason="${event.reason}"`);
      this.stopPing();
      if (this.running) this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      this.log("WebSocket connection error");
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
            this.log(`Handler error: ${String(err)}`);
          });
        }
      } catch (err: unknown) {
        this.log(`Handler sync error: ${String(err)}`);
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Binance accepts JSON ping frames
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
    this.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff, max 30s
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

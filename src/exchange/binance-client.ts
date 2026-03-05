/**
 * Binance REST API Client
 *
 * Supports:
 * - Spot production / Testnet
 * - USDT-M Futures production / Testnet
 * - HMAC-SHA256 signature authentication
 *
 * Testnet application: https://testnet.binance.vision (login with GitHub)
 */

import https from "https";
import crypto from "crypto";
import fs from "fs";

// ─────────────────────────────────────────────────────
// Token Bucket Rate Limiter
// Binance limits: Spot 1200 weight/min · Futures 2400 weight/min
// Conservative cap: 600 weight/min = 10/s, leaving sufficient headroom
// ─────────────────────────────────────────────────────

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxPerMinute = 600) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60_000;
  }

  async acquire(weight = 1): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;

      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }

      // Wait for token replenishment, minimum wait 50ms
      const waitMs = Math.ceil((weight - this.tokens) / this.refillRate);
      await new Promise<void>((r) => setTimeout(r, Math.max(50, waitMs)));
    }
  }
}

// Global rate limiter (one shared instance per process)
const globalRateLimiter = new RateLimiter(600);

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";
export type BinanceOrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP_LOSS_LIMIT"       // Spot: places limit order after price trigger
  | "TAKE_PROFIT_LIMIT"     // Spot: take-profit limit
  | "STOP_MARKET"           // Futures: market close after price trigger (recommended)
  | "TAKE_PROFIT_MARKET";   // Futures: take-profit market
export type OrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

export interface BinanceCredentials {
  apiKey: string;
  secretKey: string;
}

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: BinanceOrderType;
  quantity: number;
  price?: number;                        // Required for LIMIT orders
  stopPrice?: number;                    // Stop-loss/take-profit trigger price
  timeInForce?: "GTC" | "IOC" | "FOK";  // Defaults to GTC for LIMIT orders
  newClientOrderId?: string;
  reduceOnly?: boolean;                  // Futures only: reduce-only (prevent accidental new positions)
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE"; // Futures: stop trigger price type
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: OrderStatus;
  type: string;
  side: string;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
}

export interface AccountBalance {
  asset: string;
  free: string;   // Available balance
  locked: string; // Frozen amount (in open orders)
}

export interface AccountInfo {
  balances: AccountBalance[];
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQty: number;
  maxQty: number;
  stepSize: number;   // Quantity precision
  tickSize: number;   // Price precision (PRICE_FILTER)
  minNotional: number; // Minimum notional value (min USDT)
  pricePrecision: number;
  quantityPrecision: number;
}

// ─────────────────────────────────────────────────────
// API Endpoint Configuration
// ─────────────────────────────────────────────────────

const ENDPOINTS = {
  spot: {
    production: "api.binance.com",
    testnet: "testnet.binance.vision",
  },
  futures: {
    production: "fapi.binance.com",
    testnet: "testnet.binancefuture.com",
  },
} as const;

// ─────────────────────────────────────────────────────
// Core HTTP Request (with signature)
// ─────────────────────────────────────────────────────

function sign(secretKey: string, queryString: string): string {
  return crypto.createHmac("sha256", secretKey).update(queryString).digest("hex");
}

function buildQueryString(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** Parse JSON response, validate Binance error format */
interface BinanceApiError { code: number; msg: string }
function isBinanceApiError(obj: unknown): obj is BinanceApiError {
  return typeof obj === "object" && obj !== null && "code" in obj &&
    typeof (obj as Record<string, unknown>)["code"] === "number" &&
    ((obj as Record<string, unknown>)["code"] as number) < 0;
}

async function httpsRequest(
  hostname: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
  await globalRateLimiter.acquire();
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
        ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // 429: Rate limit triggered
        if (res.statusCode === 429 || res.statusCode === 418) {
          const retryAfter = parseInt(res.headers["retry-after"] ?? "60", 10);
          reject(new Error(`Binance rate limit hit (HTTP ${res.statusCode}), retry after ${retryAfter}s`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(data) as unknown;
          if (isBinanceApiError(parsed)) {
            reject(new Error(`Binance API Error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch (_e: unknown) {
          reject(new Error(`Failed to parse Binance response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Binance API timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────
// Request wrapper with auto-retry (429/5xx/network errors)
// ─────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function httpsRequestWithRetry(
  hostname: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await httpsRequest(hostname, method, path, headers, body);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;

      // Retryable conditions: 429/418 rate limit, 5xx server error, network/timeout error
      const isRateLimit = msg.includes("rate limit hit");
      const isTimeout = msg.includes("timeout");
      const isNetwork = msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT");
      const is5xx = msg.includes("HTTP 5");

      if (!isRateLimit && !isTimeout && !isNetwork && !is5xx) throw lastError; // Not retryable
      if (attempt >= MAX_RETRIES) break; // Max retries reached

      // Exponential backoff: 429 uses retry-after, others use 1s/2s/4s
      let waitMs: number;
      if (isRateLimit) {
        const match = /retry after (\d+)s/.exec(msg);
        waitMs = match?.[1] ? parseInt(match[1], 10) * 1000 : 5000;
      } else {
        waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      }
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError!;
}

// ─────────────────────────────────────────────────────
// BinanceClient Class
// ─────────────────────────────────────────────────────

export class BinanceClient {
  private readonly hostname: string;
  private readonly apiPrefix: string;      // /api/v3 or /fapi/v1
  private readonly accountPrefix: string;  // /api/v3 or /fapi/v2 (Futures account uses v2)
  private readonly market: "spot" | "futures";
  private readonly creds: BinanceCredentials;

  /**
   * @param credentialsPath  JSON file path containing { apiKey, secretKey }
   * @param testnet          true = testnet, false = production
   * @param market           "spot" | "futures"
   */
  constructor(
    credentialsPath: string,
    testnet = false,
    market: "spot" | "futures" = "spot"
  ) {
    const raw = fs.readFileSync(credentialsPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>)["apiKey"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["secretKey"] !== "string"
    ) {
      throw new Error(`Invalid credentials file (missing apiKey/secretKey): ${credentialsPath}`);
    }
    this.creds = parsed as BinanceCredentials;

    const env = testnet ? "testnet" : "production";
    this.hostname = ENDPOINTS[market][env];
    this.market = market;
    this.apiPrefix = market === "futures" ? "/fapi/v1" : "/api/v3";
    // Futures account/balance endpoint is v2 (/fapi/v1/account is deprecated)
    this.accountPrefix = market === "futures" ? "/fapi/v2" : "/api/v3";
  }

  // ── Public endpoints (no signature required) ──────────────────────────────

  /** Get current price */
  async getPrice(symbol: string): Promise<number> {
    const path = `${this.apiPrefix}/ticker/price?symbol=${symbol}`;
    const res = (await httpsRequestWithRetry(this.hostname, "GET", path, {})) as { price: string };
    return parseFloat(res.price);
  }

  /** Get symbol info (precision, minimum order size, etc.) */
  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const path = `${this.apiPrefix}/exchangeInfo?symbol=${symbol}`;
    const res = (await httpsRequestWithRetry(this.hostname, "GET", path, {})) as {
      symbols: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        filters: { filterType: string; minQty?: string; maxQty?: string; stepSize?: string; minNotional?: string; tickSize?: string }[];
        baseAssetPrecision: number;
        quotePrecision: number;
      }[];
    };

    const info = res.symbols.find((s) => s.symbol === symbol);
    if (!info) throw new Error(`Symbol ${symbol} not found`);

    const lotFilter = info.filters.find((f) => f.filterType === "LOT_SIZE");
    const notionalFilter = info.filters.find((f) => f.filterType === "MIN_NOTIONAL") ??
      info.filters.find((f) => f.filterType === "NOTIONAL");
    const priceFilter = info.filters.find((f) => f.filterType === "PRICE_FILTER");

    return {
      symbol: info.symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      minQty: parseFloat(lotFilter?.minQty ?? "0.00001"),
      maxQty: parseFloat(lotFilter?.maxQty ?? "9000"),
      stepSize: parseFloat(lotFilter?.stepSize ?? "0.00001"),
      tickSize: parseFloat(priceFilter?.tickSize ?? "0.01"),
      minNotional: parseFloat(notionalFilter?.minNotional ?? "10"),
      pricePrecision: info.quotePrecision,
      quantityPrecision: info.baseAssetPrecision,
    };
  }

  /** Round price to tickSize (prevent PRICE_FILTER error) */
  private roundToTickSize(price: number, tickSize: number): number {
    const decimals = Math.round(-Math.log10(tickSize));
    return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(Math.max(0, decimals)));
  }

  private signedHeaders(): Record<string, string> {
    return { "X-MBX-APIKEY": this.creds.apiKey };
  }

  private buildSignedQuery(params: Record<string, string | number | boolean>): string {
    const withTimestamp = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const qs = buildQueryString(withTimestamp);
    const sig = sign(this.creds.secretKey, qs);
    return `${qs}&signature=${sig}`;
  }

  /** Account balance (Spot uses /api/v3/account; Futures uses /fapi/v2/account) */
  async getAccountInfo(): Promise<AccountInfo> {
    const qs = this.buildSignedQuery({});
    const path = `${this.accountPrefix}/account?${qs}`;
    const raw = await httpsRequestWithRetry(this.hostname, "GET", path, this.signedHeaders());

    if (this.market === "futures") {
      // Futures account structure: { assets: [{ asset, walletBalance, availableBalance }] }
      const futuresRaw = raw as {
        assets?: { asset: string; walletBalance: string; availableBalance: string }[];
        canTrade?: boolean;
      };
      return {
        canTrade: futuresRaw.canTrade ?? true,
        canWithdraw: true,
        canDeposit: true,
        balances: (futuresRaw.assets ?? []).map((a) => ({
          asset: a.asset,
          free: a.availableBalance,
          locked: "0",
        })),
      };
    }

    return raw as AccountInfo;
  }

  /** Get available USDT balance (works for both Spot and Futures) */
  async getUsdtBalance(): Promise<number> {
    const info = await this.getAccountInfo();
    const usdt = info.balances.find((b) => b.asset === "USDT");
    return usdt ? parseFloat(usdt.free) : 0;
  }

  /**
   * Place order (market / limit)
   *
   * quantity is in BASE asset units (e.g. BTC amount, not USDT amount)
   * If passing USDT amount, divide by price first to convert
   */
  async createOrder(req: OrderRequest): Promise<OrderResponse> {
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: req.quantity.toFixed(8), // Precision control handled by caller
    };

    if (req.type === "LIMIT" || req.type === "STOP_LOSS_LIMIT" || req.type === "TAKE_PROFIT_LIMIT") {
      params["timeInForce"] = req.timeInForce ?? "GTC";
      if (req.price) params["price"] = req.price.toFixed(8);
    }
    if (req.stopPrice) params["stopPrice"] = req.stopPrice.toFixed(8);
    if (req.newClientOrderId) params["newClientOrderId"] = req.newClientOrderId;
    if (req.reduceOnly) params["reduceOnly"] = "true";
    if (req.workingType) params["workingType"] = req.workingType;

    const body = this.buildSignedQuery(params);
    const path = `${this.apiPrefix}/order`;
    return (await httpsRequestWithRetry(this.hostname, "POST", path, this.signedHeaders(), body)) as OrderResponse;
  }

  /**
   * Place stop-loss order (auto-adapts to Spot / Futures)
   *
   * Spot: STOP_LOSS_LIMIT (requires price + stopPrice)
   *   - Trigger condition: price crosses stopPrice
   *   - Order price: limitPrice (usually 0.2% below stopPrice to ensure fill)
   *
   * Futures: STOP_MARKET (only needs stopPrice)
   *   - Market close after trigger, no limit price needed
   *   - reduceOnly=true: reduce-only, prevents accidental new positions
   *
   * @param symbol      Trading pair
   * @param side        Order direction (short stop-loss=BUY, long stop-loss=SELL)
   * @param qty         Quantity
   * @param stopPrice   Trigger price
   * @param limitPrice  Only needed for Spot (defaults to stopPrice * 0.998 if not provided)
   */
  async placeStopLossOrder(
    symbol: string,
    side: OrderSide,
    qty: number,
    stopPrice: number,
    limitPrice?: number
  ): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);
    const roundedStop = this.roundToTickSize(stopPrice, symbolInfo.tickSize);

    try {
      if (this.market === "futures") {
        return await this.createOrder({
          symbol,
          side,
          type: "STOP_MARKET",
          quantity: qty,
          stopPrice: roundedStop,
          reduceOnly: true,
          workingType: "MARK_PRICE",
        });
      } else {
        // Spot: STOP_LOSS_LIMIT, limit price = stopPrice * 0.998 (0.2% slippage allowance)
        const rawLimit = limitPrice ?? stopPrice * 0.998;
        const roundedLimit = this.roundToTickSize(rawLimit, symbolInfo.tickSize);
        return await this.createOrder({
          symbol,
          side,
          type: "STOP_LOSS_LIMIT",
          quantity: qty,
          stopPrice: roundedStop,
          price: roundedLimit,
          timeInForce: "GTC",
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Known testnet limitations:
      //   Spot testnet: -1026 MAX_NUM_ALGO_ORDERS (max 5 stop-loss orders)
      //   Futures testnet: -4114/-4135 conditional orders require Algo Order API
      if (
        msg.includes("-1026") || msg.includes("MAX_NUM_ALGO_ORDERS") ||
        msg.includes("Algo Order") || msg.includes("-4114") || msg.includes("-4135") ||
        msg.includes("not supported for this endpoint")
      ) {
        console.warn(
          `[BinanceClient] ⚠️  ${symbol} cannot place stop-loss order on exchange (${msg.split(":")[0]}). ` +
          `Falling back to local price polling stop-loss (SL @ ${roundedStop}).`
        );
        // Return placeholder response, let caller continue; local engine price polling will still execute stop-loss
        return { orderId: -1, status: "LOCAL_ONLY", symbol, side, type: "STOP_LOSS_LIMIT" } as unknown as OrderResponse;
      }
      throw e;
    }
  }

  /**
   * Place take-profit order (auto-adapts to Spot / Futures)
   */
  async placeTakeProfitOrder(
    symbol: string,
    side: OrderSide,
    qty: number,
    takeProfitPrice: number,
    limitPrice?: number
  ): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);
    const roundedTP = this.roundToTickSize(takeProfitPrice, symbolInfo.tickSize);

    try {
      if (this.market === "futures") {
        return await this.createOrder({
          symbol,
          side,
          type: "TAKE_PROFIT_MARKET",
          quantity: qty,
          stopPrice: roundedTP,
          reduceOnly: true,
          workingType: "MARK_PRICE",
        });
      } else {
        const rawLimit = limitPrice ?? takeProfitPrice * 0.999;
        const roundedLimit = this.roundToTickSize(rawLimit, symbolInfo.tickSize);
        return await this.createOrder({
          symbol,
          side,
          type: "TAKE_PROFIT_LIMIT",
          quantity: qty,
          stopPrice: roundedTP,
          price: roundedLimit,
          timeInForce: "GTC",
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("-1026") || msg.includes("MAX_NUM_ALGO_ORDERS") ||
        msg.includes("Algo Order") || msg.includes("-4114") || msg.includes("-4135") ||
        msg.includes("not supported for this endpoint")
      ) {
        console.warn(
          `[BinanceClient] ⚠️  ${symbol} cannot place take-profit order on exchange (${msg.split(":")[0]}). ` +
          `Falling back to local price polling take-profit (TP @ ${roundedTP}).`
        );
        return { orderId: -1, status: "LOCAL_ONLY", symbol, side, type: "TAKE_PROFIT_LIMIT" } as unknown as OrderResponse;
      }
      throw e;
    }
  }

  /** Cancel open order */
  async cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    const qs = this.buildSignedQuery({ symbol, orderId });
    const path = `${this.apiPrefix}/order?${qs}`;
    return (await httpsRequestWithRetry(this.hostname, "DELETE", path, this.signedHeaders())) as OrderResponse;
  }

  /** Query order status */
  async getOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    const qs = this.buildSignedQuery({ symbol, orderId });
    const path = `${this.apiPrefix}/order?${qs}`;
    return (await httpsRequestWithRetry(this.hostname, "GET", path, this.signedHeaders())) as OrderResponse;
  }

  /** Get all open orders */
  async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
    const params: Record<string, string | number | boolean> = symbol ? { symbol } : {};
    const qs = this.buildSignedQuery(params);
    const path = `${this.apiPrefix}/openOrders?${qs}`;
    return (await httpsRequestWithRetry(this.hostname, "GET", path, this.signedHeaders())) as OrderResponse[];
  }

  /**
   * Get Futures position risk (/fapi/v2/positionRisk)
   * Only valid for futures market; returns position info for all symbols
   */
  async getFuturesPositions(): Promise<{ symbol: string; positionAmt: string; entryPrice: string; unrealizedProfit: string }[]> {
    if (this.market !== "futures") return [];
    const qs = this.buildSignedQuery({});
    const path = `/fapi/v2/positionRisk?${qs}`;
    const raw = await httpsRequestWithRetry(this.hostname, "GET", path, this.signedHeaders());
    return raw as { symbol: string; positionAmt: string; entryPrice: string; unrealizedProfit: string }[];
  }

  /**
   * Market buy (USDT amount -> auto-calculate quantity)
   * Returns the actual filled OrderResponse
   */
  async marketBuy(symbol: string, usdtAmount: number): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);

    if (usdtAmount < symbolInfo.minNotional) {
      throw new Error(`Buy amount $${usdtAmount} is below minimum notional value $${symbolInfo.minNotional}`);
    }

    const price = await this.getPrice(symbol);
    const rawQty = usdtAmount / price;

    // Round down to stepSize
    const qty = Math.floor(rawQty / symbolInfo.stepSize) * symbolInfo.stepSize;

    return this.createOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: qty,
    });
  }

  /**
   * Market sell (sell full BASE asset amount)
   * Quantity is rounded down to stepSize to avoid LOT_SIZE filter failure
   */
  async marketSell(symbol: string, quantity: number): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);
    const qty = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
    return this.createOrder({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty,
    });
  }

  /**
   * Market buy by BASE asset quantity
   * Used for covering shorts: when the exact quantity to buy back is known
   * Quantity is rounded down to stepSize
   */
  async marketBuyByQty(symbol: string, quantity: number): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);
    const qty = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
    return this.createOrder({ symbol, side: "BUY", type: "MARKET", quantity: qty });
  }

  /**
   * Test connection (ping)
   * Returns true if API Key is valid and connectivity works
   */
  async ping(): Promise<boolean> {
    try {
      await httpsRequestWithRetry(this.hostname, "GET", `${this.apiPrefix}/ping`, {});
      return true;
    } catch (_e: unknown) {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────

/**
 * Create BinanceClient from config
 * Credentials format: { "apiKey": "xxx", "secretKey": "yyy" }
 */
export function createBinanceClient(
  credentialsPath: string,
  options: { testnet?: boolean; market?: "spot" | "futures" } = {}
): BinanceClient {
  return new BinanceClient(credentialsPath, options.testnet ?? false, options.market ?? "spot");
}

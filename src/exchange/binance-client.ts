/**
 * Binance REST API 客户端
 *
 * 支持：
 * - 现货（Spot）生产环境 / Testnet
 * - U本位合约（USDT-M Futures）生产环境 / Testnet
 * - HMAC-SHA256 签名鉴权
 *
 * Testnet 申请地址：https://testnet.binance.vision（用 GitHub 登录）
 */

import https from "https";
import crypto from "crypto";
import fs from "fs";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";
export type BinanceOrderType = "MARKET" | "LIMIT" | "STOP_LOSS_LIMIT" | "TAKE_PROFIT_LIMIT";
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
  price?: number;          // LIMIT 单必须
  stopPrice?: number;      // 止损触发价
  timeInForce?: "GTC" | "IOC" | "FOK"; // LIMIT 单默认 GTC
  newClientOrderId?: string;
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
  free: string;   // 可用余额
  locked: string; // 冻结金额（挂单中）
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
  stepSize: number;   // 数量精度
  minNotional: number; // 最小名义价值（min USDT）
  pricePrecision: number;
  quantityPrecision: number;
}

// ─────────────────────────────────────────────────────
// API 端点配置
// ─────────────────────────────────────────────────────

const ENDPOINTS = {
  spot: {
    production: "api.binance.com",
    testnet: "testapi.binance.vision",
  },
  futures: {
    production: "fapi.binance.com",
    testnet: "testfapi.binance.vision",
  },
} as const;

// ─────────────────────────────────────────────────────
// 核心 HTTP 请求（带签名）
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

/** 解析 JSON 响应，校验 Binance 错误格式 */
interface BinanceApiError { code: number; msg: string }
function isBinanceApiError(obj: unknown): obj is BinanceApiError {
  return typeof obj === "object" && obj !== null && "code" in obj &&
    typeof (obj as Record<string, unknown>)["code"] === "number" &&
    ((obj as Record<string, unknown>)["code"] as number) < 0;
}

function httpsRequest(
  hostname: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
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
// BinanceClient 类
// ─────────────────────────────────────────────────────

export class BinanceClient {
  private readonly hostname: string;
  private readonly apiPrefix: string; // /api/v3 or /fapi/v1
  private readonly creds: BinanceCredentials;

  /**
   * @param credentialsPath  JSON 文件路径，包含 { apiKey, secretKey }
   * @param testnet          true = testnet，false = 生产环境
   * @param market           "spot" | "futures"
   */
  constructor(
    credentialsPath: string,
    testnet = false,
    market: "spot" | "futures" = "spot"
  ) {
    const raw = fs.readFileSync(credentialsPath, "utf-8");
    this.creds = JSON.parse(raw) as BinanceCredentials;

    const env = testnet ? "testnet" : "production";
    this.hostname = ENDPOINTS[market][env];
    this.apiPrefix = market === "futures" ? "/fapi/v1" : "/api/v3";
  }

  // ── 公共接口（无需签名）──────────────────────────────

  /** 获取当前价格 */
  async getPrice(symbol: string): Promise<number> {
    const path = `${this.apiPrefix}/ticker/price?symbol=${symbol}`;
    const res = (await httpsRequest(this.hostname, "GET", path, {})) as { price: string };
    return parseFloat(res.price);
  }

  /** 获取交易对信息（精度、最小下单量等） */
  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const path = `${this.apiPrefix}/exchangeInfo?symbol=${symbol}`;
    const res = (await httpsRequest(this.hostname, "GET", path, {})) as {
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

    return {
      symbol: info.symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      minQty: parseFloat(lotFilter?.minQty ?? "0.00001"),
      maxQty: parseFloat(lotFilter?.maxQty ?? "9000"),
      stepSize: parseFloat(lotFilter?.stepSize ?? "0.00001"),
      minNotional: parseFloat(notionalFilter?.minNotional ?? "10"),
      pricePrecision: info.quotePrecision,
      quantityPrecision: info.baseAssetPrecision,
    };
  }

  // ── 私有接口（需要 API Key + 签名）──────────────────

  private signedHeaders(): Record<string, string> {
    return { "X-MBX-APIKEY": this.creds.apiKey };
  }

  private buildSignedQuery(params: Record<string, string | number | boolean>): string {
    const withTimestamp = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const qs = buildQueryString(withTimestamp);
    const sig = sign(this.creds.secretKey, qs);
    return `${qs}&signature=${sig}`;
  }

  /** 账户余额（Spot: 所有资产；Futures: USDT 余额） */
  async getAccountInfo(): Promise<AccountInfo> {
    const qs = this.buildSignedQuery({});
    const path = `${this.apiPrefix}/account?${qs}`;
    return (await httpsRequest(this.hostname, "GET", path, this.signedHeaders())) as AccountInfo;
  }

  /** 获取 USDT 可用余额 */
  async getUsdtBalance(): Promise<number> {
    const info = await this.getAccountInfo();
    const usdt = info.balances.find((b) => b.asset === "USDT");
    return usdt ? parseFloat(usdt.free) : 0;
  }

  /**
   * 下单（市价单 / 限价单）
   *
   * quantity 为 BASE 资产数量（如 BTC 数量，不是 USDT 数量）
   * 如果传入的是 USDT 金额，需先 / price 转换
   */
  async createOrder(req: OrderRequest): Promise<OrderResponse> {
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: req.quantity.toFixed(8), // 精度控制由调用方处理
    };

    if (req.type === "LIMIT") {
      params["timeInForce"] = req.timeInForce ?? "GTC";
      if (req.price) params["price"] = req.price.toFixed(8);
    }
    if (req.stopPrice) params["stopPrice"] = req.stopPrice.toFixed(8);
    if (req.newClientOrderId) params["newClientOrderId"] = req.newClientOrderId;

    const body = this.buildSignedQuery(params);
    const path = `${this.apiPrefix}/order`;
    return (await httpsRequest(this.hostname, "POST", path, this.signedHeaders(), body)) as OrderResponse;
  }

  /** 取消挂单 */
  async cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    const qs = this.buildSignedQuery({ symbol, orderId });
    const path = `${this.apiPrefix}/order?${qs}`;
    return (await httpsRequest(this.hostname, "DELETE", path, this.signedHeaders())) as OrderResponse;
  }

  /** 查询订单状态 */
  async getOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    const qs = this.buildSignedQuery({ symbol, orderId });
    const path = `${this.apiPrefix}/order?${qs}`;
    return (await httpsRequest(this.hostname, "GET", path, this.signedHeaders())) as OrderResponse;
  }

  /** 获取所有挂单 */
  async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
    const params: Record<string, string | number | boolean> = symbol ? { symbol } : {};
    const qs = this.buildSignedQuery(params);
    const path = `${this.apiPrefix}/openOrders?${qs}`;
    return (await httpsRequest(this.hostname, "GET", path, this.signedHeaders())) as OrderResponse[];
  }

  /**
   * 市价买入（USDT 金额 → 自动计算数量）
   * 返回实际成交的 OrderResponse
   */
  async marketBuy(symbol: string, usdtAmount: number): Promise<OrderResponse> {
    const symbolInfo = await this.getSymbolInfo(symbol);

    if (usdtAmount < symbolInfo.minNotional) {
      throw new Error(`买入金额 $${usdtAmount} 低于最小名义价值 $${symbolInfo.minNotional}`);
    }

    const price = await this.getPrice(symbol);
    const rawQty = usdtAmount / price;

    // 按 stepSize 向下取整
    const qty = Math.floor(rawQty / symbolInfo.stepSize) * symbolInfo.stepSize;

    return this.createOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: qty,
    });
  }

  /**
   * 市价卖出（BASE 资产全量卖出）
   */
  async marketSell(symbol: string, quantity: number): Promise<OrderResponse> {
    return this.createOrder({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity,
    });
  }

  /**
   * 测试连接（ping）
   * 返回 true 表示 API Key 有效且能连通
   */
  async ping(): Promise<boolean> {
    try {
      await httpsRequest(this.hostname, "GET", `${this.apiPrefix}/ping`, {});
      return true;
    } catch (_e: unknown) {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────

/**
 * 从配置创建 BinanceClient
 * 凭证格式：{ "apiKey": "xxx", "secretKey": "yyy" }
 */
export function createBinanceClient(
  credentialsPath: string,
  options: { testnet?: boolean; market?: "spot" | "futures" } = {}
): BinanceClient {
  return new BinanceClient(credentialsPath, options.testnet ?? false, options.market ?? "spot");
}

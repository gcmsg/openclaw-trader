import crypto from "crypto";
import https from "https";
import type { Kline, TradeResult } from "../types.js";

const BASE_URL = "api.binance.com";

interface BinanceConfig {
  apiKey: string;
  secretKey: string;
}

function sign(query: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

function request(options: https.RequestOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code < 0) {
            reject(new Error(`Binance API Error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Request timeout"));
    });
  });
}

// ─────────────────────────────────────────────────────
// Public API（无需签名）
// ─────────────────────────────────────────────────────

/** 获取最新价格 */
export async function getPrice(symbol: string): Promise<number> {
  const data = (await request({
    hostname: BASE_URL,
    path: `/api/v3/ticker/price?symbol=${symbol}`,
  })) as { price: string };
  return parseFloat(data.price);
}

/** 获取 K 线数据 */
export async function getKlines(
  symbol: string,
  interval: string,
  limit = 100
): Promise<Kline[]> {
  const raw = (await request({
    hostname: BASE_URL,
    path: `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  })) as Array<[number, string, string, string, string, string, number]>;

  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

// ─────────────────────────────────────────────────────
// Private API（需要签名）
// ─────────────────────────────────────────────────────

/** 获取账户余额 */
export async function getBalance(
  cfg: BinanceConfig,
  asset = "USDT"
): Promise<number> {
  const ts = Date.now();
  const query = `timestamp=${ts}`;
  const sig = sign(query, cfg.secretKey);
  const data = (await request({
    hostname: BASE_URL,
    path: `/api/v3/account?${query}&signature=${sig}`,
    headers: { "X-MBX-APIKEY": cfg.apiKey },
  })) as { balances: Array<{ asset: string; free: string }> };

  const balance = data.balances.find((b) => b.asset === asset);
  return balance ? parseFloat(balance.free) : 0;
}

/** 市价买入 */
export async function marketBuy(
  cfg: BinanceConfig,
  symbol: string,
  quoteQty: number // 花费的 USDT 数量
): Promise<TradeResult> {
  const ts = Date.now();
  const params = `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${quoteQty.toFixed(2)}&timestamp=${ts}`;
  const sig = sign(params, cfg.secretKey);
  const body = `${params}&signature=${sig}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE_URL,
        path: "/api/v3/order",
        method: "POST",
        headers: {
          "X-MBX-APIKEY": cfg.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const obj = JSON.parse(data) as {
            code?: number;
            msg?: string;
            orderId: number;
            fills?: Array<{ price: string }>;
            executedQty: string;
            status: string;
          };
          if (obj.code && obj.code < 0) {
            resolve({
              symbol,
              side: "buy",
              price: 0,
              quantity: 0,
              orderId: "",
              timestamp: ts,
              status: "failed",
              error: obj.msg,
            });
          } else {
            const price = obj.fills?.[0]
              ? parseFloat(obj.fills[0].price)
              : 0;
            resolve({
              symbol,
              side: "buy",
              price,
              quantity: parseFloat(obj.executedQty),
              orderId: String(obj.orderId),
              timestamp: ts,
              status: "filled",
            });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 市价卖出 */
export async function marketSell(
  cfg: BinanceConfig,
  symbol: string,
  quantity: number
): Promise<TradeResult> {
  const ts = Date.now();
  const params = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${quantity}&timestamp=${ts}`;
  const sig = sign(params, cfg.secretKey);
  const body = `${params}&signature=${sig}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE_URL,
        path: "/api/v3/order",
        method: "POST",
        headers: {
          "X-MBX-APIKEY": cfg.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const obj = JSON.parse(data) as {
            code?: number;
            msg?: string;
            orderId: number;
            fills?: Array<{ price: string }>;
            executedQty: string;
          };
          if (obj.code && obj.code < 0) {
            resolve({
              symbol,
              side: "sell",
              price: 0,
              quantity: 0,
              orderId: "",
              timestamp: ts,
              status: "failed",
              error: obj.msg,
            });
          } else {
            const price = obj.fills?.[0]
              ? parseFloat(obj.fills[0].price)
              : 0;
            resolve({
              symbol,
              side: "sell",
              price,
              quantity: parseFloat(obj.executedQty),
              orderId: String(obj.orderId),
              timestamp: ts,
              status: "filled",
            });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

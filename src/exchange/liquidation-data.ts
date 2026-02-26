/**
 * 清算热力图 — Binance 合约强平数据（P5.3）
 *
 * 数据源：Binance Futures 公开接口（无需 API Key）
 *   GET https://fapi.binance.com/fapi/v1/allForceOrders
 *
 * 用途：
 *   - 多头强平（long_squeeze）：价格下跌时多头被强平，后续可能反弹
 *   - 空头强平（short_squeeze）：价格上涨时空头被强平，可能加速上涨
 *   - 强平密集区域代表市场风险聚集点，辅助判断支撑/阻力
 */

import https from "https";

// 强制 IPv4（服务器 IPv6 不可达时）
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

// ─── 类型定义 ──────────────────────────────────────────

/** Binance 原始强平订单字段 */
interface RawForceOrder {
  symbol: string;
  price: string;          // 强平价格
  origQty: string;        // 数量（张）
  executedQty: string;    // 实际成交量
  averagePrice: string;   // 成交均价
  status: string;         // FILLED / PARTIALLY_FILLED
  timeInForce: string;
  type: string;           // LIMIT
  side: string;           // BUY (空头强平) | SELL (多头强平)
  time: number;           // 时间戳 ms
}

export interface LiquidationSummary {
  /** 多头强平总金额（USD）*/
  totalLongLiqUsd: number;
  /** 空头强平总金额（USD）*/
  totalShortLiqUsd: number;
  /** 净清算压力（正数 = 空头强平多 = 偏多信号）*/
  netLiqPressure: number;
  /** 主导方向 */
  dominance: "long_squeeze" | "short_squeeze" | "balanced";
  /** 主导比率（较大值/较小值，< 1.2 视为 balanced）*/
  dominanceRatio: number;
  /** 强平记录总数 */
  recordCount: number;
  /** 强平价格区间 */
  priceRange: { min: number; max: number };
  /** 生成时间戳 */
  generatedAt: number;
}

// ─── 内部请求 ──────────────────────────────────────────

function fetchForceOrders(
  symbol: string,
  startTime?: number,
  limit = 100
): Promise<RawForceOrder[]> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      symbol,
      limit: String(Math.min(limit, 1000)),
    });
    if (startTime !== undefined) {
      params.set("startTime", String(startTime));
    }

    const hostname = "fapi.binance.com";
    const path = `/fapi/v1/allForceOrders?${params.toString()}`;

    const req = https.request(
      {
        hostname,
        path,
        method: "GET",
        agent: ipv4Agent,
        headers: { "User-Agent": "openclaw-trader/1.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data) as RawForceOrder[] | { code: number; msg: string };
            if (!Array.isArray(json)) {
              reject(new Error(`Binance API error: ${JSON.stringify(json)}`));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("liquidation fetch timeout"));
    });
    req.end();
  });
}

// ─── 公开接口 ──────────────────────────────────────────

/**
 * 获取指定币种在过去 N 小时内的强平摘要
 *
 * @param symbol       合约品种，如 "BTCUSDT"
 * @param lookbackHours  回溯小时数（默认 24h）
 */
export async function getLiquidationData(
  symbol: string,
  lookbackHours = 24
): Promise<LiquidationSummary> {
  const startTime = Date.now() - lookbackHours * 3_600_000;
  const orders = await fetchForceOrders(symbol, startTime, 1000);

  let totalLongLiqUsd = 0;   // SELL 方向 = 多头被强平
  let totalShortLiqUsd = 0;  // BUY  方向 = 空头被强平
  let priceMin = Infinity;
  let priceMax = -Infinity;

  for (const o of orders) {
    const price = parseFloat(o.averagePrice) || parseFloat(o.price);
    const qty = parseFloat(o.executedQty) || parseFloat(o.origQty);
    const usd = price * qty;

    if (!isFinite(usd) || usd <= 0) continue;

    if (o.side === "SELL") {
      // 多头强平：价格下跌触发 SELL 强平
      totalLongLiqUsd += usd;
    } else {
      // 空头强平：价格上涨触发 BUY 强平
      totalShortLiqUsd += usd;
    }

    if (price < priceMin) priceMin = price;
    if (price > priceMax) priceMax = price;
  }

  const netLiqPressure = totalShortLiqUsd - totalLongLiqUsd;
  const larger = Math.max(totalLongLiqUsd, totalShortLiqUsd);
  const smaller = Math.min(totalLongLiqUsd, totalShortLiqUsd);
  const dominanceRatio = smaller > 0 ? larger / smaller : larger > 0 ? Infinity : 1;

  let dominance: LiquidationSummary["dominance"];
  if (dominanceRatio < 1.2) {
    dominance = "balanced";
  } else if (totalLongLiqUsd > totalShortLiqUsd) {
    dominance = "long_squeeze";
  } else {
    dominance = "short_squeeze";
  }

  return {
    totalLongLiqUsd,
    totalShortLiqUsd,
    netLiqPressure,
    dominance,
    dominanceRatio: isFinite(dominanceRatio) ? dominanceRatio : 0,
    recordCount: orders.length,
    priceRange: {
      min: isFinite(priceMin) ? priceMin : 0,
      max: isFinite(priceMax) ? priceMax : 0,
    },
    generatedAt: Date.now(),
  };
}

// ─── 格式化输出 ──────────────────────────────────────────

function fmtUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * 格式化清算报告（Telegram Markdown 兼容）
 */
export function formatLiquidationReport(
  summary: LiquidationSummary,
  symbol: string
): string {
  const coin = symbol.replace("USDT", "");
  const domEmoji =
    summary.dominance === "long_squeeze" ? "🔴" :
    summary.dominance === "short_squeeze" ? "🟢" : "⚪";

  const domLabel =
    summary.dominance === "long_squeeze" ? "多头爆仓（做多者受伤）" :
    summary.dominance === "short_squeeze" ? "空头爆仓（做空者受伤）" : "均衡";

  const netSign = summary.netLiqPressure >= 0 ? "+" : "";
  const netLabel = summary.netLiqPressure >= 0
    ? "偏多（空头爆仓更多）"
    : "偏空（多头爆仓更多）";

  const lines: string[] = [
    `💥 **${coin} 强平数据（过去24h）**\n`,
    `🔴 多头爆仓: ${fmtUsd(summary.totalLongLiqUsd)}`,
    `🟢 空头爆仓: ${fmtUsd(summary.totalShortLiqUsd)}`,
    `净压力: ${netSign}${fmtUsd(Math.abs(summary.netLiqPressure))} ${netLabel}`,
    `主导: ${domEmoji} ${domLabel}（比率 ${summary.dominanceRatio.toFixed(2)}x）`,
    `价格区间: $${summary.priceRange.min.toLocaleString()} — $${summary.priceRange.max.toLocaleString()}`,
    `样本数: ${summary.recordCount} 条`,
  ];

  return lines.join("\n");
}

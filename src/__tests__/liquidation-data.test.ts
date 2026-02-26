/**
 * 清算热力图模块测试（P5.3）
 *
 * 所有网络调用均 mock，不发真实请求。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import type { ClientRequest, IncomingMessage } from "http";
import { EventEmitter } from "events";

// ── 测试辅助：构造 mock https.request ──────────────────

interface MockRawOrder {
  symbol: string;
  price: string;
  origQty: string;
  executedQty: string;
  averagePrice: string;
  status: string;
  timeInForce: string;
  type: string;
  side: string;
  time: number;
}

function makeOrder(side: "BUY" | "SELL", price: number, qty: number): MockRawOrder {
  return {
    symbol: "BTCUSDT",
    price: String(price),
    origQty: String(qty),
    executedQty: String(qty),
    averagePrice: String(price),
    status: "FILLED",
    timeInForce: "IOC",
    type: "LIMIT",
    side,
    time: Date.now(),
  };
}

function mockHttpsRequest(responseBody: unknown) {
  return vi.spyOn(https, "request").mockImplementation(
    (_opts: unknown, callback?: ((res: IncomingMessage) => void) | undefined) => {
      const res = new EventEmitter() as IncomingMessage;
      // emit data + end asynchronously
      setTimeout(() => {
        res.emit("data", JSON.stringify(responseBody));
        res.emit("end");
      }, 0);
      if (callback) callback(res);

      const req = new EventEmitter() as ClientRequest;
      (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).end = () => {};
      (req as unknown as { end: () => void; setTimeout: (ms: number, cb: () => void) => void }).setTimeout = () => {};
      return req;
    }
  );
}

// ── 导入被测模块 ───────────────────────────────────────
import {
  getLiquidationData,
  formatLiquidationReport,
} from "../exchange/liquidation-data.js";
import type { LiquidationSummary } from "../exchange/liquidation-data.js";

// ── 辅助：构造 LiquidationSummary ─────────────────────
function makeSummary(overrides: Partial<LiquidationSummary> = {}): LiquidationSummary {
  return {
    totalLongLiqUsd: 5_000_000,
    totalShortLiqUsd: 2_000_000,
    netLiqPressure: -3_000_000,
    dominance: "long_squeeze",
    dominanceRatio: 2.5,
    recordCount: 42,
    priceRange: { min: 88_000, max: 92_000 },
    generatedAt: Date.now(),
    ...overrides,
  };
}

// ─── 单元测试 ──────────────────────────────────────────

describe("getLiquidationData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("空列表时返回零值摘要", async () => {
    mockHttpsRequest([]);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.totalLongLiqUsd).toBe(0);
    expect(summary.totalShortLiqUsd).toBe(0);
    expect(summary.recordCount).toBe(0);
    expect(summary.dominance).toBe("balanced");
  });

  it("只有多头爆仓（SELL）时 dominance = long_squeeze", async () => {
    const orders = [
      makeOrder("SELL", 90_000, 1),
      makeOrder("SELL", 91_000, 0.5),
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.totalLongLiqUsd).toBeGreaterThan(0);
    expect(summary.totalShortLiqUsd).toBe(0);
    expect(summary.dominance).toBe("long_squeeze");
  });

  it("只有空头爆仓（BUY）时 dominance = short_squeeze", async () => {
    const orders = [
      makeOrder("BUY", 90_000, 1),
      makeOrder("BUY", 91_000, 0.5),
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.totalShortLiqUsd).toBeGreaterThan(0);
    expect(summary.totalLongLiqUsd).toBe(0);
    expect(summary.dominance).toBe("short_squeeze");
  });

  it("净压力计算正确（空头爆仓 > 多头爆仓 → 正数）", async () => {
    const orders = [
      makeOrder("BUY", 90_000, 2),   // short liq: 180_000
      makeOrder("SELL", 90_000, 1),  // long  liq:  90_000
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    // netLiqPressure = shortLiq - longLiq = 180_000 - 90_000 = 90_000
    expect(summary.netLiqPressure).toBeCloseTo(90_000, -2);
  });

  it("均衡时 dominanceRatio < 1.2 → balanced", async () => {
    const orders = [
      makeOrder("BUY", 90_000, 1),
      makeOrder("SELL", 90_000, 1),
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.dominance).toBe("balanced");
    expect(summary.dominanceRatio).toBeCloseTo(1.0, 1);
  });

  it("priceRange 记录正确的最小/最大价格", async () => {
    const orders = [
      makeOrder("SELL", 88_000, 1),
      makeOrder("BUY", 92_000, 1),
      makeOrder("SELL", 90_000, 1),
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.priceRange.min).toBe(88_000);
    expect(summary.priceRange.max).toBe(92_000);
  });

  it("API 返回错误对象时抛出异常", async () => {
    mockHttpsRequest({ code: -1100, msg: "Invalid symbol" });
    await expect(getLiquidationData("INVALID", 24)).rejects.toThrow();
  });

  it("generatedAt 为合理时间戳", async () => {
    mockHttpsRequest([]);
    const before = Date.now();
    const summary = await getLiquidationData("BTCUSDT", 24);
    const after = Date.now();
    expect(summary.generatedAt).toBeGreaterThanOrEqual(before);
    expect(summary.generatedAt).toBeLessThanOrEqual(after);
  });
});

// ─── formatLiquidationReport 纯函数测试 ───────────────

describe("formatLiquidationReport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("包含币种名称", () => {
    const report = formatLiquidationReport(makeSummary(), "BTCUSDT");
    expect(report).toContain("BTC");
  });

  it("long_squeeze 时显示多头爆仓标签", () => {
    const report = formatLiquidationReport(makeSummary({ dominance: "long_squeeze" }), "BTCUSDT");
    expect(report).toContain("多头爆仓");
  });

  it("short_squeeze 时显示空头爆仓标签", () => {
    const report = formatLiquidationReport(
      makeSummary({ dominance: "short_squeeze", totalShortLiqUsd: 8_000_000, totalLongLiqUsd: 2_000_000, netLiqPressure: 6_000_000 }),
      "ETHUSDT"
    );
    expect(report).toContain("空头爆仓");
    expect(report).toContain("ETH");
  });

  it("balanced 时显示均衡标签", () => {
    const report = formatLiquidationReport(
      makeSummary({ dominance: "balanced", dominanceRatio: 1.05 }),
      "BTCUSDT"
    );
    expect(report).toContain("均衡");
  });

  it("金额格式化：百万级显示 M", () => {
    const report = formatLiquidationReport(makeSummary({ totalLongLiqUsd: 5_000_000 }), "BTCUSDT");
    expect(report).toMatch(/5\.00M/);
  });

  it("价格区间显示正确", () => {
    const report = formatLiquidationReport(
      makeSummary({ priceRange: { min: 88_000, max: 92_000 } }),
      "BTCUSDT"
    );
    expect(report).toContain("88,000");
    expect(report).toContain("92,000");
  });

  it("样本数正确显示", () => {
    const report = formatLiquidationReport(makeSummary({ recordCount: 99 }), "BTCUSDT");
    expect(report).toContain("99");
  });
});

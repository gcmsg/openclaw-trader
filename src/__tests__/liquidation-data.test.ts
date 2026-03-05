/**
 * Liquidation heatmap module tests (P5.3)
 *
 * All network calls are mocked; no real requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import type { ClientRequest, IncomingMessage } from "http";
import { EventEmitter } from "events";

// ── Test helper: construct mock https.request ──────────────────

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
    ((_opts: unknown, callback?: ((res: IncomingMessage) => void)  ) => {
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
    }) as unknown as typeof https.request
  );
}

// ── Import module under test ───────────────────────────────────────
import {
  getLiquidationData,
  formatLiquidationReport,
} from "../exchange/liquidation-data.js";
import type { LiquidationSummary } from "../exchange/liquidation-data.js";

// ── Helper: construct LiquidationSummary ─────────────────────
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

// ─── Unit tests ──────────────────────────────────────────

describe("getLiquidationData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero-value summary for empty list", async () => {
    mockHttpsRequest([]);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.totalLongLiqUsd).toBe(0);
    expect(summary.totalShortLiqUsd).toBe(0);
    expect(summary.recordCount).toBe(0);
    expect(summary.dominance).toBe("balanced");
  });

  it("dominance = long_squeeze when only long liquidations (SELL)", async () => {
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

  it("dominance = short_squeeze when only short liquidations (BUY)", async () => {
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

  it("net pressure calculated correctly (short liq > long liq → positive)", async () => {
    const orders = [
      makeOrder("BUY", 90_000, 2),   // short liq: 180_000
      makeOrder("SELL", 90_000, 1),  // long  liq:  90_000
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    // netLiqPressure = shortLiq - longLiq = 180_000 - 90_000 = 90_000
    expect(summary.netLiqPressure).toBeCloseTo(90_000, -2);
  });

  it("balanced when dominanceRatio < 1.2", async () => {
    const orders = [
      makeOrder("BUY", 90_000, 1),
      makeOrder("SELL", 90_000, 1),
    ];
    mockHttpsRequest(orders);
    const summary = await getLiquidationData("BTCUSDT", 24);
    expect(summary.dominance).toBe("balanced");
    expect(summary.dominanceRatio).toBeCloseTo(1.0, 1);
  });

  it("priceRange records correct min/max prices", async () => {
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

  it("throws when API returns error object", async () => {
    mockHttpsRequest({ code: -1100, msg: "Invalid symbol" });
    await expect(getLiquidationData("INVALID", 24)).rejects.toThrow();
  });

  it("generatedAt is a reasonable timestamp", async () => {
    mockHttpsRequest([]);
    const before = Date.now();
    const summary = await getLiquidationData("BTCUSDT", 24);
    const after = Date.now();
    expect(summary.generatedAt).toBeGreaterThanOrEqual(before);
    expect(summary.generatedAt).toBeLessThanOrEqual(after);
  });
});

// ─── formatLiquidationReport pure function tests ───────────────

describe("formatLiquidationReport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("contains coin name", () => {
    const report = formatLiquidationReport(makeSummary(), "BTCUSDT");
    expect(report).toContain("BTC");
  });

  it("shows long liquidation label for long_squeeze", () => {
    const report = formatLiquidationReport(makeSummary({ dominance: "long_squeeze" }), "BTCUSDT");
    expect(report).toContain("Long liquidations");
  });

  it("shows short liquidation label for short_squeeze", () => {
    const report = formatLiquidationReport(
      makeSummary({ dominance: "short_squeeze", totalShortLiqUsd: 8_000_000, totalLongLiqUsd: 2_000_000, netLiqPressure: 6_000_000 }),
      "ETHUSDT"
    );
    expect(report).toContain("Short liquidations");
    expect(report).toContain("ETH");
  });

  it("shows balanced label for balanced", () => {
    const report = formatLiquidationReport(
      makeSummary({ dominance: "balanced", dominanceRatio: 1.05 }),
      "BTCUSDT"
    );
    expect(report).toContain("Balanced");
  });

  it("amount formatting: millions display as M", () => {
    const report = formatLiquidationReport(makeSummary({ totalLongLiqUsd: 5_000_000 }), "BTCUSDT");
    expect(report).toMatch(/5\.00M/);
  });

  it("price range displays correctly", () => {
    const report = formatLiquidationReport(
      makeSummary({ priceRange: { min: 88_000, max: 92_000 } }),
      "BTCUSDT"
    );
    expect(report).toContain("88,000");
    expect(report).toContain("92,000");
  });

  it("sample count displays correctly", () => {
    const report = formatLiquidationReport(makeSummary({ recordCount: 99 }), "BTCUSDT");
    expect(report).toContain("99");
  });
});

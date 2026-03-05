/**
 * Macro market data tests
 *
 * Covers: getDxy / getSP500 / getVix / getMacroContext / formatMacroReport
 *         and internal parseFredCsv / buildMacroAsset indirectly tested via public API
 *
 * All https calls are mocked via vi.spyOn(https, 'request'); no real requests are made.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import https from "https";
import { EventEmitter } from "events";

import {
  getDxy,
  getSP500,
  getVix,
  getMacroContext,
  formatMacroReport,
} from "../exchange/macro-data.js";
import type { MacroContext } from "../exchange/macro-data.js";

// ─── Mock helpers ─────────────────────────────────────────────────

/** Simulate FRED CSV response (8 data rows, first row is header) */
function makeFredCsv(values: number[]): string {
  const rows = values.map((v, i) => {
    const d = new Date("2025-02-01");
    d.setDate(d.getDate() + i);
    return `${d.toISOString().slice(0, 10)},${v}`;
  });
  return `DATE,VALUE\n${rows.join("\n")}`;
}

/** Make https.request always return the given CSV string */
function mockCsvRequest(csv: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(https, "request").mockImplementation((_opts: any, callback: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = new EventEmitter();
    req.end = vi.fn();
    req.destroy = vi.fn();
    req.setTimeout = vi.fn();

    setImmediate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = new EventEmitter();
      res.statusCode = 200;
      if (typeof callback === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callback as any)(res);
      }
      setImmediate(() => {
        res.emit("data", csv);
        res.emit("end");
      });
    });

    return req as unknown as ReturnType<typeof https.request>;
  });
}

/** Make https.request emit an error event */
function mockNetworkError() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(https, "request").mockImplementation((_opts: any, _cb: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = new EventEmitter();
    req.end = vi.fn();
    req.destroy = vi.fn();
    req.setTimeout = vi.fn();
    setImmediate(() => { req.emit("error", new Error("ECONNREFUSED")); });
    return req as unknown as ReturnType<typeof https.request>;
  });
}

// ─── getDxy ──────────────────────────────────────────────────────

describe("getDxy", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("correctly parses CSV and returns MacroAsset", async () => {
    // Price from 103.0 to 104.0 (sustained rise, bullish)
    const csv = makeFredCsv([103.0, 103.1, 103.2, 103.4, 103.6, 103.7, 103.9, 104.0]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("DXY");
    expect(asset?.name).toContain("DXY Dollar Index");
    expect(asset?.price).toBeCloseTo(104.0);
  });

  it("sustained rise → trend=bullish (change1d > 0.2 and change5d > 0.3)", async () => {
    const csv = makeFredCsv([100.0, 100.2, 100.5, 100.8, 101.0, 101.2, 101.5, 101.8]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset?.trend).toBe("bullish");
  });

  it("sustained decline → trend=bearish", async () => {
    const csv = makeFredCsv([105.0, 104.8, 104.5, 104.2, 104.0, 103.8, 103.5, 103.2]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset?.trend).toBe("bearish");
  });

  it("returns null on network failure (no throw)", async () => {
    mockNetworkError();
    const asset = await getDxy();
    expect(asset).toBeNull();
  });

  it("returns null when CSV has fewer than 2 data rows", async () => {
    mockCsvRequest("DATE,VALUE\n2025-02-01,103.5\n");
    const asset = await getDxy();
    expect(asset).toBeNull();
  });
});

// ─── getSP500 ─────────────────────────────────────────────────────

describe("getSP500", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("correctly parses and returns symbol=SPX", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070]);
    mockCsvRequest(csv);

    const asset = await getSP500();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("SPX");
    expect(asset?.price).toBeCloseTo(5070);
  });

  it("includes change info (change1d and change5d)", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070]);
    mockCsvRequest(csv);

    const asset = await getSP500();
    expect(typeof asset?.change1d).toBe("number");
    expect(typeof asset?.change5d).toBe("number");
  });

  it("returns null on network failure", async () => {
    mockNetworkError();
    expect(await getSP500()).toBeNull();
  });

  it("trendLabel contains percentage symbol", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5080]);
    mockCsvRequest(csv);
    const asset = await getSP500();
    expect(asset?.trendLabel).toContain("%");
  });
});

// ─── getVix ──────────────────────────────────────────────────────

describe("getVix", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("correctly parses and returns symbol=VIX", async () => {
    const csv = makeFredCsv([18.0, 18.2, 18.5, 19.0, 19.2, 19.5, 20.0, 20.5]);
    mockCsvRequest(csv);

    const asset = await getVix();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("VIX");
  });

  it("VIX price > 25 can be used by upstream for panic detection", async () => {
    const csv = makeFredCsv([22, 23, 24, 25, 26, 27, 28, 30]);
    mockCsvRequest(csv);

    const asset = await getVix();
    expect(asset?.price).toBeGreaterThan(25);
  });

  it("returns null on network failure", async () => {
    mockNetworkError();
    expect(await getVix()).toBeNull();
  });
});

// ─── getMacroContext ──────────────────────────────────────────────

describe("getMacroContext", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns cryptoEnvironment=unknown when all data sources fail", async () => {
    mockNetworkError();
    const ctx = await getMacroContext();
    expect(ctx.cryptoEnvironment).toBe("unknown");
    expect(ctx.dxy).toBeNull();
    expect(ctx.spx).toBeNull();
    expect(ctx.vix).toBeNull();
  });

  it("weak USD + strong stocks → cryptoEnvironment=risk_on", async () => {
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(https, "request").mockImplementation((_opts: any, callback: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      const csvs = [
        makeFredCsv([105.0, 104.8, 104.5, 104.2, 104.0, 103.8, 103.5, 103.2]), // DXY falling
        makeFredCsv([5000,  5010,  5020,  5030,  5040,  5050,  5060,  5080]),   // SPX rising
        makeFredCsv([18.0,  17.8,  17.5,  17.2,  17.0,  16.8,  16.5,  16.2]),  // VIX low
      ];
      const csv = csvs[callIndex++ % 3] ?? csvs[0]!;

      setImmediate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = new EventEmitter();
        if (typeof callback === "function") (callback as any)(res);
        setImmediate(() => {
          res.emit("data", csv);
          res.emit("end");
        });
      });
      return req as unknown as ReturnType<typeof https.request>;
    });

    const ctx = await getMacroContext();
    expect(ctx.cryptoEnvironment).toBe("risk_on");
    expect(ctx.cryptoEnvironmentLabel).toContain("🟢");
  });

  it("VIX > 25 → cryptoEnvironment=risk_off", async () => {
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(https, "request").mockImplementation((_opts: any, callback: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      const csvs = [
        makeFredCsv([103.0, 103.1, 103.2, 103.3, 103.4, 103.5, 103.6, 103.7]), // DXY neutral
        makeFredCsv([5000,  5010,  5020,  5030,  5040,  5050,  5060,  5070]),   // SPX neutral
        makeFredCsv([22.0,  23.0,  24.0,  25.0,  26.0,  27.0,  28.0,  30.0]),  // VIX > 25
      ];
      const csv = csvs[callIndex++ % 3] ?? csvs[0]!;

      setImmediate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = new EventEmitter();
        if (typeof callback === "function") (callback as any)(res);
        setImmediate(() => {
          res.emit("data", csv);
          res.emit("end");
        });
      });
      return req as unknown as ReturnType<typeof https.request>;
    });

    const ctx = await getMacroContext();
    expect(ctx.cryptoEnvironment).toBe("risk_off");
    expect(ctx.summary).toContain("VIX");
  });

  it("fetchedAt is a current timestamp", async () => {
    mockNetworkError();
    const before = Date.now();
    const ctx = await getMacroContext();
    const after = Date.now();
    expect(ctx.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.fetchedAt).toBeLessThanOrEqual(after);
  });
});

// ─── formatMacroReport ────────────────────────────────────────────

describe("formatMacroReport", () => {
  function makeCtx(overrides: Partial<MacroContext> = {}): MacroContext {
    return {
      dxy: {
        symbol: "DXY", name: "DXY Dollar Index",
        price: 103.5, change1d: -0.3, change5d: -0.8,
        trend: "bearish", trendLabel: "📉 -0.30% 1d / -0.80% 5d",
      },
      spx: {
        symbol: "SPX", name: "S&P 500 SPX",
        price: 5070, change1d: 0.5, change5d: 1.2,
        trend: "bullish", trendLabel: "📈 +0.50% 1d / +1.20% 5d",
      },
      vix: {
        symbol: "VIX", name: "VIX Fear Index",
        price: 18.5, change1d: -0.2, change5d: -0.5,
        trend: "bearish", trendLabel: "📉 -0.20% 1d / -0.50% 5d",
      },
      cryptoEnvironment: "risk_on",
      cryptoEnvironmentLabel: "🟢 Macro favorable (weak dollar + stocks up)",
      summary: "Dollar decline combined with stock rally, risk appetite improving, bullish for crypto",
      fetchedAt: Date.now(),
      ...overrides,
    };
  }

  it("contains DXY info", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("DXY");
    expect(report).toContain("103.5");
  });

  it("contains SPX info", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("SPX");
    expect(report).toContain("5070");
  });

  it("contains VIX info", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("VIX");
    expect(report).toContain("18.5");
  });

  it("shows extreme panic warning when VIX > 30", () => {
    const ctx = makeCtx({
      vix: {
        symbol: "VIX", name: "VIX Fear Index",
        price: 35.0, change1d: 2.0, change5d: 5.0,
        trend: "bullish", trendLabel: "📈 +2.00% 1d",
      },
    });
    const report = formatMacroReport(ctx);
    expect(report).toContain("Extreme panic");
  });

  it("shows degraded info when DXY data is missing", () => {
    const ctx = makeCtx({ dxy: null });
    const report = formatMacroReport(ctx);
    expect(report).toContain("Failed");
  });

  it("contains cryptoEnvironmentLabel", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("🟢 Macro favorable");
  });

  it("contains summary content", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("Dollar decline combined with stock rally");
  });
});

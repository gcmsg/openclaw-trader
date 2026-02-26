/**
 * 宏观市场数据测试
 *
 * 覆盖：getDxy / getSP500 / getVix / getMacroContext / formatMacroReport
 *       以及内部的 parseFredCsv / buildMacroAsset 通过公开 API 间接测试
 *
 * 所有 https 调用均通过 vi.spyOn(https, 'request') mock，不发真实请求。
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

/** 模拟 FRED CSV 响应（8 行数据，首行 header） */
function makeFredCsv(values: number[]): string {
  const rows = values.map((v, i) => {
    const d = new Date("2025-02-01");
    d.setDate(d.getDate() + i);
    return `${d.toISOString().slice(0, 10)},${v}`;
  });
  return `DATE,VALUE\n${rows.join("\n")}`;
}

/** 让 https.request 始终返回给定 CSV 字符串 */
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

/** 让 https.request 触发 error 事件 */
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

  it("正常解析 CSV 返回 MacroAsset", async () => {
    // 价格从 103.0 到 104.0（持续上涨，bullish）
    const csv = makeFredCsv([103.0, 103.1, 103.2, 103.4, 103.6, 103.7, 103.9, 104.0]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("DXY");
    expect(asset?.name).toContain("美元");
    expect(asset?.price).toBeCloseTo(104.0);
  });

  it("数据持续上涨 → trend=bullish（change1d > 0.2 且 change5d > 0.3）", async () => {
    const csv = makeFredCsv([100.0, 100.2, 100.5, 100.8, 101.0, 101.2, 101.5, 101.8]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset?.trend).toBe("bullish");
  });

  it("数据持续下跌 → trend=bearish", async () => {
    const csv = makeFredCsv([105.0, 104.8, 104.5, 104.2, 104.0, 103.8, 103.5, 103.2]);
    mockCsvRequest(csv);

    const asset = await getDxy();
    expect(asset?.trend).toBe("bearish");
  });

  it("网络故障时返回 null（不抛出）", async () => {
    mockNetworkError();
    const asset = await getDxy();
    expect(asset).toBeNull();
  });

  it("CSV 数据不足 2 行时返回 null", async () => {
    mockCsvRequest("DATE,VALUE\n2025-02-01,103.5\n");
    const asset = await getDxy();
    expect(asset).toBeNull();
  });
});

// ─── getSP500 ─────────────────────────────────────────────────────

describe("getSP500", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("正常解析返回 symbol=SPX", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070]);
    mockCsvRequest(csv);

    const asset = await getSP500();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("SPX");
    expect(asset?.price).toBeCloseTo(5070);
  });

  it("包含涨跌幅信息（change1d 和 change5d）", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070]);
    mockCsvRequest(csv);

    const asset = await getSP500();
    expect(typeof asset?.change1d).toBe("number");
    expect(typeof asset?.change5d).toBe("number");
  });

  it("网络故障时返回 null", async () => {
    mockNetworkError();
    expect(await getSP500()).toBeNull();
  });

  it("trendLabel 包含百分比符号", async () => {
    const csv = makeFredCsv([5000, 5010, 5020, 5030, 5040, 5050, 5060, 5080]);
    mockCsvRequest(csv);
    const asset = await getSP500();
    expect(asset?.trendLabel).toContain("%");
  });
});

// ─── getVix ──────────────────────────────────────────────────────

describe("getVix", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("正常解析返回 symbol=VIX", async () => {
    const csv = makeFredCsv([18.0, 18.2, 18.5, 19.0, 19.2, 19.5, 20.0, 20.5]);
    mockCsvRequest(csv);

    const asset = await getVix();
    expect(asset).not.toBeNull();
    expect(asset?.symbol).toBe("VIX");
  });

  it("VIX 价格 > 25 可被上层用于检测恐慌", async () => {
    const csv = makeFredCsv([22, 23, 24, 25, 26, 27, 28, 30]);
    mockCsvRequest(csv);

    const asset = await getVix();
    expect(asset?.price).toBeGreaterThan(25);
  });

  it("网络故障时返回 null", async () => {
    mockNetworkError();
    expect(await getVix()).toBeNull();
  });
});

// ─── getMacroContext ──────────────────────────────────────────────

describe("getMacroContext", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("所有数据源均失败时返回 cryptoEnvironment=unknown", async () => {
    mockNetworkError();
    const ctx = await getMacroContext();
    expect(ctx.cryptoEnvironment).toBe("unknown");
    expect(ctx.dxy).toBeNull();
    expect(ctx.spx).toBeNull();
    expect(ctx.vix).toBeNull();
  });

  it("美元弱 + 美股强 → cryptoEnvironment=risk_on", async () => {
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(https, "request").mockImplementation((_opts: any, callback: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      const csvs = [
        makeFredCsv([105.0, 104.8, 104.5, 104.2, 104.0, 103.8, 103.5, 103.2]), // DXY 下跌
        makeFredCsv([5000,  5010,  5020,  5030,  5040,  5050,  5060,  5080]),   // SPX 上涨
        makeFredCsv([18.0,  17.8,  17.5,  17.2,  17.0,  16.8,  16.5,  16.2]),  // VIX 低
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
        makeFredCsv([103.0, 103.1, 103.2, 103.3, 103.4, 103.5, 103.6, 103.7]), // DXY 中性
        makeFredCsv([5000,  5010,  5020,  5030,  5040,  5050,  5060,  5070]),   // SPX 中性
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

  it("fetchedAt 是当前时间戳", async () => {
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
        symbol: "DXY", name: "美元指数 DXY",
        price: 103.5, change1d: -0.3, change5d: -0.8,
        trend: "bearish", trendLabel: "📉 -0.30% 昨日 / -0.80% 近5日",
      },
      spx: {
        symbol: "SPX", name: "标普500 SPX",
        price: 5070, change1d: 0.5, change5d: 1.2,
        trend: "bullish", trendLabel: "📈 +0.50% 昨日 / +1.20% 近5日",
      },
      vix: {
        symbol: "VIX", name: "恐惧指数 VIX",
        price: 18.5, change1d: -0.2, change5d: -0.5,
        trend: "bearish", trendLabel: "📉 -0.20% 昨日 / -0.50% 近5日",
      },
      cryptoEnvironment: "risk_on",
      cryptoEnvironmentLabel: "🟢 宏观有利（美元弱 + 美股涨）",
      summary: "美元回落叠加美股上涨，风险偏好改善",
      fetchedAt: Date.now(),
      ...overrides,
    };
  }

  it("包含 DXY 信息", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("DXY");
    expect(report).toContain("103.5");
  });

  it("包含 SPX 信息", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("SPX");
    expect(report).toContain("5070");
  });

  it("包含 VIX 信息", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("VIX");
    expect(report).toContain("18.5");
  });

  it("VIX > 30 时显示极度恐慌警告", () => {
    const ctx = makeCtx({
      vix: {
        symbol: "VIX", name: "恐惧指数 VIX",
        price: 35.0, change1d: 2.0, change5d: 5.0,
        trend: "bullish", trendLabel: "📈 +2.00% 昨日",
      },
    });
    const report = formatMacroReport(ctx);
    expect(report).toContain("极度恐慌");
  });

  it("DXY 数据缺失时显示降级信息", () => {
    const ctx = makeCtx({ dxy: null });
    const report = formatMacroReport(ctx);
    expect(report).toContain("失败");
  });

  it("包含 cryptoEnvironmentLabel", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("🟢 宏观有利");
  });

  it("包含 summary 内容", () => {
    const report = formatMacroReport(makeCtx());
    expect(report).toContain("美元回落叠加美股上涨");
  });
});

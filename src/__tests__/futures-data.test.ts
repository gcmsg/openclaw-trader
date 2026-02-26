/**
 * Binance Futures 公开市场数据测试
 *
 * 覆盖：getFundingRate / getFundingRates / getOpenInterest /
 *       getFuturesMarketData / getBatchFuturesData / formatFundingRateReport
 *
 * 所有 https 调用均通过 vi.spyOn(https, 'request') mock，不发真实请求。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import https from "https";
import { EventEmitter } from "events";

import {
  getFundingRate,
  getFundingRates,
  getOpenInterest,
  getFuturesMarketData,
  getBatchFuturesData,
  formatFundingRateReport,
} from "../exchange/futures-data.js";
import type { FuturesMarketData } from "../exchange/futures-data.js";

// ─── Mock helpers ─────────────────────────────────────────────────

/** 构建根据路径返回不同响应的 https.request mock */
function mockHttpsRequest(responses: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(https, "request").mockImplementation((opts: any, callback: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = new EventEmitter();
    req.end = vi.fn();
    req.destroy = vi.fn();
    req.setTimeout = vi.fn();

    const path = (opts.path ?? opts.pathname ?? "") as string;
    let body: unknown = {};

    for (const [key, val] of Object.entries(responses)) {
      if (path.includes(key)) {
        body = val;
        break;
      }
    }

    setImmediate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = new EventEmitter();
      res.statusCode = 200;
      if (typeof callback === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callback as any)(res);
      }
      setImmediate(() => {
        res.emit("data", JSON.stringify(body));
        res.emit("end");
      });
    });

    return req as unknown as ReturnType<typeof https.request>;
  });
}

// ─── Mock 数据 ────────────────────────────────────────────────────

const MOCK_PREMIUM_INDEX = {
  symbol: "BTCUSDT",
  markPrice: "63050.0",
  indexPrice: "63000.0",
  lastFundingRate: "0.0003",   // +0.03%
  nextFundingTime: Date.now() + 3600000,
};

const MOCK_OI_CURRENT = {
  symbol: "BTCUSDT",
  openInterest: "10000.0",
  time: Date.now(),
};

const MOCK_OI_HISTORY = [
  { symbol: "BTCUSDT", sumOpenInterest: "9500.0", sumOpenInterestValue: "598500000", timestamp: Date.now() - 4 * 3600000 },
  { symbol: "BTCUSDT", sumOpenInterest: "9600.0", sumOpenInterestValue: "604800000", timestamp: Date.now() - 3 * 3600000 },
  { symbol: "BTCUSDT", sumOpenInterest: "9700.0", sumOpenInterestValue: "611100000", timestamp: Date.now() - 2 * 3600000 },
  { symbol: "BTCUSDT", sumOpenInterest: "9800.0", sumOpenInterestValue: "617400000", timestamp: Date.now() - 1 * 3600000 },
  { symbol: "BTCUSDT", sumOpenInterest: "9900.0", sumOpenInterestValue: "623700000", timestamp: Date.now() },
];

// ─── getFundingRate ───────────────────────────────────────────────

describe("getFundingRate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常返回解析后的 FundingRate", async () => {
    mockHttpsRequest({ premiumIndex: MOCK_PREMIUM_INDEX });
    const fr = await getFundingRate("BTCUSDT");
    expect(fr.symbol).toBe("BTCUSDT");
    expect(fr.fundingRate).toBeCloseTo(0.0003);
    expect(fr.fundingRateStr).toContain("+");
  });

  it("资金费率 > 0.001 → overlong sentiment", async () => {
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, lastFundingRate: "0.0015" },
    });
    const fr = await getFundingRate("BTCUSDT");
    expect(fr.sentiment).toBe("overlong");
    expect(fr.sentimentLabel).toContain("多头严重过热");
  });

  it("资金费率 < -0.0005 → overshort sentiment", async () => {
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, lastFundingRate: "-0.0008" },
    });
    const fr = await getFundingRate("BTCUSDT");
    expect(fr.sentiment).toBe("overshort");
    expect(fr.sentimentLabel).toContain("空头过热");
  });

  it("资金费率 0 ~ 0.0003 → neutral_long", async () => {
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, lastFundingRate: "0.0001" },
    });
    const fr = await getFundingRate("BTCUSDT");
    expect(fr.sentiment).toBe("neutral_long");
  });

  it("nextFundingTime 被正确传递", async () => {
    const nextTime = Date.now() + 7200000;
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, nextFundingTime: nextTime },
    });
    const fr = await getFundingRate("BTCUSDT");
    expect(fr.nextFundingTime).toBe(nextTime);
  });
});

// ─── getFundingRates ──────────────────────────────────────────────

describe("getFundingRates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("并发获取多个 symbol 的资金费率", async () => {
    mockHttpsRequest({ premiumIndex: MOCK_PREMIUM_INDEX });
    const map = await getFundingRates(["BTCUSDT", "ETHUSDT"]);
    expect(map.size).toBe(2);
    expect(map.has("BTCUSDT")).toBe(true);
    expect(map.has("ETHUSDT")).toBe(true);
  });

  it("空数组返回空 Map", async () => {
    mockHttpsRequest({});
    const map = await getFundingRates([]);
    expect(map.size).toBe(0);
  });

  it("某个 symbol 请求失败时不影响其他结果", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(https, "request").mockImplementation((_opts: any, callback: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();

      callCount++;
      if (callCount === 1) {
        // 第一个请求成功
        setImmediate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = new EventEmitter();
          if (typeof callback === "function") (callback as any)(res);
          setImmediate(() => {
            res.emit("data", JSON.stringify(MOCK_PREMIUM_INDEX));
            res.emit("end");
          });
        });
      } else {
        // 第二个请求失败
        setImmediate(() => { req.emit("error", new Error("network error")); });
      }

      return req as unknown as ReturnType<typeof https.request>;
    });

    const map = await getFundingRates(["BTCUSDT", "ETHUSDT"]);
    expect(map.size).toBe(1);
    expect(map.has("BTCUSDT")).toBe(true);
  });
});

// ─── getOpenInterest ──────────────────────────────────────────────

describe("getOpenInterest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常返回解析后的 OpenInterest", async () => {
    mockHttpsRequest({
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const oi = await getOpenInterest("BTCUSDT", 63000);
    expect(oi.symbol).toBe("BTCUSDT");
    expect(oi.openInterest).toBeCloseTo(10000);
    expect(oi.openInterestUsdt).toBeCloseTo(10000 * 63000);
  });

  it("OI 1h 增长 > 0.5% → trend=rising", async () => {
    // 当前 10000，1h 前 9900，变化 +1.01%
    mockHttpsRequest({
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const oi = await getOpenInterest("BTCUSDT", 63000);
    expect(oi.trend).toBe("rising");
  });

  it("OI 1h 下降 > 0.5% → trend=falling", async () => {
    const histFalling = [
      { symbol: "BTCUSDT", sumOpenInterest: "10500.0", sumOpenInterestValue: "661500000", timestamp: Date.now() - 4 * 3600000 },
      { symbol: "BTCUSDT", sumOpenInterest: "10400.0", sumOpenInterestValue: "655200000", timestamp: Date.now() - 3 * 3600000 },
      { symbol: "BTCUSDT", sumOpenInterest: "10300.0", sumOpenInterestValue: "648900000", timestamp: Date.now() - 2 * 3600000 },
      { symbol: "BTCUSDT", sumOpenInterest: "10200.0", sumOpenInterestValue: "642600000", timestamp: Date.now() - 1 * 3600000 },
      { symbol: "BTCUSDT", sumOpenInterest: "10100.0", sumOpenInterestValue: "636300000", timestamp: Date.now() },
    ];
    mockHttpsRequest({
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,  // 10000
      "openInterestHist": histFalling,           // 1h 前 10100 → 下降
    });
    const oi = await getOpenInterest("BTCUSDT", 63000);
    // 当前 10000，1h 前 10100，变化 ≈ -0.99% → falling
    expect(oi.trend).toBe("falling");
  });

  it("changePercent1h 和 changePercent4h 均有值", async () => {
    mockHttpsRequest({
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const oi = await getOpenInterest("BTCUSDT", 63000);
    expect(typeof oi.changePercent1h).toBe("number");
    expect(typeof oi.changePercent4h).toBe("number");
  });
});

// ─── getFuturesMarketData ─────────────────────────────────────────

describe("getFuturesMarketData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("综合返回 symbol / fundingRate / openInterest / combinedSignal", async () => {
    mockHttpsRequest({
      premiumIndex: MOCK_PREMIUM_INDEX,
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const data = await getFuturesMarketData("BTCUSDT", 63000);
    expect(data.symbol).toBe("BTCUSDT");
    expect(data.fundingRate.symbol).toBe("BTCUSDT");
    expect(data.openInterest.symbol).toBe("BTCUSDT");
    expect(["bullish", "bearish", "neutral", "extreme_long", "extreme_short"]).toContain(data.combinedSignal);
  });

  it("资金费率 > 0.001 且 OI rising → extreme_long", async () => {
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, lastFundingRate: "0.0015" },
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,   // OI rising
    });
    const data = await getFuturesMarketData("BTCUSDT", 63000);
    expect(data.combinedSignal).toBe("extreme_long");
    expect(data.combinedLabel).toContain("多头极度过热");
  });

  it("资金费率 < -0.0005 且 OI rising → extreme_short", async () => {
    mockHttpsRequest({
      premiumIndex: { ...MOCK_PREMIUM_INDEX, lastFundingRate: "-0.0008" },
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const data = await getFuturesMarketData("BTCUSDT", 63000);
    expect(data.combinedSignal).toBe("extreme_short");
  });

  it("combinedLabel 不为空字符串", async () => {
    mockHttpsRequest({
      premiumIndex: MOCK_PREMIUM_INDEX,
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const data = await getFuturesMarketData("BTCUSDT", 63000);
    expect(data.combinedLabel.length).toBeGreaterThan(0);
  });
});

// ─── getBatchFuturesData ──────────────────────────────────────────

describe("getBatchFuturesData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("并发返回多个 symbol 的数据", async () => {
    mockHttpsRequest({
      premiumIndex: MOCK_PREMIUM_INDEX,
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const map = await getBatchFuturesData(
      ["BTCUSDT", "ETHUSDT"],
      { BTCUSDT: 63000, ETHUSDT: 3000 }
    );
    expect(map.size).toBe(2);
  });

  it("symbol 不在 prices 中时使用 0 作为价格", async () => {
    mockHttpsRequest({
      premiumIndex: MOCK_PREMIUM_INDEX,
      "/fapi/v1/openInterest": MOCK_OI_CURRENT,
      "openInterestHist": MOCK_OI_HISTORY,
    });
    const map = await getBatchFuturesData(["BTCUSDT"], {});
    expect(map.has("BTCUSDT")).toBe(true);
  });
});

// ─── formatFundingRateReport ──────────────────────────────────────

describe("formatFundingRateReport", () => {
  /** 构造一个完整的 FuturesMarketData mock */
  function makeMockData(
    symbol: string,
    rate: number,
    sentiment: "overlong" | "overbought" | "neutral_long" | "neutral_short" | "overshort",
    oiTrend: "rising" | "falling" | "flat",
    combined: FuturesMarketData["combinedSignal"]
  ): FuturesMarketData {
    return {
      symbol,
      fundingRate: {
        symbol,
        fundingRate: rate,
        fundingRateStr: `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%`,
        nextFundingTime: Date.now() + 3600000,
        sentiment,
        sentimentLabel: "test",
      },
      openInterest: {
        symbol,
        openInterest: 10000,
        openInterestUsdt: 630000000,
        changePercent1h: oiTrend === "rising" ? 1.5 : oiTrend === "falling" ? -1.5 : 0.1,
        changePercent4h: 2.0,
        trend: oiTrend,
        trendLabel: oiTrend === "rising" ? "上升 +1.5%" : oiTrend === "falling" ? "下降 -1.5%" : "平稳 0.1%",
      },
      combinedSignal: combined,
      combinedLabel: combined === "bullish" ? "📈 多头占优" : "⚖️ 中性",
    };
  }

  it("报告包含 symbol 名称", () => {
    const map = new Map<string, FuturesMarketData>();
    map.set("BTCUSDT", makeMockData("BTCUSDT", 0.0003, "neutral_long", "rising", "bullish"));
    const report = formatFundingRateReport(map);
    expect(report).toContain("BTC");
  });

  it("报告包含资金费率百分比字符串", () => {
    const map = new Map<string, FuturesMarketData>();
    map.set("BTCUSDT", makeMockData("BTCUSDT", 0.0003, "neutral_long", "rising", "bullish"));
    const report = formatFundingRateReport(map);
    expect(report).toContain("+0.0300%");
  });

  it("高资金费率显示红色标识", () => {
    const map = new Map<string, FuturesMarketData>();
    map.set("BTCUSDT", makeMockData("BTCUSDT", 0.0008, "overlong", "rising", "extreme_long"));
    const report = formatFundingRateReport(map);
    expect(report).toContain("🔴");
  });

  it("低资金费率（负值）显示绿色标识", () => {
    const map = new Map<string, FuturesMarketData>();
    map.set("BTCUSDT", makeMockData("BTCUSDT", -0.0005, "overshort", "rising", "extreme_short"));
    const report = formatFundingRateReport(map);
    expect(report).toContain("🟢");
  });

  it("多个 symbol 均包含在报告中", () => {
    const map = new Map<string, FuturesMarketData>();
    map.set("BTCUSDT", makeMockData("BTCUSDT", 0.0001, "neutral_long", "flat", "neutral"));
    map.set("ETHUSDT", makeMockData("ETHUSDT", 0.0002, "neutral_long", "rising", "bullish"));
    const report = formatFundingRateReport(map);
    expect(report).toContain("BTC");
    expect(report).toContain("ETH");
  });

  it("空 Map 返回只有标题的报告，不报错", () => {
    const map = new Map<string, FuturesMarketData>();
    expect(() => formatFundingRateReport(map)).not.toThrow();
    const report = formatFundingRateReport(map);
    expect(report).toContain("资金费率");
  });
});

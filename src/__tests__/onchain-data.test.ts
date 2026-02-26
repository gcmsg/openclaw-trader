/**
 * 链上数据模块测试
 *
 * 覆盖：getStablecoinFlows / getBtcNetworkMetrics / getOnChainContext / formatOnChainReport
 *
 * 所有 https 调用均通过 vi.spyOn(https, 'request') mock，不发真实请求。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import https from "https";
import { EventEmitter } from "events";

import {
  getStablecoinFlows,
  getBtcNetworkMetrics,
  getOnChainContext,
  formatOnChainReport,
} from "../exchange/onchain-data.js";
import type { OnChainContext } from "../exchange/onchain-data.js";

// ─── Mock helpers ─────────────────────────────────────────────────

/** 根据请求 hostname 返回不同的 JSON 响应 */
function mockHttpsByHost(responses: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(https, "request").mockImplementation((opts: any, callback: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = new EventEmitter();
    req.end = vi.fn();
    req.destroy = vi.fn();
    req.setTimeout = vi.fn();

    const hostname = (opts.hostname ?? "") as string;
    let body: unknown = {};

    for (const [key, val] of Object.entries(responses)) {
      if (hostname.includes(key)) {
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

/** 让所有 https 请求触发网络错误 */
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

// ─── Mock 数据 ────────────────────────────────────────────────────

/** DeFiLlama 稳定币响应（USDT + USDC 均增发） */
const MOCK_LLAMA_RESPONSE = {
  peggedAssets: [
    {
      symbol: "USDT",
      name: "Tether",
      circulating: { peggedUSD: 120_000_000_000 },          // 120B
      circulatingPrevDay: { peggedUSD: 119_900_000_000 },    // +100M 1d
      circulatingPrevWeek: { peggedUSD: 116_000_000_000 },   // +4B 7d
      circulatingPrevMonth: { peggedUSD: 110_000_000_000 },  // +10B 30d
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      circulating: { peggedUSD: 45_000_000_000 },
      circulatingPrevDay: { peggedUSD: 44_950_000_000 },
      circulatingPrevWeek: { peggedUSD: 43_000_000_000 },    // +2B 7d
      circulatingPrevMonth: { peggedUSD: 40_000_000_000 },
    },
  ],
};

/** Blockchair BTC 统计 */
const MOCK_BLOCKCHAIR_STATS = {
  data: {
    transactions_24h: 350_000,
    volume_24h: 1_500_000_000_000_000,  // satoshi
    mempool_transactions: 50_000,
    mempool_size: 150_000_000,           // bytes → 150MB
    difficulty: 110_000_000_000_000,
    hashrate_24h: "800000000000000000",
    estimated_transaction_volume_usd: 25_000_000_000,
  },
};

/** blockchain.info 统计 */
const MOCK_BLOCKCHAIN_INFO = {
  trade_volume_usd: 1_000_000,
  estimated_transaction_volume_usd: 25_000_000_000,
  n_tx: 350_000,
  market_price_usd: 63000,
};

// ─── getStablecoinFlows ───────────────────────────────────────────

describe("getStablecoinFlows", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("正常返回 USDT 和 USDC 两条记录", async () => {
    mockHttpsByHost({ "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE });
    const flows = await getStablecoinFlows();
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => f.symbol)).toContain("USDT");
    expect(flows.map((f) => f.symbol)).toContain("USDC");
  });

  it("circulatingB 与原始数据一致（单位 $B）", async () => {
    mockHttpsByHost({ "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE });
    const flows = await getStablecoinFlows();
    const usdt = flows.find((f) => f.symbol === "USDT");
    expect(usdt?.circulatingB).toBeCloseTo(120);
  });

  it("7d 变化 > 1B → trend=expanding", async () => {
    mockHttpsByHost({ "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE });
    const flows = await getStablecoinFlows();
    // USDT 7d +4B, USDC 7d +2B → both expanding
    for (const f of flows) {
      expect(f.trend).toBe("expanding");
    }
  });

  it("7d 变化 < -1B → trend=contracting", async () => {
    const contractingResponse = {
      peggedAssets: [
        {
          symbol: "USDT",
          name: "Tether",
          circulating: { peggedUSD: 110_000_000_000 },
          circulatingPrevDay: { peggedUSD: 110_500_000_000 },
          circulatingPrevWeek: { peggedUSD: 113_000_000_000 },   // -3B 7d → contracting
          circulatingPrevMonth: { peggedUSD: 115_000_000_000 },
        },
      ],
    };
    mockHttpsByHost({ "stablecoins.llama.fi": contractingResponse });
    const flows = await getStablecoinFlows();
    const usdt = flows.find((f) => f.symbol === "USDT");
    expect(usdt?.trend).toBe("contracting");
  });

  it("change1dM / change7dB / change30dB 均有值", async () => {
    mockHttpsByHost({ "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE });
    const flows = await getStablecoinFlows();
    const usdt = flows.find((f) => f.symbol === "USDT");
    expect(typeof usdt?.change1dM).toBe("number");
    expect(typeof usdt?.change7dB).toBe("number");
    expect(typeof usdt?.change30dB).toBe("number");
    expect(usdt?.change7dB).toBeGreaterThan(0);
  });
});

// ─── getBtcNetworkMetrics ─────────────────────────────────────────

describe("getBtcNetworkMetrics", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("正常返回 BtcNetworkMetrics", async () => {
    mockHttpsByHost({
      "blockchair.com": MOCK_BLOCKCHAIR_STATS,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const metrics = await getBtcNetworkMetrics();
    expect(metrics).not.toBeNull();
    expect(metrics?.transactions24h).toBe(350_000);
  });

  it("mempool < 5000 → networkActivity=low", async () => {
    const lowMempool = {
      data: { ...MOCK_BLOCKCHAIR_STATS.data, mempool_transactions: 3_000, mempool_size: 10_000_000 },
    };
    mockHttpsByHost({
      "blockchair.com": lowMempool,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const metrics = await getBtcNetworkMetrics();
    expect(metrics?.networkActivity).toBe("low");
    expect(metrics?.networkLabel).toContain("冷清");
  });

  it("mempool > 100000 → networkActivity=high", async () => {
    const highMempool = {
      data: { ...MOCK_BLOCKCHAIR_STATS.data, mempool_transactions: 150_000, mempool_size: 300_000_000 },
    };
    mockHttpsByHost({
      "blockchair.com": highMempool,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const metrics = await getBtcNetworkMetrics();
    expect(metrics?.networkActivity).toBe("high");
  });

  it("5000 <= mempool <= 100000 → networkActivity=normal", async () => {
    mockHttpsByHost({
      "blockchair.com": MOCK_BLOCKCHAIR_STATS,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const metrics = await getBtcNetworkMetrics();
    expect(metrics?.networkActivity).toBe("normal");
  });

  it("blockchair 失败时返回 null", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(https, "request").mockImplementation((_opts: any, _cb: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = new EventEmitter();
      req.end = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();
      callCount++;
      setImmediate(() => { req.emit("error", new Error("connection refused")); });
      return req as unknown as ReturnType<typeof https.request>;
    });
    // 触发一次以确认 callCount 增加
    void callCount;
    const metrics = await getBtcNetworkMetrics();
    expect(metrics).toBeNull();
  });
});

// ─── getOnChainContext ────────────────────────────────────────────

describe("getOnChainContext", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("正常返回 OnChainContext", async () => {
    mockHttpsByHost({
      "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE,
      "blockchair.com": MOCK_BLOCKCHAIR_STATS,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const ctx = await getOnChainContext();
    expect(ctx.stablecoins).toHaveLength(2);
    expect(ctx.btcNetwork).not.toBeNull();
    expect(typeof ctx.totalStablecoin7dChangeB).toBe("number");
  });

  it("稳定币 7d 合计 > 2B → stablecoinSignal=accumulation", async () => {
    // USDT +4B + USDC +2B = +6B → accumulation
    mockHttpsByHost({
      "stablecoins.llama.fi": MOCK_LLAMA_RESPONSE,
      "blockchair.com": MOCK_BLOCKCHAIR_STATS,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const ctx = await getOnChainContext();
    expect(ctx.stablecoinSignal).toBe("accumulation");
  });

  it("稳定币 7d 合计 < -2B → stablecoinSignal=distribution", async () => {
    const contractingBig = {
      peggedAssets: [
        {
          symbol: "USDT",
          name: "Tether",
          circulating: { peggedUSD: 110_000_000_000 },
          circulatingPrevDay: { peggedUSD: 110_500_000_000 },
          circulatingPrevWeek: { peggedUSD: 115_000_000_000 },   // -5B
          circulatingPrevMonth: { peggedUSD: 118_000_000_000 },
        },
        {
          symbol: "USDC",
          name: "USD Coin",
          circulating: { peggedUSD: 42_000_000_000 },
          circulatingPrevDay: { peggedUSD: 42_200_000_000 },
          circulatingPrevWeek: { peggedUSD: 44_000_000_000 },    // -2B
          circulatingPrevMonth: { peggedUSD: 46_000_000_000 },
        },
      ],
    };
    mockHttpsByHost({
      "stablecoins.llama.fi": contractingBig,
      "blockchair.com": MOCK_BLOCKCHAIR_STATS,
      "blockchain.info": MOCK_BLOCKCHAIN_INFO,
    });
    const ctx = await getOnChainContext();
    expect(ctx.stablecoinSignal).toBe("distribution");
  });

  it("网络全失败时返回空稳定币列表 + null btcNetwork", async () => {
    mockNetworkError();
    const ctx = await getOnChainContext();
    expect(ctx.stablecoins).toHaveLength(0);
    expect(ctx.btcNetwork).toBeNull();
  });

  it("fetchedAt 是当前时间戳", async () => {
    mockNetworkError();
    const before = Date.now();
    const ctx = await getOnChainContext();
    expect(ctx.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});

// ─── formatOnChainReport ─────────────────────────────────────────

describe("formatOnChainReport", () => {
  function makeCtx(overrides: Partial<OnChainContext> = {}): OnChainContext {
    return {
      stablecoins: [
        {
          symbol: "USDT",
          name: "Tether",
          circulatingB: 120,
          change1dM: 100,
          change7dB: 4,
          change30dB: 10,
          trend: "expanding",
          trendLabel: "📈 7d: +4.00B | 1d: +100M",
        },
        {
          symbol: "USDC",
          name: "USD Coin",
          circulatingB: 45,
          change1dM: 50,
          change7dB: 2,
          change30dB: 5,
          trend: "expanding",
          trendLabel: "📈 7d: +2.00B | 1d: +50M",
        },
      ],
      totalStablecoin1dChangeM: 150,
      totalStablecoin7dChangeB: 6,
      totalStablecoin30dChangeB: 15,
      stablecoinSignal: "accumulation",
      btcNetwork: {
        transactions24h: 350_000,
        volumeB: 25,
        mempoolTxs: 50_000,
        mempoolSizeMB: 150,
        difficulty: 110_000_000_000_000,
        networkActivity: "normal",
        networkLabel: "✅ 网络正常（mempool 50,000 笔）",
      },
      summary: "稳定币 7 日增发 +6.0B，新资金持续流入",
      fetchedAt: Date.now(),
      ...overrides,
    };
  }

  it("包含 USDT 和 USDC 信息", () => {
    const report = formatOnChainReport(makeCtx());
    expect(report).toContain("USDT");
    expect(report).toContain("USDC");
  });

  it("accumulation 信号显示绿色 🟢", () => {
    const report = formatOnChainReport(makeCtx({ stablecoinSignal: "accumulation" }));
    expect(report).toContain("🟢");
  });

  it("distribution 信号显示红色 🔴", () => {
    const report = formatOnChainReport(makeCtx({ stablecoinSignal: "distribution" }));
    expect(report).toContain("🔴");
  });

  it("包含 BTC 网络活跃度信息", () => {
    const report = formatOnChainReport(makeCtx());
    expect(report).toContain("BTC 网络活跃度");
    expect(report).toContain("350,000");
  });

  it("btcNetwork 为 null 时不报错", () => {
    const ctx = makeCtx({ btcNetwork: null });
    expect(() => formatOnChainReport(ctx)).not.toThrow();
    const report = formatOnChainReport(ctx);
    expect(report).toContain("USDT");
  });

  it("稳定币流通量以 $B 显示", () => {
    const report = formatOnChainReport(makeCtx());
    expect(report).toContain("120.0B");
    expect(report).toContain("45.0B");
  });

  it("7d/30d 合计变化量包含在报告中", () => {
    const report = formatOnChainReport(makeCtx());
    // 7d +6.00B
    expect(report).toContain("+6.00B");
  });
});

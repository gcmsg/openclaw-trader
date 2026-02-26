/**
 * 资金费率信号测试
 *
 * 覆盖：checkFundingRateSignal / readFundingRateCache / writeFundingRateCache / fetchFundingRatePct
 * 文件 I/O 通过 vi.spyOn(fs, ...) mock，网络调用通过 vi.mock('../exchange/futures-data.js') mock
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";

// Mock futures-data 模块，避免真实网络请求
vi.mock("../exchange/futures-data.js", () => ({
  getFundingRate: vi.fn(),
}));

import {
  checkFundingRateSignal,
  readFundingRateCache,
  writeFundingRateCache,
  fetchFundingRatePct,
} from "../strategy/funding-rate-signal.js";
import type { FundingRateCache } from "../strategy/funding-rate-signal.js";
import { getFundingRate } from "../exchange/futures-data.js";

const mockedGetFundingRate = vi.mocked(getFundingRate);

// ─── checkFundingRateSignal ───────────────────────────────────────

describe("checkFundingRateSignal", () => {
  it("ratePct > longThreshold → overlong", () => {
    expect(checkFundingRateSignal(0.35)).toBe("overlong");
    expect(checkFundingRateSignal(0.50)).toBe("overlong");
    expect(checkFundingRateSignal(1.00)).toBe("overlong");
  });

  it("ratePct < -shortThreshold → overshort", () => {
    expect(checkFundingRateSignal(-0.20)).toBe("overshort");
    expect(checkFundingRateSignal(-0.50)).toBe("overshort");
  });

  it("ratePct 在阈值之间 → neutral", () => {
    expect(checkFundingRateSignal(0.0)).toBe("neutral");
    expect(checkFundingRateSignal(0.10)).toBe("neutral");
    expect(checkFundingRateSignal(-0.10)).toBe("neutral");
    expect(checkFundingRateSignal(0.29)).toBe("neutral");
  });

  it("正好等于 longThreshold → neutral（不超过）", () => {
    expect(checkFundingRateSignal(0.30)).toBe("neutral");
  });

  it("正好等于 -shortThreshold → neutral", () => {
    expect(checkFundingRateSignal(-0.15)).toBe("neutral");
  });

  it("自定义阈值生效", () => {
    // 低阈值：longThreshold=0.1, shortThreshold=0.05
    expect(checkFundingRateSignal(0.15, 0.1, 0.05)).toBe("overlong");
    expect(checkFundingRateSignal(-0.10, 0.1, 0.05)).toBe("overshort");
    expect(checkFundingRateSignal(0.05, 0.1, 0.05)).toBe("neutral");
  });
});

// ─── readFundingRateCache ─────────────────────────────────────────

describe("readFundingRateCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("文件不存在时返回 undefined", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("symbol 不在缓存中时返回 undefined", () => {
    const cache: FundingRateCache = {};
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("缓存在有效期内返回 ratePct", () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = readFundingRateCache("BTCUSDT");
    expect(result).toBeCloseTo(0.05);
  });

  it("缓存超过 maxAgeMs 时返回 undefined", () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 15 * 60_000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    // 默认 maxAgeMs = 10min，缓存 15min 前写入，已过期
    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("symbol 不区分大小写（统一转大写）", () => {
    const cache: FundingRateCache = {
      ETHUSDT: { ratePct: 0.03, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    expect(readFundingRateCache("ethusdt")).toBeCloseTo(0.03);
  });

  it("JSON 损坏时返回 undefined（不抛出）", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("bad json!!!");

    expect(() => readFundingRateCache("BTCUSDT")).not.toThrow();
    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });
});

// ─── writeFundingRateCache ────────────────────────────────────────

describe("writeFundingRateCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("写入新 symbol 到空文件", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("BTCUSDT", 0.05);

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["BTCUSDT"]?.ratePct).toBeCloseTo(0.05);
  });

  it("写入时 symbol 自动转大写", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("btcusdt", 0.05);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["BTCUSDT"]).toBeDefined();
  });

  it("现有缓存中添加新 symbol 不丢失旧数据", () => {
    const existing: FundingRateCache = {
      ETHUSDT: { ratePct: 0.03, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(existing));
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("BTCUSDT", 0.10);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["ETHUSDT"]?.ratePct).toBeCloseTo(0.03);
    expect(parsed["BTCUSDT"]?.ratePct).toBeCloseTo(0.10);
  });

  it("覆盖同 symbol 的旧值", () => {
    const existing: FundingRateCache = {
      BTCUSDT: { ratePct: 0.01, fetchedAt: Date.now() - 5000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(existing));
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("BTCUSDT", 0.25);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["BTCUSDT"]?.ratePct).toBeCloseTo(0.25);
  });
});

// ─── fetchFundingRatePct ──────────────────────────────────────────

describe("fetchFundingRatePct", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedGetFundingRate.mockReset();
  });

  it("缓存命中时直接返回缓存值，不调用 getFundingRate", async () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.08, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeCloseTo(0.08);
    expect(mockedGetFundingRate).not.toHaveBeenCalled();
  });

  it("缓存未命中时调用 getFundingRate 并写入缓存", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    mockedGetFundingRate.mockResolvedValue({
      symbol: "BTCUSDT",
      fundingRate: 0.0003,   // 0.0003 → 0.03%
      fundingRateStr: "+0.0300%",
      nextFundingTime: Date.now() + 3600000,
      sentiment: "neutral_long",
      sentimentLabel: "中性偏多（正常）",
    });

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeCloseTo(0.03);
    expect(writeSpy).toHaveBeenCalled();
  });

  it("getFundingRate 抛出异常时返回 undefined（不传播异常）", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockedGetFundingRate.mockRejectedValue(new Error("network error"));

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeUndefined();
  });

  it("symbol 大小写均能命中缓存", async () => {
    const cache: FundingRateCache = {
      ETHUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = await fetchFundingRatePct("ethusdt");
    expect(result).toBeCloseTo(0.05);
  });
});

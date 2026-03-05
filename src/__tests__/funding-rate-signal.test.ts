/**
 * Funding rate signal tests
 *
 * Covers: checkFundingRateSignal / readFundingRateCache / writeFundingRateCache / fetchFundingRatePct
 * File I/O mocked via vi.spyOn(fs, ...), network calls mocked via vi.mock('../exchange/futures-data.js')
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";

// Mock futures-data module to avoid real network requests
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

  it("ratePct between thresholds → neutral", () => {
    expect(checkFundingRateSignal(0.0)).toBe("neutral");
    expect(checkFundingRateSignal(0.10)).toBe("neutral");
    expect(checkFundingRateSignal(-0.10)).toBe("neutral");
    expect(checkFundingRateSignal(0.29)).toBe("neutral");
  });

  it("exactly at longThreshold → neutral (not exceeding)", () => {
    expect(checkFundingRateSignal(0.30)).toBe("neutral");
  });

  it("exactly at -shortThreshold → neutral", () => {
    expect(checkFundingRateSignal(-0.15)).toBe("neutral");
  });

  it("custom thresholds work", () => {
    // Low thresholds: longThreshold=0.1, shortThreshold=0.05
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

  it("returns undefined when file does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("returns undefined when symbol is not in cache", () => {
    const cache: FundingRateCache = {};
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("returns ratePct when cache is within validity period", () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = readFundingRateCache("BTCUSDT");
    expect(result).toBeCloseTo(0.05);
  });

  it("returns undefined when cache exceeds maxAgeMs", () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 15 * 60_000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    // Default maxAgeMs = 10min, cache written 15min ago, already expired
    expect(readFundingRateCache("BTCUSDT")).toBeUndefined();
  });

  it("symbol is case-insensitive (normalized to uppercase)", () => {
    const cache: FundingRateCache = {
      ETHUSDT: { ratePct: 0.03, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    expect(readFundingRateCache("ethusdt")).toBeCloseTo(0.03);
  });

  it("returns undefined on corrupted JSON (does not throw)", () => {
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

  it("writes new symbol to empty file", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("BTCUSDT", 0.05);

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["BTCUSDT"]?.ratePct).toBeCloseTo(0.05);
  });

  it("symbol auto-converted to uppercase on write", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    writeFundingRateCache("btcusdt", 0.05);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as FundingRateCache;
    expect(parsed["BTCUSDT"]).toBeDefined();
  });

  it("adding new symbol to existing cache does not lose old data", () => {
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

  it("overwrites old value for same symbol", () => {
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

  it("returns cached value directly on cache hit without calling getFundingRate", async () => {
    const cache: FundingRateCache = {
      BTCUSDT: { ratePct: 0.08, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeCloseTo(0.08);
    expect(mockedGetFundingRate).not.toHaveBeenCalled();
  });

  it("calls getFundingRate on cache miss and writes to cache", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    mockedGetFundingRate.mockResolvedValue({
      symbol: "BTCUSDT",
      fundingRate: 0.0003,   // 0.0003 → 0.03%
      fundingRateStr: "+0.0300%",
      nextFundingTime: Date.now() + 3600000,
      sentiment: "neutral_long",
      sentimentLabel: "Neutral leaning long (normal)",
    });

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeCloseTo(0.03);
    expect(writeSpy).toHaveBeenCalled();
  });

  it("returns undefined when getFundingRate throws (does not propagate exception)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockedGetFundingRate.mockRejectedValue(new Error("network error"));

    const result = await fetchFundingRatePct("BTCUSDT");
    expect(result).toBeUndefined();
  });

  it("cache hit is case-insensitive for symbol", async () => {
    const cache: FundingRateCache = {
      ETHUSDT: { ratePct: 0.05, fetchedAt: Date.now() - 1000 },
    };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(cache));

    const result = await fetchFundingRatePct("ethusdt");
    expect(result).toBeCloseTo(0.05);
  });
});

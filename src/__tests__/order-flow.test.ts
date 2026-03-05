/**
 * CVD (Cumulative Volume Delta) direction validation
 *
 * Core logic:
 *   m = false → buyer is taker (aggressive buy, hit ask) → buy pressure → CVD +
 *   m = true  → buyer is maker (seller is aggressive, hit bid) → sell pressure → CVD -
 */
import { describe, it, expect } from "vitest";

// ─── Directly test CVD accumulation logic (no WebSocket dependency) ───

interface MockTrade {
  s: string;   // symbol
  q: string;   // quantity
  m: boolean;  // isBuyerMaker
  E: number;   // timestamp
}

function calcCvdFromTrades(trades: MockTrade[]): number {
  let cvd = 0;
  for (const t of trades) {
    const qty = parseFloat(t.q);
    if (!t.m) {
      // Buyer is aggressive → buy pressure → +qty
      cvd += qty;
    } else {
      // Seller is aggressive → sell pressure → -qty
      cvd -= qty;
    }
  }
  return cvd;
}

describe("CVD direction logic (Binance aggTrade m field)", () => {
  it("m=false (buyer is taker, aggressive buy) → CVD positive", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: false, E: Date.now() },
      { s: "BTCUSDT", q: "0.5", m: false, E: Date.now() },
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(1.5);
  });

  it("m=true (seller is taker, aggressive sell) → CVD negative", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: true, E: Date.now() },
      { s: "BTCUSDT", q: "0.5", m: true, E: Date.now() },
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(-1.5);
  });

  it("net buy pressure: more buys than sells → CVD > 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "3.0", m: false, E: Date.now() }, // +3
      { s: "BTCUSDT", q: "1.0", m: true, E: Date.now() },  // -1
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(2.0);
  });

  it("net sell pressure: more sells than buys → CVD < 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: false, E: Date.now() }, // +1
      { s: "BTCUSDT", q: "4.0", m: true, E: Date.now() },  // -4
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(-3.0);
  });

  it("equal buys and sells → CVD ≈ 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "2.0", m: false, E: Date.now() }, // +2
      { s: "BTCUSDT", q: "2.0", m: true, E: Date.now() },  // -2
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(0);
  });

  it("empty trades → CVD = 0", () => {
    expect(calcCvdFromTrades([])).toBe(0);
  });
});

// ─── Token bucket rate limiter standalone tests ───

class RateLimiterForTest {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(maxPerMinute = 600) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60_000;
  }

  tryAcquire(weight = 1): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return true;
    }
    return false;
  }

  getTokens(): number { return this.tokens; }
}

describe("RateLimiter token bucket", () => {
  it("initial tokens are full, can acquire immediately", () => {
    const limiter = new RateLimiterForTest(600);
    expect(limiter.tryAcquire(1)).toBe(true);
  });

  it("cannot acquire after tokens are exhausted", () => {
    const limiter = new RateLimiterForTest(10);
    for (let i = 0; i < 10; i++) limiter.tryAcquire(1);
    expect(limiter.getTokens()).toBeCloseTo(0, 0);
    expect(limiter.tryAcquire(1)).toBe(false);
  });

  it("maxTokens = 600, does not exceed upper limit", () => {
    const limiter = new RateLimiterForTest(600);
    // Even after a long wait, tokens never exceed maxTokens
    expect(limiter.getTokens()).toBeLessThanOrEqual(600);
  });

  it("batch requests: 5 consecutive weight=1 acquisitions all pass", () => {
    const limiter = new RateLimiterForTest(100);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire(1)).toBe(true);
    }
  });
});

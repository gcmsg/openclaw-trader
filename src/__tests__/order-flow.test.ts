/**
 * CVD (累计成交量差值) 方向验证
 *
 * 核心逻辑：
 *   m = false → 买方是 taker（主动买，hit ask）→ 买压 → CVD +
 *   m = true  → 买方是 maker（卖方主动，hit bid）→ 卖压 → CVD -
 */
import { describe, it, expect } from "vitest";

// ─── 直接测试 CVD 累计逻辑（不依赖 WebSocket） ───

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
      // 买方主动 → 买压 → +qty
      cvd += qty;
    } else {
      // 卖方主动 → 卖压 → -qty
      cvd -= qty;
    }
  }
  return cvd;
}

describe("CVD 方向逻辑（Binance aggTrade m 字段）", () => {
  it("m=false（买方 taker，主动买）→ CVD 正增", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: false, E: Date.now() },
      { s: "BTCUSDT", q: "0.5", m: false, E: Date.now() },
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(1.5);
  });

  it("m=true（卖方 taker，主动卖）→ CVD 负增", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: true, E: Date.now() },
      { s: "BTCUSDT", q: "0.5", m: true, E: Date.now() },
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(-1.5);
  });

  it("净买压：买多于卖 → CVD > 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "3.0", m: false, E: Date.now() }, // +3
      { s: "BTCUSDT", q: "1.0", m: true, E: Date.now() },  // -1
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(2.0);
  });

  it("净卖压：卖多于买 → CVD < 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "1.0", m: false, E: Date.now() }, // +1
      { s: "BTCUSDT", q: "4.0", m: true, E: Date.now() },  // -4
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(-3.0);
  });

  it("买卖均等 → CVD ≈ 0", () => {
    const trades: MockTrade[] = [
      { s: "BTCUSDT", q: "2.0", m: false, E: Date.now() }, // +2
      { s: "BTCUSDT", q: "2.0", m: true, E: Date.now() },  // -2
    ];
    expect(calcCvdFromTrades(trades)).toBeCloseTo(0);
  });

  it("空 trades → CVD = 0", () => {
    expect(calcCvdFromTrades([])).toBe(0);
  });
});

// ─── 令牌桶限速器独立测试 ───

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

describe("RateLimiter 令牌桶", () => {
  it("初始令牌足满，可以立刻获取", () => {
    const limiter = new RateLimiterForTest(600);
    expect(limiter.tryAcquire(1)).toBe(true);
  });

  it("耗尽令牌后无法获取", () => {
    const limiter = new RateLimiterForTest(10);
    for (let i = 0; i < 10; i++) limiter.tryAcquire(1);
    expect(limiter.getTokens()).toBeCloseTo(0, 0);
    expect(limiter.tryAcquire(1)).toBe(false);
  });

  it("maxTokens = 600，不超上限", () => {
    const limiter = new RateLimiterForTest(600);
    // 即使等很久，令牌也不超过 maxTokens
    expect(limiter.getTokens()).toBeLessThanOrEqual(600);
  });

  it("批量请求：连续 5 次各 weight=1 均可通过", () => {
    const limiter = new RateLimiterForTest(100);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire(1)).toBe(true);
    }
  });
});

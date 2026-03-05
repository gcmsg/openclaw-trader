/**
 * Kelly criterion dynamic position sizing tests
 */
import { describe, it, expect } from "vitest";
import { calcKellyRatio } from "../strategy/kelly.js";

function makeTrades(pcts: number[]) {
  return pcts.map((pnlPercent) => ({ pnlPercent }));
}

describe("calcKellyRatio()", () => {
  it("returns fallback when sample size is insufficient", () => {
    const trades = makeTrades([5, 3, -2]); // only 3 trades, < 10
    const res = calcKellyRatio(trades);
    expect(res.reliable).toBe(false);
    expect(res.ratio).toBe(0.2); // default fallback
    expect(res.reason).toContain("Insufficient samples");
  });

  it("ratio returns 0 for negative expectancy", () => {
    // Win rate 30%, R=0.5 (avg loss > avg win) → negative Kelly
    const trades = makeTrades([
      ...Array(3).fill(2),   // 3 wins at +2%
      ...Array(7).fill(-10), // 7 losses at -10%
    ]);
    const res = calcKellyRatio(trades);
    expect(res.reliable).toBe(true);
    expect(res.ratio).toBe(0);
    expect(res.rawKelly).toBeLessThan(0);
    expect(res.reason).toContain("Negative expectancy");
  });

  it("100% win rate Kelly = half W (R = avgWin when no losses)", () => {
    const trades = makeTrades(Array(10).fill(10)); // all +10%
    const res = calcKellyRatio(trades, { half: true, minRatio: 0 });
    // R = avgWin / 0 → R = avgWin = 10; Kelly = W - (1-W)/R = 1 - 0/10 = 1
    // Half Kelly = 0.5; capped at maxRatio=0.40
    expect(res.winRate).toBe(1);
    expect(res.reliable).toBe(true);
    expect(res.ratio).toBe(0.4); // capped at maxRatio
  });

  it("typical strategy: W=0.55, R=1.5 → reasonable position size", () => {
    // 55% win rate, R=1.5
    const wins = Array(55).fill(15); // 15% profit
    const losses = Array(45).fill(-10); // -10% loss
    const trades = makeTrades([...wins, ...losses]);
    const res = calcKellyRatio(trades, { lookback: 100, half: true });
    // Kelly = 0.55 - 0.45/1.5 = 0.55 - 0.30 = 0.25, half Kelly = 0.125
    expect(res.winRate).toBeCloseTo(0.55, 1);
    expect(res.rrRatio).toBeCloseTo(1.5, 1);
    expect(res.rawKelly).toBeCloseTo(0.125, 2);
    expect(res.ratio).toBeCloseTo(0.125, 2);
    expect(res.reliable).toBe(true);
  });

  it("Kelly result is capped by maxRatio upper bound", () => {
    const trades = makeTrades(Array(20).fill(50)); // extremely high win rate + large gains
    const res = calcKellyRatio(trades, { maxRatio: 0.3, half: false });
    expect(res.ratio).toBe(0.3); // does not exceed upper bound
  });

  it("Kelly result is floored by minRatio lower bound", () => {
    // Win rate 52%, R close to 1 → very small Kelly
    const wins = Array(52).fill(5);
    const losses = Array(48).fill(-5);
    const trades = makeTrades([...wins, ...losses]);
    const res = calcKellyRatio(trades, { lookback: 100, half: true, minRatio: 0.08 });
    expect(res.ratio).toBeGreaterThanOrEqual(0.08);
  });

  it("only uses the most recent lookback trades", () => {
    // First 10 all losses, last 10 all wins
    const old = Array(10).fill(-20);
    const recent = Array(10).fill(20);
    const trades = makeTrades([...old, ...recent]);
    const res = calcKellyRatio(trades, { lookback: 10 });
    // Only looks at the most recent 10 trades (all wins), win rate should be 1
    expect(res.winRate).toBe(1);
  });

  it("customMinSamples config takes effect", () => {
    const trades = makeTrades([5, 3, 8]); // 3 trades
    const res = calcKellyRatio(trades, { minSamples: 3 }); // 3 >= 3 → reliable
    expect(res.reliable).toBe(true);
  });

  it("ratio is within [minRatio, maxRatio]", () => {
    for (let i = 0; i < 10; i++) {
      const wins = Array(Math.floor(Math.random() * 8) + 2).fill(Math.random() * 20 + 1);
      const losses = Array(Math.floor(Math.random() * 8) + 2).fill(-(Math.random() * 10 + 1));
      const trades = makeTrades([...wins, ...losses]);
      const res = calcKellyRatio(trades, { minRatio: 0.05, maxRatio: 0.4 });
      if (res.ratio > 0) {
        expect(res.ratio).toBeGreaterThanOrEqual(0.05);
        expect(res.ratio).toBeLessThanOrEqual(0.4);
      }
    }
  });
});

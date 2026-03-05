import { describe, it, expect } from "vitest";
import { runMonteCarlo, formatMonteCarloReport, formatWalkForwardReport } from "../backtest/walk-forward.js";
import type { WalkForwardResult } from "../backtest/walk-forward.js";

describe("runMonteCarlo", () => {
  it("returns safe defaults when no trade data", () => {
    const result = runMonteCarlo([]);
    expect(result.iterations).toBe(0);
    expect(result.avgReturn).toBe(0);
    expect(result.verdict).toContain("No trade data");
  });

  it("avgReturn should be positive when all trades are profitable", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: 2 }));
    const result = runMonteCarlo(trades, 200);
    expect(result.avgReturn).toBeGreaterThan(0);
    expect(result.p5Return).toBeGreaterThan(0);
    expect(result.medianReturn).toBeGreaterThan(0);
  });

  it("avgReturn should be negative when all trades are losses", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: -2 }));
    const result = runMonteCarlo(trades, 200);
    expect(result.avgReturn).toBeLessThan(0);
    expect(result.verdict).toMatch(/[Rr]isk/);
  });

  it("p5Return should be less than p95Return for mixed returns", () => {
    const trades = Array.from({ length: 50 }, (_, i) => ({
      returnPct: i % 3 === 0 ? -3 : 1.5,
    }));
    const result = runMonteCarlo(trades, 500);
    expect(result.p5Return).toBeLessThan(result.p95Return);
    expect(result.p5MaxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it("iterations parameter takes effect", () => {
    const trades = [{ returnPct: 1 }, { returnPct: -1 }, { returnPct: 2 }];
    const result = runMonteCarlo(trades, 100);
    expect(result.iterations).toBe(100);
  });
});

describe("formatMonteCarloReport", () => {
  it("output contains key fields", () => {
    const result = runMonteCarlo(
      Array.from({ length: 10 }, () => ({ returnPct: 1 })),
      100
    );
    const report = formatMonteCarloReport(result);
    expect(report).toContain("Monte Carlo");
    expect(report).toContain("%");
  });
});

describe("formatWalkForwardReport", () => {
  it("empty results produce normal output", () => {
    const report = formatWalkForwardReport([]);
    expect(report).toContain("Walk-Forward");
  });

  it("contains fold information", () => {
    const mockResult: WalkForwardResult = {
      symbol: "BTCUSDT",
      totalFolds: 2,
      folds: [
        {
          foldIndex: 0,
          trainBars: 500,
          testBars: 100,
          inSampleReturn: 5,
          outOfSampleReturn: 2,
          outOfSampleSharpe: 0.8,
          outOfSampleTrades: 10,
          outOfSampleWinRate: 0.6,
        },
        {
          foldIndex: 1,
          trainBars: 600,
          testBars: 100,
          inSampleReturn: 4,
          outOfSampleReturn: -1,
          outOfSampleSharpe: -0.2,
          outOfSampleTrades: 8,
          outOfSampleWinRate: 0.4,
        },
      ],
      avgOutOfSampleReturn: 0.5,
      avgInSampleReturn: 4.5,
      consistency: 0.5,
      robust: false,
      verdict: "⚠️ Moderate",
    };

    const report = formatWalkForwardReport([mockResult]);
    expect(report).toContain("BTC");
    expect(report).toContain("Fold 1");
    expect(report).toContain("Fold 2");
    expect(report).toContain("OOS");
  });
});

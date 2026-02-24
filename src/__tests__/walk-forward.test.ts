import { describe, it, expect } from "vitest";
import { runMonteCarlo, formatMonteCarloReport, formatWalkForwardReport } from "../backtest/walk-forward.js";
import type { WalkForwardResult } from "../backtest/walk-forward.js";

describe("runMonteCarlo", () => {
  it("无交易数据时返回安全默认值", () => {
    const result = runMonteCarlo([]);
    expect(result.iterations).toBe(0);
    expect(result.avgReturn).toBe(0);
    expect(result.verdict).toContain("无交易数据");
  });

  it("全部盈利时 avgReturn 应为正", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: 2 }));
    const result = runMonteCarlo(trades, 200);
    expect(result.avgReturn).toBeGreaterThan(0);
    expect(result.p5Return).toBeGreaterThan(0);
    expect(result.medianReturn).toBeGreaterThan(0);
  });

  it("全部亏损时 avgReturn 应为负", () => {
    const trades = Array.from({ length: 20 }, () => ({ returnPct: -2 }));
    const result = runMonteCarlo(trades, 200);
    expect(result.avgReturn).toBeLessThan(0);
    expect(result.verdict).toMatch(/风险/);
  });

  it("混合收益的 p5Return 应小于 p95Return", () => {
    const trades = Array.from({ length: 50 }, (_, i) => ({
      returnPct: i % 3 === 0 ? -3 : 1.5,
    }));
    const result = runMonteCarlo(trades, 500);
    expect(result.p5Return).toBeLessThan(result.p95Return);
    expect(result.p5MaxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it("iterations 参数生效", () => {
    const trades = [{ returnPct: 1 }, { returnPct: -1 }, { returnPct: 2 }];
    const result = runMonteCarlo(trades, 100);
    expect(result.iterations).toBe(100);
  });
});

describe("formatMonteCarloReport", () => {
  it("输出包含关键字段", () => {
    const result = runMonteCarlo(
      Array.from({ length: 10 }, () => ({ returnPct: 1 })),
      100
    );
    const report = formatMonteCarloReport(result);
    expect(report).toContain("蒙特卡洛");
    expect(report).toContain("%");
  });
});

describe("formatWalkForwardReport", () => {
  it("空结果正常输出", () => {
    const report = formatWalkForwardReport([]);
    expect(report).toContain("Walk-Forward");
  });

  it("包含折次信息", () => {
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
      verdict: "⚠️ 一般",
    };

    const report = formatWalkForwardReport([mockResult]);
    expect(report).toContain("BTC");
    expect(report).toContain("Fold 1");
    expect(report).toContain("Fold 2");
    expect(report).toContain("OOS");
  });
});

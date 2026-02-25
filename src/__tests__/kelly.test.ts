/**
 * Kelly 公式动态仓位测试
 */
import { describe, it, expect } from "vitest";
import { calcKellyRatio } from "../strategy/kelly.js";

function makeTrades(pcts: number[]) {
  return pcts.map((pnlPercent) => ({ pnlPercent }));
}

describe("calcKellyRatio()", () => {
  it("样本不足时返回 fallback", () => {
    const trades = makeTrades([5, 3, -2]); // 仅 3 笔，< 10
    const res = calcKellyRatio(trades);
    expect(res.reliable).toBe(false);
    expect(res.ratio).toBe(0.2); // 默认 fallback
    expect(res.reason).toContain("样本不足");
  });

  it("负期望值时 ratio 返回 0", () => {
    // 胜率 30%，R=0.5（平均亏损 > 平均盈利）→ 负 Kelly
    const trades = makeTrades([
      ...Array(3).fill(2),   // 3 次盈利 +2%
      ...Array(7).fill(-10), // 7 次亏损 -10%
    ]);
    const res = calcKellyRatio(trades);
    expect(res.reliable).toBe(true);
    expect(res.ratio).toBe(0);
    expect(res.rawKelly).toBeLessThan(0);
    expect(res.reason).toContain("负期望值");
  });

  it("100% 胜率 Kelly = 半 W（无亏损时 R = avgWin）", () => {
    const trades = makeTrades(Array(10).fill(10)); // 全部 +10%
    const res = calcKellyRatio(trades, { half: true, minRatio: 0 });
    // R = avgWin / 0 → R = avgWin = 10；Kelly = W - (1-W)/R = 1 - 0/10 = 1
    // 半 Kelly = 0.5；约束到 maxRatio=0.40
    expect(res.winRate).toBe(1);
    expect(res.reliable).toBe(true);
    expect(res.ratio).toBe(0.4); // capped at maxRatio
  });

  it("典型策略：W=0.55, R=1.5 → 合理仓位", () => {
    // 55% 胜率，R=1.5
    const wins = Array(55).fill(15); // 15% 盈利
    const losses = Array(45).fill(-10); // -10% 亏损
    const trades = makeTrades([...wins, ...losses]);
    const res = calcKellyRatio(trades, { lookback: 100, half: true });
    // Kelly = 0.55 - 0.45/1.5 = 0.55 - 0.30 = 0.25，半 Kelly = 0.125
    expect(res.winRate).toBeCloseTo(0.55, 1);
    expect(res.rrRatio).toBeCloseTo(1.5, 1);
    expect(res.rawKelly).toBeCloseTo(0.125, 2);
    expect(res.ratio).toBeCloseTo(0.125, 2);
    expect(res.reliable).toBe(true);
  });

  it("Kelly 结果受 maxRatio 上限约束", () => {
    const trades = makeTrades(Array(20).fill(50)); // 极高胜率+大盈利
    const res = calcKellyRatio(trades, { maxRatio: 0.3, half: false });
    expect(res.ratio).toBe(0.3); // 不超过上限
  });

  it("Kelly 结果受 minRatio 下限约束", () => {
    // 胜率 52%，R 接近 1 → Kelly 很小
    const wins = Array(52).fill(5);
    const losses = Array(48).fill(-5);
    const trades = makeTrades([...wins, ...losses]);
    const res = calcKellyRatio(trades, { lookback: 100, half: true, minRatio: 0.08 });
    expect(res.ratio).toBeGreaterThanOrEqual(0.08);
  });

  it("只取最近 lookback 笔", () => {
    // 前 10 笔全亏，后 10 笔全赢
    const old = Array(10).fill(-20);
    const recent = Array(10).fill(20);
    const trades = makeTrades([...old, ...recent]);
    const res = calcKellyRatio(trades, { lookback: 10 });
    // 只看最近 10 笔（全赢），胜率应为 1
    expect(res.winRate).toBe(1);
  });

  it("customMinSamples 配置生效", () => {
    const trades = makeTrades([5, 3, 8]); // 3 笔
    const res = calcKellyRatio(trades, { minSamples: 3 }); // 3 >= 3 → reliable
    expect(res.reliable).toBe(true);
  });

  it("ratio 在 [minRatio, maxRatio] 内", () => {
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

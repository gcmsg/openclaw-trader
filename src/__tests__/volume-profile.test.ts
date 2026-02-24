import { describe, it, expect } from "vitest";
import { calcVolumeProfile, calcPivotPoints, calcSupportResistance } from "../strategy/volume-profile.js";
import type { Kline } from "../types.js";

function makeKlines(
  prices: { h: number; l: number; c: number; v?: number }[]
): Kline[] {
  return prices.map((p, i) => ({
    openTime: i * 3600000,
    open: p.c * 0.999,
    high: p.h,
    low: p.l,
    close: p.c,
    volume: p.v ?? 1000,
    closeTime: (i + 1) * 3600000,
  }));
}

describe("calcVolumeProfile", () => {
  it("返回正确结构", () => {
    const klines = makeKlines([
      { h: 105, l: 95, c: 100, v: 1000 },
      { h: 108, l: 97, c: 103, v: 2000 },
      { h: 106, l: 98, c: 101, v: 500 },
    ]);
    const vp = calcVolumeProfile(klines);
    expect(vp.poc).toBeGreaterThan(0);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
    expect(vp.nodes.length).toBeGreaterThan(0);
  });

  it("POC 在价格区间内", () => {
    const klines = makeKlines([
      { h: 110, l: 90, c: 100, v: 1000 },
      { h: 115, l: 95, c: 105, v: 3000 }, // 高成交量
      { h: 108, l: 92, c: 98,  v: 500  },
    ]);
    const vp = calcVolumeProfile(klines, 20);
    const allLows = klines.map((k) => k.low);
    const allHighs = klines.map((k) => k.high);
    expect(vp.poc).toBeGreaterThanOrEqual(Math.min(...allLows));
    expect(vp.poc).toBeLessThanOrEqual(Math.max(...allHighs));
  });

  it("空 K 线返回零值", () => {
    const vp = calcVolumeProfile([]);
    expect(vp.poc).toBe(0);
    expect(vp.nodes.length).toBe(0);
  });

  it("VAH >= POC >= VAL", () => {
    const klines = makeKlines(
      Array.from({ length: 20 }, (_, i) => ({
        h: 100 + i,
        l: 90 + i,
        c: 95 + i,
        v: 1000 + i * 100,
      }))
    );
    const vp = calcVolumeProfile(klines);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
  });
});

describe("calcPivotPoints", () => {
  it("基于倒数第二根 K 线计算 PP", () => {
    const klines = makeKlines([
      { h: 120, l: 80, c: 100 },  // 倒数第二根
      { h: 115, l: 95, c: 110 },  // 最新一根（不用于计算）
    ]);
    const pp = calcPivotPoints(klines);
    expect(pp).not.toBeNull();
    // PP = (120 + 80 + 100) / 3 = 100
    expect(pp!.pp).toBeCloseTo(100, 0);
  });

  it("R1 > PP > S1", () => {
    const klines = makeKlines([
      { h: 120, l: 80, c: 100 },
      { h: 115, l: 95, c: 110 },
    ]);
    const pp = calcPivotPoints(klines);
    expect(pp).not.toBeNull();
    expect(pp!.r1).toBeGreaterThan(pp!.pp);
    expect(pp!.s1).toBeLessThan(pp!.pp);
  });

  it("数据不足时返回 null", () => {
    expect(calcPivotPoints([])).toBeNull();
    expect(calcPivotPoints(makeKlines([{ h: 110, l: 90, c: 100 }]))).toBeNull();
  });
});

describe("calcSupportResistance", () => {
  it("支撑在当前价以下，阻力在当前价以上", () => {
    const klines = makeKlines(
      Array.from({ length: 30 }, (_, i) => ({
        h: 100 + i * 0.5,
        l: 90 + i * 0.5,
        c: 95 + i * 0.5,
        v: 1000,
      }))
    );
    const price = klines[klines.length - 1]!.close;
    const sr = calcSupportResistance("BTCUSDT", klines);

    expect(sr.currentPrice).toBeCloseTo(price, 0);
    for (const s of sr.supports) {
      expect(s.price).toBeLessThan(sr.currentPrice);
      expect(s.type).toBe("support");
    }
    for (const r of sr.resistances) {
      expect(r.price).toBeGreaterThan(sr.currentPrice);
      expect(r.type).toBe("resistance");
    }
  });

  it("distanceToSupport 和 distanceToResistance 为正", () => {
    const klines = makeKlines(
      Array.from({ length: 30 }, (_, i) => ({
        h: 105 + i,
        l: 95 + i,
        c: 100 + i,
        v: 1000,
      }))
    );
    const sr = calcSupportResistance("BTCUSDT", klines);
    expect(sr.distanceToSupport).toBeGreaterThanOrEqual(0);
    expect(sr.distanceToResistance).toBeGreaterThanOrEqual(0);
  });
});

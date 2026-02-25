/**
 * 持仓对账测试
 */
import { describe, it, expect } from "vitest";
import { reconcilePositions, formatReconcileReport } from "../live/reconcile.js";
import type { PaperAccount } from "../paper/account.js";
import type { ExchangePosition } from "../live/reconcile.js";

// ─── 辅助 ─────────────────────────────────────────────

function makeAccount(positions: Record<string, { quantity: number; side: "long" | "short" }>): PaperAccount {
  const pos: PaperAccount["positions"] = {};
  for (const [sym, { quantity, side }] of Object.entries(positions)) {
    pos[sym] = {
      symbol: sym,
      side,
      quantity,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 90,
      takeProfit: 110,
    };
  }
  return {
    initialUsdt: 10000,
    usdt: 10000,
    positions: pos,
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
  };
}

function makeExPos(symbol: string, qty: number): ExchangePosition {
  return { symbol, side: "long", qty, avgPrice: 100 };
}

// ─── 基本对账 ─────────────────────────────────────────

describe("reconcilePositions()", () => {
  it("无持仓，双方均空 → ok", () => {
    const account = makeAccount({});
    const result = reconcilePositions(account, []);
    expect(result.status).toBe("ok");
    expect(result.discrepancies).toHaveLength(0);
  });

  it("本地有持仓，交易所也有一致持仓 → ok", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 0.1, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.1)];
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("ok");
  });

  it("本地有持仓，交易所没有 → warning（missing_exchange）", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 0.1, side: "long" } });
    const result = reconcilePositions(account, []);
    expect(result.status).toBe("warning");
    expect(result.discrepancies[0]?.issue).toBe("missing_exchange");
  });

  it("交易所有持仓，本地没有 → warning（missing_local）", () => {
    const account = makeAccount({});
    const exPos = [makeExPos("ETHUSDT", 1.5)];
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("warning");
    expect(result.discrepancies[0]?.issue).toBe("missing_local");
  });

  it("数量差异 4%（< 5% 容忍度）→ ok", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.96)]; // 4% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("ok");
  });

  it("数量差异 6%（> 5%）→ warning（qty_mismatch）", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.93)]; // 7% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("warning");
    const d = result.discrepancies.find((x) => x.issue === "qty_mismatch");
    expect(d).toBeDefined();
    expect((d?.diffPct ?? 0)).toBeGreaterThan(5);
  });

  it("数量差异 > 10% → critical", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.85)]; // 15% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("critical");
  });

  it("autoSyncMissing=true 时记录自动同步列表", () => {
    const account = makeAccount({});
    const exPos = [makeExPos("SOLUSDT", 10)];
    const result = reconcilePositions(account, exPos, true);
    expect(result.autoSynced).toContain("SOLUSDT");
  });

  it("多 symbol 对账，多处差异全部返回", () => {
    const account = makeAccount({
      BTCUSDT: { quantity: 1.0, side: "long" }, // missing_exchange
      ETHUSDT: { quantity: 2.0, side: "long" }, // qty_mismatch
    });
    const exPos = [
      makeExPos("ETHUSDT", 1.7),  // 15% diff
      makeExPos("SOLUSDT", 5.0),  // missing_local
    ];
    const result = reconcilePositions(account, exPos);
    expect(result.discrepancies.length).toBeGreaterThanOrEqual(2);
    expect(result.discrepancies.map((d) => d.issue)).toContain("missing_exchange");
    expect(result.discrepancies.map((d) => d.issue)).toContain("missing_local");
  });
});

// ─── 报告格式化 ───────────────────────────────────────

describe("formatReconcileReport()", () => {
  it("ok 状态包含正常提示", () => {
    const account = makeAccount({});
    const result = reconcilePositions(account, []);
    const report = formatReconcileReport(result);
    expect(report).toContain("一致");
  });

  it("critical 状态包含暂停建议", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.8)]; // 20% diff
    const result = reconcilePositions(account, exPos);
    const report = formatReconcileReport(result);
    expect(report).toContain("暂停");
  });
});

/**
 * Position reconciliation tests
 */
import { describe, it, expect } from "vitest";
import { reconcilePositions, formatReconcileReport } from "../live/reconcile.js";
import type { PaperAccount } from "../paper/account.js";
import type { ExchangePosition } from "../live/reconcile.js";

// ─── Helpers ──────────────────────────────────────────

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

// ─── Basic reconciliation ─────────────────────────────

describe("reconcilePositions()", () => {
  it("no positions, both sides empty → ok", () => {
    const account = makeAccount({});
    const result = reconcilePositions(account, []);
    expect(result.status).toBe("ok");
    expect(result.discrepancies).toHaveLength(0);
  });

  it("local has position, exchange has matching position → ok", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 0.1, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.1)];
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("ok");
  });

  it("local has position, exchange does not → warning (missing_exchange)", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 0.1, side: "long" } });
    const result = reconcilePositions(account, []);
    expect(result.status).toBe("warning");
    expect(result.discrepancies[0]?.issue).toBe("missing_exchange");
  });

  it("exchange has position, local does not → warning (missing_local)", () => {
    const account = makeAccount({});
    const exPos = [makeExPos("ETHUSDT", 1.5)];
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("warning");
    expect(result.discrepancies[0]?.issue).toBe("missing_local");
  });

  it("quantity difference 4% (< 5% tolerance) → ok", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.96)]; // 4% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("ok");
  });

  it("quantity difference 6% (> 5%) → warning (qty_mismatch)", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.93)]; // 7% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("warning");
    const d = result.discrepancies.find((x) => x.issue === "qty_mismatch");
    expect(d).toBeDefined();
    expect((d?.diffPct ?? 0)).toBeGreaterThan(5);
  });

  it("quantity difference > 10% → critical", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.85)]; // 15% diff
    const result = reconcilePositions(account, exPos);
    expect(result.status).toBe("critical");
  });

  it("records auto-sync list when autoSyncMissing=true", () => {
    const account = makeAccount({});
    const exPos = [makeExPos("SOLUSDT", 10)];
    const result = reconcilePositions(account, exPos, true);
    expect(result.autoSynced).toContain("SOLUSDT");
  });

  it("multi-symbol reconciliation returns all discrepancies", () => {
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

// ─── Report formatting ────────────────────────────────

describe("formatReconcileReport()", () => {
  it("ok status contains normal prompt", () => {
    const account = makeAccount({});
    const result = reconcilePositions(account, []);
    const report = formatReconcileReport(result);
    expect(report).toContain("matches");
  });

  it("critical status contains pause recommendation", () => {
    const account = makeAccount({ BTCUSDT: { quantity: 1.0, side: "long" } });
    const exPos = [makeExPos("BTCUSDT", 0.8)]; // 20% diff
    const result = reconcilePositions(account, exPos);
    const report = formatReconcileReport(result);
    expect(report).toContain("pausing");
  });
});

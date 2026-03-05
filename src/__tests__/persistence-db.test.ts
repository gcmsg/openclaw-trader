/**
 * SQLite Persistence Tests (G5)
 * Uses ":memory:" database (in-memory, no disk writes)
 */
import { describe, it, expect, afterEach } from "vitest";
import { TradeDB } from "../persistence/db.js";

// Track all DB instances created per test for cleanup
let openInstances: TradeDB[] = [];

afterEach(() => {
  openInstances.forEach((d) => { d.close(); });
  openInstances = [];
});

function openDb(): TradeDB {
  const instance = new TradeDB(":memory:");
  openInstances.push(instance);
  return instance;
}

// Re-declare db as a convenience alias that tests assign to
let db: TradeDB;

// ─────────────────────────────────────────────────────
// migrate + basic CRUD
// ─────────────────────────────────────────────────────

describe("TradeDB — migrate", () => {
  it("migrate() is idempotent (multiple calls do not throw)", () => {
    db = openDb();
    expect(() => { db.migrate(); }).not.toThrow();
    expect(() => { db.migrate(); }).not.toThrow();
  });
});

describe("TradeDB — insertTrade + closeTrade", () => {
  it("insertTrade returns auto-increment ID", () => {
    db = openDb();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("multiple insertTrade calls return incrementing IDs", () => {
    db = openDb();
    const id1 = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    const id2 = db.insertTrade("test", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, Date.now());
    expect(id2).toBeGreaterThan(id1);
  });

  it("closeTrade updates the record with specified ID", () => {
    db = openDb();
    const now = Date.now();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.closeTrade(id, 53000, 300, 0.06, false, true, now + 3600_000);

    // Verify via getRecentClosedTrades
    const records = db.getRecentClosedTrades("test", 0);
    expect(records).toHaveLength(1);
    expect(records[0]?.symbol).toBe("BTCUSDT");
    expect(records[0]?.pnlRatio).toBeCloseTo(0.06);
    expect(records[0]?.wasStopLoss).toBe(false);
  });

  it("closeTrade wasStopLoss=true written correctly", () => {
    db = openDb();
    const now = Date.now();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.closeTrade(id, 47000, -300, -0.06, true, false, now + 1_000);

    const records = db.getRecentClosedTrades("test", 0);
    expect(records[0]?.wasStopLoss).toBe(true);
    expect(records[0]?.pnlRatio).toBeCloseTo(-0.06);
  });
});

// ─────────────────────────────────────────────────────
// getRecentClosedTrades
// ─────────────────────────────────────────────────────

describe("TradeDB — getRecentClosedTrades", () => {
  it("only returns records for the specified scenarioId", () => {
    db = openDb();
    const now = Date.now();
    const id1 = db.insertTrade("scenario-A", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    const id2 = db.insertTrade("scenario-B", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, now);
    db.closeTrade(id1, 53000, 300, 0.06, false, true, now + 1000);
    db.closeTrade(id2, 3200, 200, 0.067, false, true, now + 2000);

    const recordsA = db.getRecentClosedTrades("scenario-A", 0);
    expect(recordsA).toHaveLength(1);
    expect(recordsA[0]?.symbol).toBe("BTCUSDT");

    const recordsB = db.getRecentClosedTrades("scenario-B", 0);
    expect(recordsB).toHaveLength(1);
    expect(recordsB[0]?.symbol).toBe("ETHUSDT");
  });

  it("only returns records with closedAt >= sinceMs", () => {
    db = openDb();
    const base = Date.now();
    const id1 = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, base);
    const id2 = db.insertTrade("test", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, base);
    db.closeTrade(id1, 48000, -200, -0.04, true, false, base - 5000);
    db.closeTrade(id2, 3100, 100, 0.033, false, true, base + 5000);

    const records = db.getRecentClosedTrades("test", base);
    expect(records).toHaveLength(1);
    expect(records[0]?.symbol).toBe("ETHUSDT");
  });

  it("open trades do not appear in getRecentClosedTrades results", () => {
    db = openDb();
    db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    const records = db.getRecentClosedTrades("test", 0);
    expect(records).toHaveLength(0);
  });

  it("results are sorted by closedAt ascending", () => {
    db = openDb();
    const base = Date.now();
    const id1 = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, base);
    const id2 = db.insertTrade("test", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, base);
    db.closeTrade(id2, 3100, 100, 0.033, false, true, base + 2000);
    db.closeTrade(id1, 48000, -200, -0.04, true, false, base + 1000);

    const records = db.getRecentClosedTrades("test", 0);
    expect(records[0]?.symbol).toBe("BTCUSDT"); // Closed first
    expect(records[1]?.symbol).toBe("ETHUSDT");
  });
});

// ─────────────────────────────────────────────────────
// getOpenTrades
// ─────────────────────────────────────────────────────

describe("TradeDB — getOpenTrades", () => {
  it("returns open trades for specified scenario", () => {
    db = openDb();
    const now = Date.now();
    db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.insertTrade("test", "ETHUSDT", "short", 1.0, 3000, 3150, 2700, now);
    const open = db.getOpenTrades("test");
    expect(open).toHaveLength(2);
    expect(open.map((t) => t.symbol)).toContain("BTCUSDT");
    expect(open.map((t) => t.symbol)).toContain("ETHUSDT");
  });

  it("does not appear in getOpenTrades after closing", () => {
    db = openDb();
    const now = Date.now();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.closeTrade(id, 53000, 300, 0.06, false, true, now + 3600_000);
    const open = db.getOpenTrades("test");
    expect(open).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────
// recordSnapshot
// ─────────────────────────────────────────────────────

describe("TradeDB — recordSnapshot", () => {
  it("successfully records account snapshot (no throw)", () => {
    db = openDb();
    expect(() => {
      db.recordSnapshot("test", 10250.5, 8000, 2, Date.now());
    }).not.toThrow();
  });

  it("can record multiple snapshots", () => {
    db = openDb();
    const now = Date.now();
    db.recordSnapshot("test", 10000, 8000, 2, now);
    db.recordSnapshot("test", 10100, 8100, 2, now + 3600_000);
    // Only verify no throw (snapshots have no read interface, testing write logic)
    expect(true).toBe(true);
  });
});

/**
 * SQLite Persistence Tests (G5)
 * 使用 ":memory:" 数据库（内存，不写磁盘）
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
  it("migrate() 是幂等的（多次调用不报错）", () => {
    db = openDb();
    expect(() => { db.migrate(); }).not.toThrow();
    expect(() => { db.migrate(); }).not.toThrow();
  });
});

describe("TradeDB — insertTrade + closeTrade", () => {
  it("insertTrade 返回自增 ID", () => {
    db = openDb();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("多次 insertTrade 返回递增 ID", () => {
    db = openDb();
    const id1 = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    const id2 = db.insertTrade("test", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, Date.now());
    expect(id2).toBeGreaterThan(id1);
  });

  it("closeTrade 更新指定 ID 的记录", () => {
    db = openDb();
    const now = Date.now();
    const id = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.closeTrade(id, 53000, 300, 0.06, false, true, now + 3600_000);

    // 通过 getRecentClosedTrades 验证
    const records = db.getRecentClosedTrades("test", 0);
    expect(records).toHaveLength(1);
    expect(records[0]?.symbol).toBe("BTCUSDT");
    expect(records[0]?.pnlRatio).toBeCloseTo(0.06);
    expect(records[0]?.wasStopLoss).toBe(false);
  });

  it("closeTrade wasStopLoss=true 正确写入", () => {
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
  it("只返回指定 scenarioId 的记录", () => {
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

  it("只返回 closedAt >= sinceMs 的记录", () => {
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

  it("未平仓的交易不出现在 getRecentClosedTrades 结果中", () => {
    db = openDb();
    db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, Date.now());
    const records = db.getRecentClosedTrades("test", 0);
    expect(records).toHaveLength(0);
  });

  it("结果按 closedAt 升序排列", () => {
    db = openDb();
    const base = Date.now();
    const id1 = db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, base);
    const id2 = db.insertTrade("test", "ETHUSDT", "buy", 1.0, 3000, 2850, 3300, base);
    db.closeTrade(id2, 3100, 100, 0.033, false, true, base + 2000);
    db.closeTrade(id1, 48000, -200, -0.04, true, false, base + 1000);

    const records = db.getRecentClosedTrades("test", 0);
    expect(records[0]?.symbol).toBe("BTCUSDT"); // 先关的
    expect(records[1]?.symbol).toBe("ETHUSDT");
  });
});

// ─────────────────────────────────────────────────────
// getOpenTrades
// ─────────────────────────────────────────────────────

describe("TradeDB — getOpenTrades", () => {
  it("返回指定场景的未平仓交易", () => {
    db = openDb();
    const now = Date.now();
    db.insertTrade("test", "BTCUSDT", "buy", 0.1, 50000, 47500, 55000, now);
    db.insertTrade("test", "ETHUSDT", "short", 1.0, 3000, 3150, 2700, now);
    const open = db.getOpenTrades("test");
    expect(open).toHaveLength(2);
    expect(open.map((t) => t.symbol)).toContain("BTCUSDT");
    expect(open.map((t) => t.symbol)).toContain("ETHUSDT");
  });

  it("平仓后不出现在 getOpenTrades 结果中", () => {
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
  it("成功记录账户快照（不报错）", () => {
    db = openDb();
    expect(() => {
      db.recordSnapshot("test", 10250.5, 8000, 2, Date.now());
    }).not.toThrow();
  });

  it("可以记录多个快照", () => {
    db = openDb();
    const now = Date.now();
    db.recordSnapshot("test", 10000, 8000, 2, now);
    db.recordSnapshot("test", 10100, 8100, 2, now + 3600_000);
    // 只验证不报错（快照没有读取接口，测试写入逻辑）
    expect(true).toBe(true);
  });
});

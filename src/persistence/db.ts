/**
 * SQLite Optional Persistence (G5)
 *
 * Features:
 *   - Optional SQLite database (enabled via paper.use_sqlite: true)
 *   - trades table: open/close trade records
 *   - account_snapshots table: periodic account snapshots
 *   - Recent closed trades query interface for ProtectionManager
 *
 * Testing: Use ":memory:" path (in-memory database, no disk writes)
 */

import Database from "better-sqlite3";
import type { TradeRecord } from "../strategy/protection-manager.js";

// ─────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────

const CREATE_TRADES = `
CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scenarioId  TEXT    NOT NULL,
  symbol      TEXT    NOT NULL,
  side        TEXT    NOT NULL,   -- buy | sell | short | cover
  quantity    REAL    NOT NULL,
  entryPrice  REAL    NOT NULL,
  stopLoss    REAL    NOT NULL,
  takeProfit  REAL    NOT NULL,
  openAt      INTEGER NOT NULL,   -- Unix ms
  exitPrice   REAL,               -- NULL = still open
  pnl         REAL,
  pnlRatio    REAL,
  wasStopLoss INTEGER DEFAULT 0,  -- 0 | 1
  wasRoiExit  INTEGER DEFAULT 0,
  closedAt    INTEGER,            -- NULL = still open
  status      TEXT    DEFAULT 'open'  -- open | closed
)
`;

const CREATE_SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS account_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scenarioId    TEXT    NOT NULL,
  equity        REAL    NOT NULL,
  cash          REAL    NOT NULL,
  openPositions INTEGER NOT NULL,
  snapshotAt    INTEGER NOT NULL   -- Unix ms
)
`;

const CREATE_TRADES_IDX = `
CREATE INDEX IF NOT EXISTS idx_trades_scenario_status
  ON trades (scenarioId, status)
`;

const CREATE_SNAPSHOTS_IDX = `
CREATE INDEX IF NOT EXISTS idx_snapshots_scenario_time
  ON account_snapshots (scenarioId, snapshotAt)
`;

// ─────────────────────────────────────────────────────
// TradeDB Class
// ─────────────────────────────────────────────────────

export class TradeDB {
  private readonly db: InstanceType<typeof Database>;

  /**
   * @param dbPath SQLite file path.
   *   - "logs/trades.db": write to logs/ directory (production use)
   *   - ":memory:": in-memory database (for testing, destroyed on process exit)
   */
  constructor(dbPath = "logs/trades.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // Improve concurrent write performance
    this.migrate();
  }

  /**
   * Create tables (idempotent, skips if already exists)
   */
  migrate(): void {
    this.db.exec(CREATE_TRADES);
    this.db.exec(CREATE_SNAPSHOTS);
    this.db.exec(CREATE_TRADES_IDX);
    this.db.exec(CREATE_SNAPSHOTS_IDX);
  }

  /**
   * Record an opening trade
   * @returns Newly inserted trade ID (used to associate with closing trade later)
   */
  insertTrade(
    scenarioId: string,
    symbol: string,
    side: "buy" | "sell" | "short" | "cover",
    quantity: number,
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    openAt: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades (scenarioId, symbol, side, quantity, entryPrice, stopLoss, takeProfit, openAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `);
    const result = stmt.run(scenarioId, symbol, side, quantity, entryPrice, stopLoss, takeProfit, openAt);
    return result.lastInsertRowid as number;
  }

  /**
   * Record a closing trade (mark trade as closed, fill exitPrice/pnl/closedAt fields)
   */
  closeTrade(
    id: number,
    exitPrice: number,
    pnl: number,
    pnlRatio: number,
    wasStopLoss: boolean,
    wasRoiExit: boolean,
    closedAt: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE trades
      SET exitPrice = ?, pnl = ?, pnlRatio = ?,
          wasStopLoss = ?, wasRoiExit = ?,
          closedAt = ?, status = 'closed'
      WHERE id = ?
    `);
    stmt.run(exitPrice, pnl, pnlRatio, wasStopLoss ? 1 : 0, wasRoiExit ? 1 : 0, closedAt, id);
  }

  /**
   * Query recent closed trades, converted to TradeRecord[] (for ProtectionManager use)
   *
   * @param scenarioId  Scenario ID (isolates trade history between scenarios)
   * @param sinceMs     Only returns records where closedAt >= sinceMs
   */
  getRecentClosedTrades(scenarioId: string, sinceMs: number): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT symbol, closedAt, pnlRatio, wasStopLoss
      FROM trades
      WHERE scenarioId = ? AND status = 'closed' AND closedAt >= ?
      ORDER BY closedAt ASC
    `);
    const rows = stmt.all(scenarioId, sinceMs) as {
      symbol: string;
      closedAt: number;
      pnlRatio: number;
      wasStopLoss: number;
    }[];
    return rows.map((r) => ({
      symbol: r.symbol,
      closedAt: r.closedAt,
      pnlRatio: r.pnlRatio,
      wasStopLoss: r.wasStopLoss === 1,
    }));
  }

  /**
   * Query currently open trades (for position reconciliation)
   */
  getOpenTrades(scenarioId: string): {
    id: number;
    symbol: string;
    side: string;
    entryPrice: number;
    quantity: number;
    openAt: number;
  }[] {
    const stmt = this.db.prepare(`
      SELECT id, symbol, side, entryPrice, quantity, openAt
      FROM trades
      WHERE scenarioId = ? AND status = 'open'
      ORDER BY openAt ASC
    `);
    return stmt.all(scenarioId) as {
      id: number;
      symbol: string;
      side: string;
      entryPrice: number;
      quantity: number;
      openAt: number;
    }[];
  }

  /**
   * Record an account snapshot (called periodically)
   */
  recordSnapshot(
    scenarioId: string,
    equity: number,
    cash: number,
    openPositions: number,
    snapshotAt: number
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO account_snapshots (scenarioId, equity, cash, openPositions, snapshotAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(scenarioId, equity, cash, openPositions, snapshotAt);
  }

  /**
   * Close the database connection (called on test cleanup or process exit)
   */
  close(): void {
    this.db.close();
  }
}

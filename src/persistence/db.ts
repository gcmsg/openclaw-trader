/**
 * SQLite 可选持久化（G5）
 *
 * 功能：
 *   - 可选 SQLite 数据库（配置 paper.use_sqlite: true 开启）
 *   - trades 表：开仓/平仓记录
 *   - account_snapshots 表：定时账户快照
 *   - 供 ProtectionManager 使用的近期平仓查询接口
 *
 * 测试：使用 ":memory:" 路径（内存数据库，不写磁盘）
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
// TradeDB 类
// ─────────────────────────────────────────────────────

export class TradeDB {
  private readonly db: InstanceType<typeof Database>;

  /**
   * @param dbPath SQLite 文件路径。
   *   - "logs/trades.db"：写入 logs/ 目录（生产用）
   *   - ":memory:"：内存数据库（测试用，进程结束后自动销毁）
   */
  constructor(dbPath = "logs/trades.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // 提升并发写入性能
    this.migrate();
  }

  /**
   * 建表（幂等，已存在则跳过）
   */
  migrate(): void {
    this.db.exec(CREATE_TRADES);
    this.db.exec(CREATE_SNAPSHOTS);
    this.db.exec(CREATE_TRADES_IDX);
    this.db.exec(CREATE_SNAPSHOTS_IDX);
  }

  /**
   * 记录开仓交易
   * @returns 新插入的 trade ID（用于后续平仓时关联）
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
   * 记录平仓（标记 trade 为 closed，填充 exitPrice/pnl/closedAt 等字段）
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
   * 查询近期已平仓记录，转换为 TradeRecord[]（供 ProtectionManager 使用）
   *
   * @param scenarioId  场景 ID（隔离不同场景的交易历史）
   * @param sinceMs     只返回 closedAt >= sinceMs 的记录
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
   * 查询当前未平仓交易（用于持仓对账）
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
   * 记录账户快照（定期调用）
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
   * 关闭数据库连接（测试或进程退出时调用）
   */
  close(): void {
    this.db.close();
  }
}

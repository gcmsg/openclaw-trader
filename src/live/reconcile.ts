/**
 * Position Reconciliation on Startup
 *
 * Compares local account (paper-*.json) with actual exchange positions
 * (via API) at live-monitor.ts startup, and automatically syncs differences.
 *
 * ## Scenarios
 * 1. Server restart: local positions correct, no exchange orders -> already recorded, continue running
 * 2. Manual close: exchange has no position but local has one -> alert, local needs sync
 * 3. Exchange has position but local does not: possible manual intervention -> alert, await confirmation
 * 4. Quantity difference > 5%: price fluctuation or precision issue -> alert
 *
 * ## Results
 * - status: "ok" | "warning" | "critical"
 * - critical -> recommend pausing live trading and waiting for manual confirmation
 * - warning  -> log and continue running (difference within tolerance)
 */

import type { PaperAccount } from "../paper/account.js";

// ─── Types ──────────────────────────────────────────────

export interface ExchangePosition {
  symbol: string;
  side: "long" | "short";
  qty: number;       // Quantity (base asset)
  avgPrice: number;  // Average price
}

export interface ReconcileDiscrepancy {
  symbol: string;
  issue: "missing_local" | "missing_exchange" | "qty_mismatch";
  localQty?: number;
  exchangeQty?: number;
  diffPct?: number;
  description: string;
}

export type ReconcileStatus = "ok" | "warning" | "critical";

export interface ReconcileResult {
  status: ReconcileStatus;
  discrepancies: ReconcileDiscrepancy[];
  message: string;
  autoSynced: string[]; // List of auto-synced symbols
}

// ─── Core comparison logic ─────────────────────────────────────

const QTY_TOLERANCE_PCT = 5; // Quantity difference tolerance (5%)

/**
 * Compare local account positions vs exchange positions
 *
 * @param account          Local paper account
 * @param exchangePositions Current exchange positions (provided by executor.getPositions())
 * @param autoSyncMissing  Whether to auto-sync positions that exist on exchange but not locally (default false)
 */
export function reconcilePositions(
  account: PaperAccount,
  exchangePositions: ExchangePosition[],
  autoSyncMissing = false
): ReconcileResult {
  const discrepancies: ReconcileDiscrepancy[] = [];
  const autoSynced: string[] = [];

  const localSymbols = new Set(Object.keys(account.positions));
  const exchangeMap = new Map<string, ExchangePosition>();
  for (const pos of exchangePositions) {
    exchangeMap.set(pos.symbol, pos);
  }

  // Check positions that exist locally but not on exchange
  for (const symbol of localSymbols) {
    if (!exchangeMap.has(symbol)) {
      const localQty = account.positions[symbol]?.quantity;
      discrepancies.push({
        symbol,
        issue: "missing_exchange",
        ...(localQty !== undefined ? { localQty } : {}),
        description: `Local position ${symbol} not found on exchange (may have been closed or manually modified)`,
      });
    }
  }

  // Check positions that exist on exchange but not locally
  for (const [symbol, exPos] of exchangeMap) {
    if (!localSymbols.has(symbol)) {
      discrepancies.push({
        symbol,
        issue: "missing_local",
        exchangeQty: exPos.qty,
        description: `Exchange position ${symbol} not recorded locally (manual open or missed record)`,
      });
      if (autoSyncMissing) {
        // Auto-sync: record exchange position to local account
        // Note: only records here, actual write is done by caller
        autoSynced.push(symbol);
      }
    }
  }

  // Check quantity differences
  for (const symbol of localSymbols) {
    const exPos = exchangeMap.get(symbol);
    if (!exPos) continue; // Already handled above

    const localQty = account.positions[symbol]?.quantity ?? 0;
    const exchangeQty = exPos.qty;

    if (localQty === 0 || exchangeQty === 0) continue;

    const diffPct = Math.abs(localQty - exchangeQty) / localQty * 100;
    if (diffPct > QTY_TOLERANCE_PCT) {
      discrepancies.push({
        symbol,
        issue: "qty_mismatch",
        localQty,
        exchangeQty,
        diffPct,
        description: `${symbol} quantity mismatch ${diffPct.toFixed(1)}% (local ${localQty.toFixed(6)}, exchange ${exchangeQty.toFixed(6)})`,
      });
    }
  }

  // Determine severity
  let status: ReconcileStatus = "ok";
  if (discrepancies.some((d) => d.issue === "qty_mismatch" && (d.diffPct ?? 0) > 10)) {
    status = "critical";
  } else if (discrepancies.length > 0) {
    status = "warning";
  }

  const message = discrepancies.length === 0
    ? "✅ Local account matches exchange positions"
    : `${status === "critical" ? "🚨" : "⚠️"} Found ${discrepancies.length} discrepancies: ${discrepancies.map((d) => d.description).join("; ")}`;

  return { status, discrepancies, message, autoSynced };
}

/**
 * Format reconciliation report (for logs and Telegram notifications)
 */
export function formatReconcileReport(result: ReconcileResult): string {
  const lines: string[] = [
    `🔍 **Position Reconciliation Report** [on startup]`,
    ``,
    result.message,
  ];

  if (result.discrepancies.length > 0) {
    lines.push(``, `**Discrepancy details:**`);
    for (const d of result.discrepancies) {
      const icon = d.issue === "qty_mismatch" ? "📊" : d.issue === "missing_local" ? "🆕" : "❓";
      lines.push(`${icon} ${d.description}`);
    }
  }

  if (result.autoSynced.length > 0) {
    lines.push(``, `🔄 **Auto synced**: ${result.autoSynced.join(", ")}`);
  }

  if (result.status === "critical") {
    lines.push(``, `⛔ **Recommend pausing live trading, manually confirm before restarting!**`);
  }

  return lines.join("\n");
}

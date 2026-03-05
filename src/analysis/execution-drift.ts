/**
 * Paper vs Live Execution Drift Monitoring
 *
 * Compares execution results of the same signal across different
 * scenarios (paper / live), detecting slippage differences (execution drift).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PaperAccount, PaperTrade } from "../paper/account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** Default deviation threshold (%) */
export const DEFAULT_DRIFT_THRESHOLD = 0.5;

/** Tolerance window for matching entryTime across scenarios (milliseconds) */
const MATCH_WINDOW_MS = 60_000; // 60 seconds

// ── Internally reconstructed "closed trade" records ──────────────────────────

interface ReconstructedTrade {
  symbol: string;
  side: "long" | "short";
  entryTime: number;
  entryFillPrice: number;
  /** Slippage amount / fill quantity, i.e. slippage per unit (USDT/unit) */
  entrySlippagePerUnit: number;
  quantity: number;
}

// ── Public Interface ──────────────────────────────────────────────

export interface DriftRecord {
  symbol: string;
  side: "long" | "short";
  signalTime: number; // signal trigger timestamp (= paper entry time)
  signalPrice: number; // price at signal detection (quote price, back-calculated from slippage)
  paperFillPrice: number; // paper fill price
  liveFillPrice: number; // live/testnet fill price
  paperSlippage: number; // paper slippage %
  liveSlippage: number; // live slippage %
  driftPercent: number; // deviation = |paperSlippage - liveSlippage|
  scenarioPaper: string; // paper scenario ID
  scenarioLive: string; // live scenario ID
}

// ── Helper Functions ──────────────────────────────────────────────

/**
 * Reconstruct all closed trades (entry -> exit pairing)
 * from the trades array in paper-{scenarioId}.json.
 */
export function reconstructClosedTrades(scenarioId: string): ReconstructedTrade[] {
  const filePath = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  if (!fs.existsSync(filePath)) return [];

  let account: PaperAccount;
  try {
    account = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PaperAccount;
  } catch {
    return [];
  }

  const trades = account.trades;
  const results: ReconstructedTrade[] = [];

  // Group by symbol, process in chronological order
  const bySymbol = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  for (const [symbol, symbolTrades] of bySymbol) {
    // Sort by timestamp ascending
    symbolTrades.sort((a, b) => a.timestamp - b.timestamp);

    // Simple stack: unpaired entry trades
    const entryStack: PaperTrade[] = [];

    for (const trade of symbolTrades) {
      if (trade.side === "buy" || trade.side === "short") {
        // Entry: only when no pnl (non-DCA re-entries are also included)
        if (trade.pnl === undefined) {
          entryStack.push(trade);
        }
      } else {
        // Exit (sell / cover): pair with the most recent unpaired entry
        const entry = entryStack.pop();
        if (!entry) continue;

        const side: "long" | "short" = entry.side === "buy" ? "long" : "short";
        // Back-calculate signal price:
        //   buy:   execPrice = signalPrice + slippagePerUnit  -> signalPrice = execPrice - slippagePerUnit
        //   short: execPrice = signalPrice - slippagePerUnit  -> signalPrice = execPrice + slippagePerUnit
        const entrySlippagePerUnit = entry.quantity > 0 ? entry.slippage / entry.quantity : 0;

        results.push({
          symbol,
          side,
          entryTime: entry.timestamp,
          entryFillPrice: entry.price,
          entrySlippagePerUnit,
          quantity: entry.quantity,
        });
      }
    }
  }

  return results;
}

/**
 * Calculate slippage percentage (%).
 * signalPrice = fillPrice +/- slippagePerUnit (different direction for long/short)
 */
function calcSlippagePct(
  side: "long" | "short",
  fillPrice: number,
  slippagePerUnit: number,
): number {
  if (fillPrice <= 0) return 0;
  const signalPrice =
    side === "long" ? fillPrice - slippagePerUnit : fillPrice + slippagePerUnit;
  if (signalPrice <= 0) return 0;
  return (Math.abs(fillPrice - signalPrice) / signalPrice) * 100;
}

/**
 * Back-calculate signal price from slippage.
 */
function calcSignalPrice(
  side: "long" | "short",
  fillPrice: number,
  slippagePerUnit: number,
): number {
  return side === "long" ? fillPrice - slippagePerUnit : fillPrice + slippagePerUnit;
}

// ── Core Export Functions ──────────────────────────────────────────

/**
 * Compare execution results of the same signal across different scenarios to detect execution drift.
 * Matches trade pairs with same symbol+entryTime from closedTrades in paper-{scenarioId}.json.
 */
export function detectDrift(paperScenarioId: string, liveScenarioId: string): DriftRecord[] {
  const paperTrades = reconstructClosedTrades(paperScenarioId);
  const liveTrades = reconstructClosedTrades(liveScenarioId);

  if (paperTrades.length === 0 || liveTrades.length === 0) return [];

  const records: DriftRecord[] = [];

  for (const paper of paperTrades) {
    // Find matching record in live with same symbol and entryTime within tolerance window
    const liveMatch = liveTrades.find(
      (lv) =>
        lv.symbol === paper.symbol &&
        lv.side === paper.side &&
        Math.abs(lv.entryTime - paper.entryTime) <= MATCH_WINDOW_MS,
    );

    if (!liveMatch) continue;

    const signalPrice = calcSignalPrice(
      paper.side,
      paper.entryFillPrice,
      paper.entrySlippagePerUnit,
    );
    const paperSlippage = calcSlippagePct(
      paper.side,
      paper.entryFillPrice,
      paper.entrySlippagePerUnit,
    );
    const liveSlippage = calcSlippagePct(
      liveMatch.side,
      liveMatch.entryFillPrice,
      liveMatch.entrySlippagePerUnit,
    );
    const driftPercent = Math.abs(paperSlippage - liveSlippage);

    records.push({
      symbol: paper.symbol,
      side: paper.side,
      signalTime: paper.entryTime,
      signalPrice,
      paperFillPrice: paper.entryFillPrice,
      liveFillPrice: liveMatch.entryFillPrice,
      paperSlippage,
      liveSlippage,
      driftPercent,
      scenarioPaper: paperScenarioId,
      scenarioLive: liveScenarioId,
    });
  }

  return records;
}

/**
 * Generate drift report summary.
 * Includes: average deviation, max deviation, number of trades with deviation > threshold.
 */
export function summarizeDrift(
  records: DriftRecord[],
  threshold = DEFAULT_DRIFT_THRESHOLD,
): {
  totalPairs: number;
  avgDriftPercent: number;
  maxDriftPercent: number;
  driftExceedingThreshold: number; // count of deviations > threshold
  bySymbol: Record<string, { count: number; avgDrift: number }>;
} {
  if (records.length === 0) {
    return {
      totalPairs: 0,
      avgDriftPercent: 0,
      maxDriftPercent: 0,
      driftExceedingThreshold: 0,
      bySymbol: {},
    };
  }

  const totalPairs = records.length;
  const sumDrift = records.reduce((acc, r) => acc + r.driftPercent, 0);
  const avgDriftPercent = sumDrift / totalPairs;
  const maxDriftPercent = Math.max(...records.map((r) => r.driftPercent));
  const driftExceedingThreshold = records.filter((r) => r.driftPercent > threshold).length;

  // Group by symbol
  const symbolMap = new Map<string, { sum: number; count: number }>();
  for (const r of records) {
    const entry = symbolMap.get(r.symbol) ?? { sum: 0, count: 0 };
    entry.sum += r.driftPercent;
    entry.count += 1;
    symbolMap.set(r.symbol, entry);
  }

  const bySymbol: Record<string, { count: number; avgDrift: number }> = {};
  for (const [sym, { sum, count }] of symbolMap) {
    bySymbol[sym] = { count, avgDrift: sum / count };
  }

  return {
    totalPairs,
    avgDriftPercent,
    maxDriftPercent,
    driftExceedingThreshold,
    bySymbol,
  };
}

/**
 * Format drift report as human-readable text.
 */
export function formatDriftReport(
  summary: ReturnType<typeof summarizeDrift>,
  threshold = DEFAULT_DRIFT_THRESHOLD,
): string {
  const lines: string[] = [
    "═══════════════════════════════════════",
    "   Paper vs Live Execution Drift Report",
    "═══════════════════════════════════════",
    `Total matched pairs:  ${summary.totalPairs}`,
    `Average drift:        ${summary.avgDriftPercent.toFixed(4)} %`,
    `Max drift:            ${summary.maxDriftPercent.toFixed(4)} %`,
    `Drift > ${threshold}%:       ${summary.driftExceedingThreshold} trades`,
    "───────────────────────────────────────",
  ];

  if (Object.keys(summary.bySymbol).length > 0) {
    lines.push("By symbol statistics:");
    for (const [symbol, { count, avgDrift }] of Object.entries(summary.bySymbol)) {
      lines.push(`  ${symbol.padEnd(12)} count=${count}  avgDrift=${avgDrift.toFixed(4)}%`);
    }
    lines.push("───────────────────────────────────────");
  }

  if (summary.totalPairs === 0) {
    lines.push("⚠️  No matched trade pairs, unable to calculate drift.");
  } else if (summary.driftExceedingThreshold === 0) {
    lines.push(`✅ All trade drifts are within ${threshold}%, execution quality is good.`);
  } else {
    lines.push(
      `⚠️  ${summary.driftExceedingThreshold} trades exceeded ${threshold}% drift, consider reviewing execution config.`,
    );
  }

  return lines.join("\n");
}

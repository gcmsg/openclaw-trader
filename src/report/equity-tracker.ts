/**
 * Equity curve history tracker
 * Writes equity snapshots to a JSONL file, rate-limited to one entry per hour.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOGS_DIR = path.resolve(__dirname, "../../logs");

interface EquitySnapshot {
  timestamp: number;
  equity: number;
  positions: number;
}

/** Return equity-history JSONL file path (easy to override in tests) */
export function getEquityHistoryPath(scenarioId: string): string {
  return path.join(LOGS_DIR, `equity-history-${scenarioId}.jsonl`);
}

/**
 * Record current equity snapshot to logs/equity-history-{scenarioId}.jsonl.
 * Rate-limited to one entry per hour (based on last line timestamp).
 */
export function recordEquitySnapshot(
  scenarioId: string,
  equity: number,
  positions: number
): void {
  const filePath = getEquityHistoryPath(scenarioId);
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  // Rate limiting: 1 hour per write
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trimEnd().split("\n").filter((l) => l.trim() !== "");
    const lastLine = lines[lines.length - 1];
    if (lastLine !== undefined && lastLine !== "") {
      try {
        const last = JSON.parse(lastLine) as EquitySnapshot;
        if (now - last.timestamp < oneHourMs) {
          return; // too recent, skip
        }
      } catch {
        // malformed last line — fall through and write
      }
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const snapshot: EquitySnapshot = { timestamp: now, equity, positions };
  fs.appendFileSync(filePath, JSON.stringify(snapshot) + "\n", "utf-8");
}

/**
 * Load equity history (sorted by time ascending), optionally filtered by days.
 */
export function loadEquityHistory(
  scenarioId: string,
  sinceDaysAgo?: number
): { timestamp: number; equity: number; positions: number }[] {
  const filePath = getEquityHistoryPath(scenarioId);
  if (!fs.existsSync(filePath)) return [];

  const cutoff =
    sinceDaysAgo !== undefined ? Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000 : 0;

  const content = fs.readFileSync(filePath, "utf-8");
  const results: { timestamp: number; equity: number; positions: number }[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as EquitySnapshot;
      if (entry.timestamp >= cutoff) {
        results.push({ timestamp: entry.timestamp, equity: entry.equity, positions: entry.positions });
      }
    } catch {
      // skip malformed lines
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

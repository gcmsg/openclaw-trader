/**
 * Strategy Plugin State Store (P7.4)
 *
 * Provides cross-kline state persistence interface for each Strategy plugin.
 * File path: logs/strategy-state/{strategyId}/{symbol}.json
 */

import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────
// Public Interface
// ─────────────────────────────────────────────────────

export interface StateStore {
  /**
   * Read a state value (type-safe)
   * @param key           State key name
   * @param defaultValue  Returned if the key does not exist
   */
  get<T>(key: string, defaultValue: T): T;

  /**
   * Write a state value (immediately persisted to disk)
   */
  set(key: string, value: unknown): void;

  /**
   * Delete a state key
   */
  delete(key: string): void;

  /**
   * Get all state (read-only snapshot)
   */
  snapshot(): Record<string, unknown>;
}

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────

/**
 * Load existing state (internal use)
 * Returns empty object if file doesn't exist or content is corrupted (no throw)
 */
function loadState(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // File not found (ENOENT) or corrupted JSON -> fall back to empty state
    return {};
  }
}

/**
 * Save state (internal use, synchronous file write)
 * Auto-creates directory if it doesn't exist
 */
function saveState(filePath: string, state: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

// ─────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────

/**
 * Create a state store instance bound to a specific strategy + symbol
 * File path: {logsDir}/strategy-state/{strategyId}/{symbol}.json
 *
 * @param strategyId  Strategy ID (e.g. "rsi-reversal")
 * @param symbol      Trading pair (e.g. "BTCUSDT")
 * @param logsDir     Logs directory (default "logs", injectable for testing)
 */
export function createStateStore(
  strategyId: string,
  symbol: string,
  logsDir = "logs"
): StateStore {
  const filePath = path.join(logsDir, "strategy-state", strategyId, `${symbol}.json`);

  // In-memory cache, lazy-loaded
  let cache: Record<string, unknown> | null = null;

  function ensureLoaded(): Record<string, unknown> {
    cache ??= loadState(filePath);
    return cache;
  }

  return {
    get<T>(key: string, defaultValue: T): T {
      const state = ensureLoaded();
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        return state[key] as T;
      }
      return defaultValue;
    },

    set(key: string, value: unknown): void {
      const state = ensureLoaded();
      state[key] = value;
      saveState(filePath, state);
    },

    delete(key: string): void {
      const state = ensureLoaded();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete state[key];
      saveState(filePath, state);
    },

    snapshot(): Record<string, unknown> {
      const state = ensureLoaded();
      return { ...state };
    },
  };
}

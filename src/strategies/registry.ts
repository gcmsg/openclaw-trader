/**
 * Strategy Registry (F4)
 *
 * Maintains an id -> Strategy mapping for signal-engine and script queries.
 */

import type { Strategy } from "./types.js";

const _registry = new Map<string, Strategy>();

/**
 * Register a strategy plugin. Re-registering the same id overwrites (convenient for testing).
 */
export function registerStrategy(s: Strategy): void {
  _registry.set(s.id, s);
}

/**
 * Get a strategy by id. Throws an error if not found.
 */
export function getStrategy(id: string): Strategy {
  const s = _registry.get(id);
  if (!s) {
    throw new Error(
      `Strategy "${id}" not found. Registered: ${[..._registry.keys()].join(", ") || "(none)"}`
    );
  }
  return s;
}

/**
 * List all registered strategy ids.
 */
export function listStrategies(): string[] {
  return [..._registry.keys()];
}

/**
 * List all registered strategy details (including name/description).
 */
export function listStrategyDetails(): {
  id: string;
  name: string;
  description?: string;
}[] {
  return [..._registry.values()].map((s) => ({
    id: s.id,
    name: s.name,
    ...(s.description !== undefined ? { description: s.description } : {}),
  }));
}

/**
 * Strategy Registry Tests (F4)
 * Tests the complete behavior of registerStrategy / getStrategy / listStrategies
 */
import { describe, it, expect } from "vitest";

// Uses an isolated test registry (avoids polluting the global registry)
// Directly tests the exported behavior of the registry module

import {
  registerStrategy,
  getStrategy,
  listStrategies,
  listStrategyDetails,
} from "../strategies/registry.js";
import type { Strategy } from "../strategies/types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function makeStrategy(id: string, name = `Strategy ${id}`): Strategy {
  return {
    id,
    name,
    description: `Test strategy: ${id}`,
    populateSignal: () => "none",
  };
}

// ─────────────────────────────────────────────────────
// Register / get / list
// ─────────────────────────────────────────────────────

describe("Strategy Registry", () => {
  // Note: registry is a global singleton, built-in strategies (default, rsi-reversal, breakout)
  // are registered via index.ts import, but here we only test registry core behavior

  it("registerStrategy + getStrategy basic flow", () => {
    const s = makeStrategy("test-basic");
    registerStrategy(s);
    const retrieved = getStrategy("test-basic");
    expect(retrieved.id).toBe("test-basic");
    expect(retrieved.name).toBe("Strategy test-basic");
  });

  it("re-registering same id overwrites (later one takes effect)", () => {
    const s1 = { ...makeStrategy("test-override"), name: "First" };
    const s2 = { ...makeStrategy("test-override"), name: "Second" };
    registerStrategy(s1);
    registerStrategy(s2);
    expect(getStrategy("test-override").name).toBe("Second");
  });

  it("listStrategies returns all registered ids", () => {
    registerStrategy(makeStrategy("test-list-a"));
    registerStrategy(makeStrategy("test-list-b"));
    const ids = listStrategies();
    expect(ids).toContain("test-list-a");
    expect(ids).toContain("test-list-b");
  });

  it("listStrategyDetails includes id / name / description", () => {
    registerStrategy({
      id: "test-details",
      name: "Detail Test",
      description: "Detailed description",
      populateSignal: () => "buy",
    });
    const details = listStrategyDetails();
    const found = details.find((d) => d.id === "test-details");
    expect(found).toBeDefined();
    expect(found?.name).toBe("Detail Test");
    expect(found?.description).toBe("Detailed description");
  });

  it("listStrategyDetails - no description field when not provided", () => {
    registerStrategy({
      id: "test-no-desc",
      name: "No Desc",
      populateSignal: () => "none",
    });
    const details = listStrategyDetails();
    const found = details.find((d) => d.id === "test-no-desc");
    expect(found).toBeDefined();
    expect("description" in (found ?? {})).toBe(false);
  });

  // ─── Unknown strategy error ───────────────────────────────────

  it("getStrategy throws error for non-existent id", () => {
    expect(() => getStrategy("nonexistent-strategy-xyz")).toThrow(
      `Strategy "nonexistent-strategy-xyz" not found`
    );
  });

  it("error message includes list of registered strategies", () => {
    registerStrategy(makeStrategy("test-registered-one"));
    try {
      getStrategy("not-there");
    } catch (e) {
      expect((e as Error).message).toContain("test-registered-one");
    }
  });

  // ─── Built-in strategies are registered (via index.ts side effect) ────────

  it("built-in strategy default is registered", async () => {
    // Trigger registration
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("default");
  });

  it("built-in strategy rsi-reversal is registered", async () => {
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("rsi-reversal");
  });

  it("built-in strategy breakout is registered", async () => {
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("breakout");
  });
});

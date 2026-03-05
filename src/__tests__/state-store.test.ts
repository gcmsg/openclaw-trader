/**
 * State Store unit tests (P7.4)
 *
 * Uses a temporary directory for file system operations (same pattern as log-rotate.test.ts).
 * Uses a manual mock StateStore when testing rsi-reversal state integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createStateStore } from "../strategies/state-store.js";
import type { StateStore } from "../strategies/state-store.js";
import { rsiReversalStrategy } from "../strategies/rsi-reversal.js";
import type { StrategyContext, TradeResult } from "../strategies/types.js";
import type { StrategyConfig, Kline } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(strategyId = "test-strategy", symbol = "BTCUSDT"): StateStore {
  return createStateStore(strategyId, symbol, tmpDir);
}

/** Build a minimal StrategyContext (without stateStore) */
function makeCtx(rsiValue: number, stateStore?: StateStore): StrategyContext {
  const klines: Kline[] = [];
  const cfg = {
    strategy: {
      rsi: { oversold: 30, overbought: 70 },
    },
  } as unknown as StrategyConfig;
  return {
    klines,
    cfg,
    indicators: {
      rsi: rsiValue,
      maShort: 100,
      maLong: 100,
      price: 100,
      volume: 1000,
      avgVolume: 1000,
    },
    ...(stateStore !== undefined ? { stateStore } : {}),
  };
}

function makeTradeResult(pnl: number): TradeResult {
  return {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    exitPrice: pnl >= 0 ? 101 : 99,
    pnl,
    pnlPercent: pnl / 100,
    holdMs: 3_600_000,
    exitReason: pnl >= 0 ? "take_profit" : "stop_loss",
  };
}

// ─────────────────────────────────────────────────────
// 1. createStateStore — basics
// ─────────────────────────────────────────────────────

describe("createStateStore — basics", () => {
  it("1. returns an object with get/set/delete/snapshot methods", () => {
    const store = makeStore();
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.snapshot).toBe("function");
  });

  it("2. get: returns defaultValue when file does not exist", () => {
    const store = makeStore();
    expect(store.get("missing", 42)).toBe(42);
    expect(store.get("missing", "hello")).toBe("hello");
    expect(store.get("missing", false)).toBe(false);
  });

  it("3. get: returns stored value when file exists", () => {
    const store = makeStore();
    store.set("foo", "bar");

    // Create new instance (re-read from file)
    const store2 = makeStore();
    expect(store2.get("foo", "default")).toBe("bar");
  });

  it("4. get: returns defaultValue when key does not exist", () => {
    const store = makeStore();
    store.set("existing", 1);
    expect(store.get("nonexistent", 99)).toBe(99);
  });
});

// ─────────────────────────────────────────────────────
// 2. set — write behavior
// ─────────────────────────────────────────────────────

describe("set — write behavior", () => {
  it("5. set: writes value to state and persists to file", () => {
    const store = makeStore("my-strategy", "ETHUSDT");
    store.set("testKey", "testValue");

    const expectedPath = path.join(tmpDir, "strategy-state", "my-strategy", "ETHUSDT.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as Record<string, unknown>;
    expect(content["testKey"]).toBe("testValue");
  });

  it("6. set: immediately readable via get after writing (memory consistency)", () => {
    const store = makeStore();
    store.set("counter", 10);
    expect(store.get("counter", 0)).toBe(10);
    store.set("counter", 20);
    expect(store.get("counter", 0)).toBe(20);
  });

  it("7. set: writes number type", () => {
    const store = makeStore();
    store.set("price", 42000.5);
    expect(store.get("price", 0)).toBe(42000.5);
  });

  it("8. set: writes object type", () => {
    const store = makeStore();
    const obj = { a: 1, b: "hello" };
    store.set("config", obj);
    expect(store.get("config", {})).toEqual(obj);
  });

  it("9. set: writes array type", () => {
    const store = makeStore();
    const arr = [1, 2, 3];
    store.set("history", arr);
    expect(store.get("history", [] as number[])).toEqual([1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────
// 3. delete
// ─────────────────────────────────────────────────────

describe("delete", () => {
  it("10. delete: deletes an existing key", () => {
    const store = makeStore();
    store.set("toDelete", "value");
    store.delete("toDelete");
    expect(store.get("toDelete", "default")).toBe("default");
  });

  it("11. delete: deleting a non-existent key does not throw", () => {
    const store = makeStore();
    expect(() => { store.delete("nonexistent"); }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────
// 4. snapshot
// ─────────────────────────────────────────────────────

describe("snapshot", () => {
  it("12. snapshot: returns a shallow copy of all current state", () => {
    const store = makeStore();
    store.set("a", 1);
    store.set("b", "hello");
    const snap = store.snapshot();
    expect(snap).toEqual({ a: 1, b: "hello" });
  });

  it("13. snapshot: modifying the returned value does not affect internal state", () => {
    const store = makeStore();
    store.set("x", 10);
    const snap = store.snapshot();
    snap["x"] = 999;
    // Internal state is not affected
    expect(store.get("x", 0)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────
// 5. File path and directory creation
// ─────────────────────────────────────────────────────

describe("File path and automatic directory creation", () => {
  it("14. automatically creates directory when it does not exist", () => {
    const deepDir = path.join(tmpDir, "nested", "subdir");
    // deepDir does not exist yet
    const store = createStateStore("my-strat", "SOLUSDT", deepDir);
    store.set("key", "val");
    const expectedDir = path.join(deepDir, "strategy-state", "my-strat");
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, "SOLUSDT.json"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// 6. Isolation
// ─────────────────────────────────────────────────────

describe("store isolation", () => {
  it("15. two stores with different symbols are independent (no shared state)", () => {
    const storeA = createStateStore("strategy", "BTCUSDT", tmpDir);
    const storeB = createStateStore("strategy", "ETHUSDT", tmpDir);

    storeA.set("losses", 5);
    storeB.set("losses", 2);

    expect(storeA.get("losses", 0)).toBe(5);
    expect(storeB.get("losses", 0)).toBe(2);
  });

  it("16. two stores with the same symbol share the file (later write overwrites earlier)", () => {
    const storeA = createStateStore("strategy", "BTCUSDT", tmpDir);
    const storeB = createStateStore("strategy", "BTCUSDT", tmpDir);

    storeA.set("val", "first");
    storeB.set("val", "second");

    // storeA re-reads from file (new instance)
    const storeC = createStateStore("strategy", "BTCUSDT", tmpDir);
    expect(storeC.get("val", "")).toBe("second");
  });
});

// ─────────────────────────────────────────────────────
// 7. Error tolerance
// ─────────────────────────────────────────────────────

describe("Error tolerance", () => {
  it("17. corrupted file (non-JSON) falls back to empty state without throwing", () => {
    const stateDir = path.join(tmpDir, "strategy-state", "broken-strat");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "BTCUSDT.json"), "THIS IS NOT JSON!!!", "utf8");

    const store = createStateStore("broken-strat", "BTCUSDT", tmpDir);
    expect(() => store.get("any", 0)).not.toThrow();
    expect(store.get("any", 0)).toBe(0);
    expect(store.snapshot()).toEqual({});
  });
});

// ─────────────────────────────────────────────────────
// 8. rsi-reversal strategy state integration
// ─────────────────────────────────────────────────────

describe("rsi-reversal — state integration", () => {
  /** Create an in-memory mock StateStore (no file system dependency) */
  function makeMockStore(initial: Record<string, unknown> = {}): StateStore {
    const state: Record<string, unknown> = { ...initial };
    return {
      get<T>(key: string, defaultValue: T): T {
        return (Object.prototype.hasOwnProperty.call(state, key) ? state[key] : defaultValue) as T;
      },
      set<T>(key: string, value: T): void {
        state[key] = value as unknown;
      },
      delete(key: string): void {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete state[key];
      },
      snapshot(): Record<string, unknown> {
        return { ...state };
      },
    };
  }

  it("18. consecutive losses < 3 -> returns signal normally (RSI < 30 -> buy)", () => {
    const store = makeMockStore({ consecutiveLosses: 2 });
    const ctx = makeCtx(25, store); // RSI=25 < 30 -> buy
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("buy");
  });

  it("18b. consecutive losses < 3 -> returns signal normally (RSI > 70 -> sell)", () => {
    const store = makeMockStore({ consecutiveLosses: 1 });
    const ctx = makeCtx(75, store); // RSI=75 > 70 -> sell
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("sell");
  });

  it("19. consecutive losses >= 3 -> returns 'none'", () => {
    const store = makeMockStore({ consecutiveLosses: 3 });
    const ctx = makeCtx(25, store); // RSI oversold but blocked
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("none");
  });

  it("19b. consecutive losses = 5 -> also returns 'none'", () => {
    const store = makeMockStore({ consecutiveLosses: 5 });
    const ctx = makeCtx(75, store);
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("none");
  });

  it("20. onTradeClosed: loss -> consecutiveLosses +1", () => {
    const store = makeMockStore({ consecutiveLosses: 1 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-50), ctx);
    expect(store.get("consecutiveLosses", 0)).toBe(2);
  });

  it("20b. onTradeClosed: loss starting from 0 -> consecutiveLosses = 1", () => {
    const store = makeMockStore({});
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-10), ctx);
    expect(store.get("consecutiveLosses", 0)).toBe(1);
  });

  it("21. onTradeClosed: profit -> consecutiveLosses resets to 0", () => {
    const store = makeMockStore({ consecutiveLosses: 3 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(100), ctx);
    expect(store.get("consecutiveLosses", -1)).toBe(0);
  });

  it("21b. onTradeClosed: pnl = 0 -> not treated as loss, resets to 0", () => {
    const store = makeMockStore({ consecutiveLosses: 2 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(0), ctx);
    expect(store.get("consecutiveLosses", -1)).toBe(0);
  });

  it("22. rsi-reversal works normally when stateStore is undefined (no crash)", () => {
    const ctx = makeCtx(25); // no stateStore
    expect(() => rsiReversalStrategy.populateSignal(ctx)).not.toThrow();
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("buy");
  });

  it("22b. onTradeClosed does not crash when stateStore is undefined", () => {
    const ctx = makeCtx(50); // no stateStore
    expect(() => rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-50), ctx)).not.toThrow();
  });
});

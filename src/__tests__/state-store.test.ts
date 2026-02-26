/**
 * State Store 单元测试（P7.4）
 *
 * 使用临时目录做文件系统操作（与 log-rotate.test.ts 同模式）。
 * 测试 rsi-reversal 状态集成时使用手工 mock StateStore。
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

/** 构造满足 StrategyContext 的最小上下文（无 stateStore） */
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
// 1. createStateStore — 基础
// ─────────────────────────────────────────────────────

describe("createStateStore — 基础", () => {
  it("1. 返回有 get/set/delete/snapshot 方法的对象", () => {
    const store = makeStore();
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.snapshot).toBe("function");
  });

  it("2. get：文件不存在时返回 defaultValue", () => {
    const store = makeStore();
    expect(store.get("missing", 42)).toBe(42);
    expect(store.get("missing", "hello")).toBe("hello");
    expect(store.get("missing", false)).toBe(false);
  });

  it("3. get：文件存在时返回存储的值", () => {
    const store = makeStore();
    store.set("foo", "bar");

    // 创建新实例（重新从文件读取）
    const store2 = makeStore();
    expect(store2.get("foo", "default")).toBe("bar");
  });

  it("4. get：key 不存在时返回 defaultValue", () => {
    const store = makeStore();
    store.set("existing", 1);
    expect(store.get("nonexistent", 99)).toBe(99);
  });
});

// ─────────────────────────────────────────────────────
// 2. set — 写入行为
// ─────────────────────────────────────────────────────

describe("set — 写入行为", () => {
  it("5. set：将值写入状态并持久化到文件", () => {
    const store = makeStore("my-strategy", "ETHUSDT");
    store.set("testKey", "testValue");

    const expectedPath = path.join(tmpDir, "strategy-state", "my-strategy", "ETHUSDT.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as Record<string, unknown>;
    expect(content["testKey"]).toBe("testValue");
  });

  it("6. set：写入后立即可用 get 读取（内存一致性）", () => {
    const store = makeStore();
    store.set("counter", 10);
    expect(store.get("counter", 0)).toBe(10);
    store.set("counter", 20);
    expect(store.get("counter", 0)).toBe(20);
  });

  it("7. set：写入数字类型", () => {
    const store = makeStore();
    store.set("price", 42000.5);
    expect(store.get("price", 0)).toBe(42000.5);
  });

  it("8. set：写入对象类型", () => {
    const store = makeStore();
    const obj = { a: 1, b: "hello" };
    store.set("config", obj);
    expect(store.get("config", {})).toEqual(obj);
  });

  it("9. set：写入数组类型", () => {
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
  it("10. delete：删除存在的 key", () => {
    const store = makeStore();
    store.set("toDelete", "value");
    store.delete("toDelete");
    expect(store.get("toDelete", "default")).toBe("default");
  });

  it("11. delete：删除不存在的 key（不报错）", () => {
    const store = makeStore();
    expect(() => store.delete("nonexistent")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────
// 4. snapshot
// ─────────────────────────────────────────────────────

describe("snapshot", () => {
  it("12. snapshot：返回当前所有状态的浅拷贝", () => {
    const store = makeStore();
    store.set("a", 1);
    store.set("b", "hello");
    const snap = store.snapshot();
    expect(snap).toEqual({ a: 1, b: "hello" });
  });

  it("13. snapshot：修改返回值不影响内部状态", () => {
    const store = makeStore();
    store.set("x", 10);
    const snap = store.snapshot();
    snap["x"] = 999;
    // 内部状态不受影响
    expect(store.get("x", 0)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────
// 5. 文件路径与目录创建
// ─────────────────────────────────────────────────────

describe("文件路径与目录自动创建", () => {
  it("14. 目录不存在时自动创建", () => {
    const deepDir = path.join(tmpDir, "nested", "subdir");
    // deepDir 尚未创建
    const store = createStateStore("my-strat", "SOLUSDT", deepDir);
    store.set("key", "val");
    const expectedDir = path.join(deepDir, "strategy-state", "my-strat");
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, "SOLUSDT.json"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// 6. 隔离性
// ─────────────────────────────────────────────────────

describe("store 隔离性", () => {
  it("15. 两个不同 symbol 的 store 相互独立（不共享状态）", () => {
    const storeA = createStateStore("strategy", "BTCUSDT", tmpDir);
    const storeB = createStateStore("strategy", "ETHUSDT", tmpDir);

    storeA.set("losses", 5);
    storeB.set("losses", 2);

    expect(storeA.get("losses", 0)).toBe(5);
    expect(storeB.get("losses", 0)).toBe(2);
  });

  it("16. 两个相同 symbol 的 store 共享文件（后写覆盖前写）", () => {
    const storeA = createStateStore("strategy", "BTCUSDT", tmpDir);
    const storeB = createStateStore("strategy", "BTCUSDT", tmpDir);

    storeA.set("val", "first");
    storeB.set("val", "second");

    // storeA 重新读取文件（新建实例）
    const storeC = createStateStore("strategy", "BTCUSDT", tmpDir);
    expect(storeC.get("val", "")).toBe("second");
  });
});

// ─────────────────────────────────────────────────────
// 7. 容错
// ─────────────────────────────────────────────────────

describe("容错", () => {
  it("17. 文件损坏时（非 JSON）回退到空状态，不抛错", () => {
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
// 8. rsi-reversal 策略集成测试
// ─────────────────────────────────────────────────────

describe("rsi-reversal — 状态集成", () => {
  /** 创建内存 mock StateStore（不依赖文件系统） */
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

  it("18. 连续亏损 < 3 次 → 正常返回信号（RSI < 30 → buy）", () => {
    const store = makeMockStore({ consecutiveLosses: 2 });
    const ctx = makeCtx(25, store); // RSI=25 < 30 → buy
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("buy");
  });

  it("18b. 连续亏损 < 3 次 → 正常返回信号（RSI > 70 → sell）", () => {
    const store = makeMockStore({ consecutiveLosses: 1 });
    const ctx = makeCtx(75, store); // RSI=75 > 70 → sell
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("sell");
  });

  it("19. 连续亏损 >= 3 次 → 返回 'none'", () => {
    const store = makeMockStore({ consecutiveLosses: 3 });
    const ctx = makeCtx(25, store); // RSI 超卖但被阻止
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("none");
  });

  it("19b. 连续亏损 = 5 → 也返回 'none'", () => {
    const store = makeMockStore({ consecutiveLosses: 5 });
    const ctx = makeCtx(75, store);
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("none");
  });

  it("20. onTradeClosed：亏损 → consecutiveLosses +1", () => {
    const store = makeMockStore({ consecutiveLosses: 1 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-50), ctx);
    expect(store.get("consecutiveLosses", 0)).toBe(2);
  });

  it("20b. onTradeClosed：从 0 开始亏损 → consecutiveLosses = 1", () => {
    const store = makeMockStore({});
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-10), ctx);
    expect(store.get("consecutiveLosses", 0)).toBe(1);
  });

  it("21. onTradeClosed：盈利 → consecutiveLosses 重置为 0", () => {
    const store = makeMockStore({ consecutiveLosses: 3 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(100), ctx);
    expect(store.get("consecutiveLosses", -1)).toBe(0);
  });

  it("21b. onTradeClosed：pnl = 0 → 不视为亏损，重置为 0", () => {
    const store = makeMockStore({ consecutiveLosses: 2 });
    const ctx = makeCtx(50, store);
    rsiReversalStrategy.onTradeClosed?.(makeTradeResult(0), ctx);
    expect(store.get("consecutiveLosses", -1)).toBe(0);
  });

  it("22. stateStore 为 undefined 时 rsi-reversal 正常工作（不崩溃）", () => {
    const ctx = makeCtx(25); // 无 stateStore
    expect(() => rsiReversalStrategy.populateSignal(ctx)).not.toThrow();
    expect(rsiReversalStrategy.populateSignal(ctx)).toBe("buy");
  });

  it("22b. stateStore 为 undefined 时 onTradeClosed 不崩溃", () => {
    const ctx = makeCtx(50); // 无 stateStore
    expect(() => rsiReversalStrategy.onTradeClosed?.(makeTradeResult(-50), ctx)).not.toThrow();
  });
});

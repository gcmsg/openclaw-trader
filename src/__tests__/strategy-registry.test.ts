/**
 * Strategy Registry Tests（F4）
 * 测试 registerStrategy / getStrategy / listStrategies 的完整行为
 */
import { describe, it, expect } from "vitest";

// 使用隔离的测试注册表（避免污染全局 registry）
// 直接测试 registry 模块的导出行为

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
// 注册 / 获取 / 列出
// ─────────────────────────────────────────────────────

describe("Strategy Registry", () => {
  // 注意：registry 是全局单例，内置策略（default, rsi-reversal, breakout）
  // 在 index.ts import 时会注册，但这里只测试 registry 的核心行为

  it("registerStrategy + getStrategy 基本流程", () => {
    const s = makeStrategy("test-basic");
    registerStrategy(s);
    const retrieved = getStrategy("test-basic");
    expect(retrieved.id).toBe("test-basic");
    expect(retrieved.name).toBe("Strategy test-basic");
  });

  it("重复注册同 id 会覆盖（后者生效）", () => {
    const s1 = { ...makeStrategy("test-override"), name: "First" };
    const s2 = { ...makeStrategy("test-override"), name: "Second" };
    registerStrategy(s1);
    registerStrategy(s2);
    expect(getStrategy("test-override").name).toBe("Second");
  });

  it("listStrategies 返回所有已注册 id", () => {
    registerStrategy(makeStrategy("test-list-a"));
    registerStrategy(makeStrategy("test-list-b"));
    const ids = listStrategies();
    expect(ids).toContain("test-list-a");
    expect(ids).toContain("test-list-b");
  });

  it("listStrategyDetails 包含 id / name / description", () => {
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

  it("listStrategyDetails - 无 description 字段时不包含 key", () => {
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

  // ─── 未知策略报错 ───────────────────────────────────

  it("getStrategy 获取不存在的 id 应抛出错误", () => {
    expect(() => getStrategy("nonexistent-strategy-xyz")).toThrow(
      `Strategy "nonexistent-strategy-xyz" not found`
    );
  });

  it("错误信息中包含已注册的策略列表", () => {
    registerStrategy(makeStrategy("test-registered-one"));
    try {
      getStrategy("not-there");
    } catch (e) {
      expect((e as Error).message).toContain("test-registered-one");
    }
  });

  // ─── 内置策略已注册（通过 index.ts 副作用） ────────

  it("内置策略 default 已注册", async () => {
    // 触发注册
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("default");
  });

  it("内置策略 rsi-reversal 已注册", async () => {
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("rsi-reversal");
  });

  it("内置策略 breakout 已注册", async () => {
    await import("../strategies/index.js");
    const ids = listStrategies();
    expect(ids).toContain("breakout");
  });
});

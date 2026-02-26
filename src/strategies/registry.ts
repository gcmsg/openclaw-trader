/**
 * 策略注册中心（F4）
 *
 * 维护 id → Strategy 的映射表，供 signal-engine 和脚本查询。
 */

import type { Strategy } from "./types.js";

const _registry = new Map<string, Strategy>();

/**
 * 注册一个策略插件。重复注册同 id 会覆盖（便于测试）。
 */
export function registerStrategy(s: Strategy): void {
  _registry.set(s.id, s);
}

/**
 * 根据 id 获取策略，不存在则抛出错误。
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
 * 列出所有已注册的策略 id。
 */
export function listStrategies(): string[] {
  return [..._registry.keys()];
}

/**
 * 列出所有已注册的策略详情（含 name/description）。
 */
export function listStrategyDetails(): Array<{
  id: string;
  name: string;
  description?: string;
}> {
  return [..._registry.values()].map((s) => ({
    id: s.id,
    name: s.name,
    ...(s.description !== undefined ? { description: s.description } : {}),
  }));
}

/**
 * Strategy Plugin State Store（P7.4）
 *
 * 给每个 Strategy 插件提供跨 K 线的状态持久化接口。
 * 文件路径：logs/strategy-state/{strategyId}/{symbol}.json
 */

import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────
// Public Interface
// ─────────────────────────────────────────────────────

export interface StateStore {
  /**
   * 读取状态值（类型安全）
   * @param key           状态键名
   * @param defaultValue  若不存在，返回此默认值
   */
  get<T>(key: string, defaultValue: T): T;

  /**
   * 写入状态值（立即持久化到磁盘）
   */
  set(key: string, value: unknown): void;

  /**
   * 删除状态键
   */
  delete(key: string): void;

  /**
   * 获取所有状态（只读快照）
   */
  snapshot(): Record<string, unknown>;
}

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────

/**
 * 加载已有状态（内部使用）
 * 若文件不存在或内容损坏，返回空对象（不抛错）
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
    // 文件不存在 (ENOENT) 或 JSON 损坏 → 回退到空状态
    return {};
  }
}

/**
 * 保存状态（内部使用，同步写文件）
 * 若目录不存在，自动创建
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
 * 创建绑定到特定策略+symbol 的状态存储实例
 * 文件路径：{logsDir}/strategy-state/{strategyId}/{symbol}.json
 *
 * @param strategyId  策略 ID（如 "rsi-reversal"）
 * @param symbol      交易对（如 "BTCUSDT"）
 * @param logsDir     日志目录（默认 "logs"，可注入用于测试）
 */
export function createStateStore(
  strategyId: string,
  symbol: string,
  logsDir = "logs"
): StateStore {
  const filePath = path.join(logsDir, "strategy-state", strategyId, `${symbol}.json`);

  // 内存缓存，懒加载
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

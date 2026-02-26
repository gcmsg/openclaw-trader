/**
 * P6.7 — Kill Switch 全市场熔断 测试
 *
 * 测试场景：
 * - checkBtcCrash 触发 / 不触发
 * - activateKillSwitch / deactivateKillSwitch 状态读写
 * - autoResume 逻辑
 * - isKillSwitchActive 过期自动恢复
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 使用临时目录存放测试状态文件，避免污染真实 logs/
const TEST_STATE_DIR = path.resolve(__dirname, "../../logs/test-kill-switch-tmp");

// ── 在导入模块之前，Mock 状态文件路径 ──────────────────
// 通过直接在模块内部读写 STATE_FILE 来测试，需要临时重定向

import {
  readKillSwitch,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
  checkBtcCrash,
  type KillSwitchState,
} from "../health/kill-switch.js";

// ─────────────────────────────────────────────────────
// 测试设置（每次测试前清理状态）
// ─────────────────────────────────────────────────────

beforeEach(() => {
  // 确保状态清空（deactivate 即重置）
  deactivateKillSwitch();
});

afterEach(() => {
  // 测试后清理
  deactivateKillSwitch();
});

// ─────────────────────────────────────────────────────
// checkBtcCrash 测试
// ─────────────────────────────────────────────────────

describe("checkBtcCrash — BTC 崩盘检测", () => {
  it("跌幅 >= 阈值时触发崩盘", () => {
    // 价格从 100k 跌到 91k = 9% 跌幅，阈值 8%
    const prices = Array.from({ length: 60 }, (_, i) =>
      100_000 - i * (9_000 / 59) // 均匀从 100k 跌到 91k
    );
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(true);
    expect(result.dropPct).toBeGreaterThanOrEqual(8);
  });

  it("跌幅 < 阈值时不触发崩盘", () => {
    // 价格从 100k 跌到 96k = 4% 跌幅，阈值 8%
    const prices = Array.from({ length: 60 }, (_, i) =>
      100_000 - i * (4_000 / 59)
    );
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBeLessThan(8);
  });

  it("价格上涨时不触发崩盘（dropPct 可能为负）", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100_000 + i * 100);
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBeLessThan(0); // 实际是涨幅，dropPct 为负
  });

  it("恰好等于阈值时触发", () => {
    // 跌幅恰好 8%：100 → 92
    const prices = [100, 92];
    const result = checkBtcCrash(prices, 8);
    expect(result.crash).toBe(true);
    expect(result.dropPct).toBeCloseTo(8, 5);
  });

  it("价格点数不足（<2）时返回 false", () => {
    expect(checkBtcCrash([], 8)).toEqual({ crash: false, dropPct: 0 });
    expect(checkBtcCrash([100_000], 8)).toEqual({ crash: false, dropPct: 0 });
  });

  it("起始价格为 0 时安全返回 false（防止除零）", () => {
    const result = checkBtcCrash([0, 100], 8);
    expect(result.crash).toBe(false);
    expect(result.dropPct).toBe(0);
  });

  it("使用默认阈值 8%", () => {
    // 跌幅 9%，不传阈值
    const prices = [100_000, 91_000];
    const result = checkBtcCrash(prices); // 默认 8%
    expect(result.crash).toBe(true);
  });

  it("dropPct 计算精确", () => {
    // 从 200 跌到 180 = 10% 跌幅
    const result = checkBtcCrash([200, 180], 8);
    expect(result.dropPct).toBeCloseTo(10, 5);
    expect(result.crash).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// activateKillSwitch / deactivateKillSwitch 测试
// ─────────────────────────────────────────────────────

describe("activateKillSwitch / deactivateKillSwitch — 状态读写", () => {
  it("激活后 isKillSwitchActive() 返回 true", () => {
    activateKillSwitch("测试激活");
    expect(isKillSwitchActive()).toBe(true);
  });

  it("解除后 isKillSwitchActive() 返回 false", () => {
    activateKillSwitch("测试激活");
    deactivateKillSwitch();
    expect(isKillSwitchActive()).toBe(false);
  });

  it("readKillSwitch() 返回正确的状态字段", () => {
    const reason = "BTC 暴跌 10%";
    activateKillSwitch(reason);
    const state = readKillSwitch();
    expect(state.active).toBe(true);
    expect(state.reason).toBe(reason);
    expect(state.triggeredAt).toBeGreaterThan(0);
    expect(state.triggeredAt).toBeLessThanOrEqual(Date.now());
  });

  it("deactivateKillSwitch() 后 readKillSwitch() 返回未激活状态", () => {
    activateKillSwitch("测试");
    deactivateKillSwitch();
    const state = readKillSwitch();
    expect(state.active).toBe(false);
    expect(state.reason).toBe("");
    expect(state.triggeredAt).toBe(0);
  });

  it("初次读取（无文件）时返回默认未激活状态", () => {
    // deactivateKillSwitch() 已在 beforeEach 调用
    const state = readKillSwitch();
    expect(state.active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// autoResume 逻辑测试
// ─────────────────────────────────────────────────────

describe("autoResume — 自动恢复逻辑", () => {
  it("激活时设置 autoResumeAt 字段", () => {
    const autoResumeMs = 3_600_000; // 1小时
    activateKillSwitch("测试自动恢复", autoResumeMs);
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeDefined();
    expect(state.autoResumeAt).toBeGreaterThan(Date.now());
  });

  it("不传 autoResumeMs 时 autoResumeAt 为 undefined（手动恢复）", () => {
    activateKillSwitch("手动恢复测试");
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeUndefined();
  });

  it("autoResumeMs=0 时不设置 autoResumeAt", () => {
    activateKillSwitch("零时间测试", 0);
    const state = readKillSwitch();
    expect(state.autoResumeAt).toBeUndefined();
  });

  it("isKillSwitchActive() 在 autoResumeAt 已过期时自动解除并返回 false", () => {
    // 用已过期的 autoResumeAt 直接写入状态文件模拟
    const expiredState: KillSwitchState = {
      active: true,
      reason: "已过期测试",
      triggeredAt: Date.now() - 7_200_000, // 2小时前激活
      autoResumeAt: Date.now() - 1000,     // 1秒前已到期
    };

    // 直接写入状态文件（通过 activateKillSwitch 无法设置过去的 autoResumeAt）
    // 我们用 deactivate + 手动写来模拟
    const stateFilePath = path.resolve(__dirname, "../../logs/kill-switch-state.json");
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(expiredState, null, 2));

    // 应自动解除
    const isActive = isKillSwitchActive();
    expect(isActive).toBe(false);

    // 状态文件应已被重置
    const stateAfter = readKillSwitch();
    expect(stateAfter.active).toBe(false);
  });

  it("isKillSwitchActive() 在 autoResumeAt 未到期时仍返回 true", () => {
    activateKillSwitch("未到期测试", 3_600_000); // 1小时后自动恢复
    expect(isKillSwitchActive()).toBe(true);
  });
});

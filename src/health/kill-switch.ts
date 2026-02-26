/**
 * Kill Switch — 全市场熔断模块 (P6.7)
 *
 * 功能：
 * 1. 全局开关 — 激活后禁止所有新仓入场
 * 2. BTC 短期崩盘检测 — 近 60 个价格点跌幅超阈值自动激活
 * 3. 状态持久化 — 写入 logs/kill-switch-state.json
 * 4. 自动恢复 — 可设定 N ms 后自动解除
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../../logs/kill-switch-state.json");

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface KillSwitchState {
  active: boolean;
  reason: string;
  triggeredAt: number;
  autoResumeAt?: number; // 可选：到达此时间戳后自动解除（毫秒 epoch）
}

const DEFAULT_STATE: KillSwitchState = {
  active: false,
  reason: "",
  triggeredAt: 0,
};

// ─────────────────────────────────────────────────────
// 状态读写
// ─────────────────────────────────────────────────────

export function readKillSwitch(): KillSwitchState {
  try {
    const data = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(data) as KillSwitchState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeKillSwitch(state: KillSwitchState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────
// 激活 / 解除
// ─────────────────────────────────────────────────────

/**
 * 激活 Kill Switch
 * @param reason       触发原因（用于日志和通知）
 * @param autoResumeMs 可选：N 毫秒后自动解除；0 或未传则手动恢复
 */
export function activateKillSwitch(reason: string, autoResumeMs?: number): void {
  const now = Date.now();
  const state: KillSwitchState = {
    active: true,
    reason,
    triggeredAt: now,
    ...(autoResumeMs !== undefined && autoResumeMs > 0
      ? { autoResumeAt: now + autoResumeMs }
      : {}),
  };
  writeKillSwitch(state);
}

/** 手动解除 Kill Switch */
export function deactivateKillSwitch(): void {
  writeKillSwitch({ ...DEFAULT_STATE });
}

// ─────────────────────────────────────────────────────
// 状态查询（含自动到期检查）
// ─────────────────────────────────────────────────────

/**
 * 检查 Kill Switch 是否处于激活状态
 * 若 autoResumeAt 已到期则自动解除并返回 false
 */
export function isKillSwitchActive(): boolean {
  const state = readKillSwitch();
  if (!state.active) return false;

  // 自动恢复检查
  if (state.autoResumeAt !== undefined && Date.now() >= state.autoResumeAt) {
    deactivateKillSwitch();
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────
// BTC 崩盘检测
// ─────────────────────────────────────────────────────

/**
 * 检测 BTC 短期跌幅是否超阈值
 *
 * @param recentBtcPrices  最近 N 个价格点（按时间顺序，index 0 = 最旧）
 * @param thresholdPct     跌幅阈值百分比，默认 8（即 8%）
 * @returns crash: 是否触发；dropPct: 实际跌幅百分比（正值 = 下跌）
 */
export function checkBtcCrash(
  recentBtcPrices: number[],
  thresholdPct = 8
): { crash: boolean; dropPct: number } {
  if (recentBtcPrices.length < 2) return { crash: false, dropPct: 0 };

  const first = recentBtcPrices[0];
  const last = recentBtcPrices[recentBtcPrices.length - 1];

  if (first === undefined || last === undefined || first <= 0) {
    return { crash: false, dropPct: 0 };
  }

  // 跌幅 = (起始价 - 当前价) / 起始价 × 100；正值表示下跌
  const dropPct = ((first - last) / first) * 100;
  return { crash: dropPct >= thresholdPct, dropPct };
}

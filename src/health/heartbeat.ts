/**
 * 任务心跳记录
 * 每个定时任务在执行时调用 ping()，记录最后执行时间
 * 健康检查模块通过读取这些记录判断任务是否正常运行
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_PATH = path.resolve(__dirname, "../../logs/heartbeat.json");

export type TaskStatus = "ok" | "warn" | "error" | "never";

export interface TaskHeartbeat {
  lastRunAt: number; // 最后执行时间戳
  lastDurationMs: number; // 最后一次执行耗时
  lastStatus: "ok" | "error";
  lastError?: string;
  runCount: number; // 累计执行次数
  errorCount: number; // 累计失败次数
}

export type HeartbeatStore = Record<string, TaskHeartbeat>;

export function loadHeartbeats(): HeartbeatStore {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf-8")) as HeartbeatStore;
  } catch (_e: unknown) {
    return {};
  }
}

function saveHeartbeats(store: HeartbeatStore): void {
  fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
  fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(store, null, 2));
}

/** 任务开始时调用，返回结束时需要调用的 done 函数 */
export function ping(taskName: string): (error?: string) => void {
  const startMs = Date.now();

  return (error?: string) => {
    const durationMs = Date.now() - startMs;
    // 重新读取最新状态，避免并发写入时用到过期计数
    const store = loadHeartbeats();
    const prev = store[taskName] ?? {
      lastRunAt: 0,
      lastDurationMs: 0,
      lastStatus: "ok" as const,
      runCount: 0,
      errorCount: 0,
    };
    store[taskName] = {
      lastRunAt: startMs,
      lastDurationMs: durationMs,
      lastStatus: error ? "error" : "ok",
      // exactOptionalPropertyTypes: 只在有值时才设置 lastError
      ...(error !== undefined ? { lastError: error } : {}),
      runCount: prev.runCount + 1,
      errorCount: prev.errorCount + (error ? 1 : 0),
    };
    saveHeartbeats(store);
  };
}

/** 获取单个任务的状态描述 */
export function getTaskHealth(
  taskName: string,
  timeoutMinutes: number
): { status: TaskStatus; lastRunAt: number; minutesSince: number; message: string } {
  const store = loadHeartbeats();
  const hb = store[taskName];

  if (!hb || hb.lastRunAt === 0) {
    return { status: "never", lastRunAt: 0, minutesSince: Infinity, message: "从未执行" };
  }

  const minutesSince = (Date.now() - hb.lastRunAt) / 60000;

  if (hb.lastStatus === "error") {
    return {
      status: "error",
      lastRunAt: hb.lastRunAt,
      minutesSince,
      message: `上次执行出错: ${hb.lastError ?? "unknown"}`,
    };
  }

  if (minutesSince > timeoutMinutes) {
    return {
      status: "warn",
      lastRunAt: hb.lastRunAt,
      minutesSince,
      message: `超过 ${timeoutMinutes} 分钟未执行（已 ${minutesSince.toFixed(0)} 分钟）`,
    };
  }

  return {
    status: "ok",
    lastRunAt: hb.lastRunAt,
    minutesSince,
    message: `正常（${minutesSince.toFixed(0)} 分钟前执行，耗时 ${hb.lastDurationMs}ms）`,
  };
}

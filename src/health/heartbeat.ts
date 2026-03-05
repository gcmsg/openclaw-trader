/**
 * Task Heartbeat Recorder
 * Each scheduled task calls ping() on execution to record the last run time.
 * The health check module reads these records to determine if tasks are running normally.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_PATH = path.resolve(__dirname, "../../logs/heartbeat.json");

export type TaskStatus = "ok" | "warn" | "error" | "never";

export interface TaskHeartbeat {
  lastRunAt: number; // Last execution timestamp
  lastDurationMs: number; // Last execution duration
  lastStatus: "ok" | "error";
  lastError?: string;
  runCount: number; // Cumulative execution count
  errorCount: number; // Cumulative failure count
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

/** Call at task start, returns a done function to call when finished */
export function ping(taskName: string): (error?: string) => void {
  const startMs = Date.now();

  return (error?: string) => {
    const durationMs = Date.now() - startMs;
    // Re-read latest state to avoid stale counts during concurrent writes
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
      // exactOptionalPropertyTypes: only set lastError when there's a value
      ...(error !== undefined ? { lastError: error } : {}),
      runCount: prev.runCount + 1,
      errorCount: prev.errorCount + (error ? 1 : 0),
    };
    saveHeartbeats(store);
  };
}

/** Get status description for a single task */
export function getTaskHealth(
  taskName: string,
  timeoutMinutes: number
): { status: TaskStatus; lastRunAt: number; minutesSince: number; message: string } {
  const store = loadHeartbeats();
  const hb = store[taskName];

  if (!hb || hb.lastRunAt === 0) {
    return { status: "never", lastRunAt: 0, minutesSince: Infinity, message: "Never executed" };
  }

  const minutesSince = (Date.now() - hb.lastRunAt) / 60000;

  if (hb.lastStatus === "error") {
    return {
      status: "error",
      lastRunAt: hb.lastRunAt,
      minutesSince,
      message: `Last execution failed: ${hb.lastError ?? "unknown"}`,
    };
  }

  if (minutesSince > timeoutMinutes) {
    return {
      status: "warn",
      lastRunAt: hb.lastRunAt,
      minutesSince,
      message: `Not executed for over ${timeoutMinutes} minutes (${minutesSince.toFixed(0)} minutes ago)`,
    };
  }

  return {
    status: "ok",
    lastRunAt: hb.lastRunAt,
    minutesSince,
    message: `Normal (executed ${minutesSince.toFixed(0)} minutes ago, took ${hb.lastDurationMs}ms)`,
  };
}

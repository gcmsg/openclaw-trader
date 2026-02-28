/**
 * 集中日志模块
 *
 * 替代各文件重复的 inline log() 函数，统一格式、级别和文件写入。
 *
 * @example
 * // 带文件写入
 * const log = createLogger("monitor", "logs/monitor.log");
 * log.info("扫描开始");
 * log.warn("资金费率获取失败");
 * log.error("Fatal error");
 * log.debug("详细调试信息"); // 仅 LOG_LEVEL=debug 时输出
 *
 * // 仅 console（无文件写入）
 * const log = createLogger("live-monitor");
 * log.info("启动");
 */

import fs from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): number {
  const env = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return LEVEL_PRIORITY[env as LogLevel] ?? LEVEL_PRIORITY.info;
}

export function createLogger(module: string, logFilePath?: string): Logger {
  const minLevel = getMinLevel();

  function write(level: LogLevel, msg: string): void {
    if (LEVEL_PRIORITY[level] < minLevel) return;

    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${module}] ${msg}`;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (logFilePath) {
      fs.appendFileSync(logFilePath, line + "\n");
    }
  }

  return {
    debug: (msg: string) => { write("debug", msg); },
    info: (msg: string) => { write("info", msg); },
    warn: (msg: string) => { write("warn", msg); },
    error: (msg: string) => { write("error", msg); },
  };
}

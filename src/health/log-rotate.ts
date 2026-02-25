/**
 * 日志轮转（Log Rotation）
 *
 * ## 功能
 * 1. 日志文件轮转
 *    - 目标文件：logs/*.log
 *    - 触发条件：文件大小 > maxSizeMb 或 上次轮转距今 > rotateAfterHours
 *    - 轮转方式：重命名为 logs/archive/{name}.YYYY-MM-DD.log
 *    - 保留期限：归档文件保留 30 天，超期自动删除
 *
 * 2. Paper 账户备份清理
 *    - 目标：logs/paper-*-backup-*.json（engine.ts 定期备份）
 *    - 保留：最近 7 天，超期删除
 *
 * ## 使用
 *   npm run log:rotate           # 手动触发
 *   cron: "0 0 * * *"           # 每天凌晨 0 点自动运行
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ping } from "./heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const ARCHIVE_DIR = path.join(LOGS_DIR, "archive");

// ─── 配置 ──────────────────────────────────────────────

const LOG_FILES_TO_ROTATE = [
  "monitor.log",
  "price_monitor.log",
  "news_collector.log",
  "news-monitor.log",
  "weekly-report.log",
  "health.log",
  "health_check.log",
];

const MAX_SIZE_MB = 20;                 // 超过 20MB 强制轮转
const ROTATE_AFTER_HOURS = 24;         // 每 24 小时轮转一次
const ARCHIVE_KEEP_DAYS = 30;          // 归档保留 30 天
const BACKUP_KEEP_DAYS = 7;            // paper 备份保留 7 天

// ─── 辅助函数 ─────────────────────────────────────────

function getDateStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function fileSizeMb(filePath: string): number {
  try {
    return fs.statSync(filePath).size / (1024 * 1024);
  } catch {
    return 0;
  }
}

function fileAgeHours(filePath: string): number {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    return (Date.now() - mtimeMs) / 3_600_000;
  } catch {
    return 0;
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [log-rotate] ${msg}`;
  console.log(line);
}

// ─── 日志轮转 ─────────────────────────────────────────

export interface RotateResult {
  rotated: string[];
  deleted: string[];
  skipped: string[];
  backupsDeleted: number;
  errors: string[];
}

export function rotateLogs(): RotateResult {
  const result: RotateResult = { rotated: [], deleted: [], skipped: [], backupsDeleted: 0, errors: [] };

  // 创建归档目录
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const dateStr = getDateStr();

  // 1. 轮转 log 文件
  for (const logFile of LOG_FILES_TO_ROTATE) {
    const srcPath = path.join(LOGS_DIR, logFile);

    if (!fs.existsSync(srcPath)) {
      result.skipped.push(`${logFile} (不存在)`);
      continue;
    }

    const sizeMb = fileSizeMb(srcPath);
    const ageHours = fileAgeHours(srcPath);

    const shouldRotate = sizeMb > MAX_SIZE_MB || ageHours > ROTATE_AFTER_HOURS;

    if (!shouldRotate) {
      result.skipped.push(`${logFile} (${sizeMb.toFixed(1)}MB, ${ageHours.toFixed(0)}h)`);
      continue;
    }

    // 归档：重命名为 archive/{name}.{date}.log
    const baseName = path.basename(logFile, ".log");
    let archiveName = `${baseName}.${dateStr}.log`;
    let archivePath = path.join(ARCHIVE_DIR, archiveName);

    // 避免同日重复归档（加计数后缀）
    let counter = 1;
    while (fs.existsSync(archivePath)) {
      archiveName = `${baseName}.${dateStr}.${counter}.log`;
      archivePath = path.join(ARCHIVE_DIR, archiveName);
      counter++;
    }

    try {
      fs.renameSync(srcPath, archivePath);
      log(`✅ 轮转: ${logFile} → archive/${archiveName} (${sizeMb.toFixed(1)}MB)`);
      result.rotated.push(logFile);
    } catch (err: unknown) {
      const msg = `${logFile}: ${String(err)}`;
      log(`❌ 轮转失败: ${msg}`);
      result.errors.push(msg);
    }
  }

  // 2. 删除过期归档（> ARCHIVE_KEEP_DAYS 天）
  const archiveFiles = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR) : [];
  const archiveCutoffMs = Date.now() - ARCHIVE_KEEP_DAYS * 86_400_000;

  for (const file of archiveFiles) {
    const filePath = path.join(ARCHIVE_DIR, file);
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs < archiveCutoffMs) {
        fs.unlinkSync(filePath);
        log(`🗑️  删除过期归档: ${file}`);
        result.deleted.push(file);
      }
    } catch { /* 忽略删除失败 */ }
  }

  // 3. 清理过期 paper 备份文件（paper-*-backup-*.json）
  const backupCutoffMs = Date.now() - BACKUP_KEEP_DAYS * 86_400_000;
  const logsFiles = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR) : [];

  for (const file of logsFiles) {
    if (!/^paper-.*backup.*\.json$/.test(file)) continue;
    const filePath = path.join(LOGS_DIR, file);
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs < backupCutoffMs) {
        fs.unlinkSync(filePath);
        log(`🗑️  删除过期备份: ${file}`);
        result.backupsDeleted++;
      }
    } catch { /* 忽略 */ }
  }

  return result;
}

// ─── CLI 入口 ─────────────────────────────────────────

if (process.argv[1]?.includes("log-rotate")) {
  const done = ping("log_rotate");
  log("── 日志轮转开始 ──");
  try {
    const result = rotateLogs();
    log(`✅ 轮转: ${result.rotated.length} 个文件`);
    log(`🗑️  删除: ${result.deleted.length} 个归档, ${result.backupsDeleted} 个备份`);
    log(`⏩ 跳过: ${result.skipped.length} 个文件`);
    if (result.errors.length > 0) log(`❌ 失败: ${result.errors.join(", ")}`);
    done();
  } catch (err: unknown) {
    const msg = String(err);
    log(`❌ Fatal: ${msg}`);
    done(msg);
    process.exit(1);
  }
  log("── 日志轮转完成 ──");
}

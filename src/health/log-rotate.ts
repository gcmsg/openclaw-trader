/**
 * Log Rotation
 *
 * ## Features
 * 1. Log file rotation
 *    - Target files: logs/*.log
 *    - Trigger conditions: file size > maxSizeMb or time since last rotation > rotateAfterHours
 *    - Rotation method: rename to logs/archive/{name}.YYYY-MM-DD.log
 *    - Retention: archived files kept for 30 days, auto-deleted after expiry
 *
 * 2. Paper account backup cleanup
 *    - Target: logs/paper-*-backup-*.json (periodic backups from engine.ts)
 *    - Retention: last 7 days, deleted after expiry
 *
 * ## Usage
 *   npm run log:rotate           # Manual trigger
 *   cron: "0 0 * * *"           # Auto-run daily at midnight
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ping } from "./heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const ARCHIVE_DIR = path.join(LOGS_DIR, "archive");

// ─── Configuration ──────────────────────────────────────────────

const LOG_FILES_TO_ROTATE = [
  "monitor.log",
  "price_monitor.log",
  "news_collector.log",
  "news-monitor.log",
  "weekly-report.log",
  "health.log",
  "health_check.log",
];

const MAX_SIZE_MB = 20;                 // Force rotate if over 20MB
const ROTATE_AFTER_HOURS = 24;         // Rotate every 24 hours
const ARCHIVE_KEEP_DAYS = 30;          // Keep archives for 30 days
const BACKUP_KEEP_DAYS = 7;            // Keep paper backups for 7 days

// ─── Helper Functions ─────────────────────────────────────────

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

// ─── Log Rotation ─────────────────────────────────────────

export interface RotateResult {
  rotated: string[];
  deleted: string[];
  skipped: string[];
  backupsDeleted: number;
  errors: string[];
}

export function rotateLogs(): RotateResult {
  const result: RotateResult = { rotated: [], deleted: [], skipped: [], backupsDeleted: 0, errors: [] };

  // Create archive directory
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const dateStr = getDateStr();

  // 1. Rotate log files
  for (const logFile of LOG_FILES_TO_ROTATE) {
    const srcPath = path.join(LOGS_DIR, logFile);

    if (!fs.existsSync(srcPath)) {
      result.skipped.push(`${logFile} (not found)`);
      continue;
    }

    const sizeMb = fileSizeMb(srcPath);
    const ageHours = fileAgeHours(srcPath);

    const shouldRotate = sizeMb > MAX_SIZE_MB || ageHours > ROTATE_AFTER_HOURS;

    if (!shouldRotate) {
      result.skipped.push(`${logFile} (${sizeMb.toFixed(1)}MB, ${ageHours.toFixed(0)}h)`);
      continue;
    }

    // Archive: rename to archive/{name}.{date}.log
    const baseName = path.basename(logFile, ".log");
    let archiveName = `${baseName}.${dateStr}.log`;
    let archivePath = path.join(ARCHIVE_DIR, archiveName);

    // Avoid same-day duplicate archives (add counter suffix)
    let counter = 1;
    while (fs.existsSync(archivePath)) {
      archiveName = `${baseName}.${dateStr}.${counter}.log`;
      archivePath = path.join(ARCHIVE_DIR, archiveName);
      counter++;
    }

    try {
      fs.renameSync(srcPath, archivePath);
      log(`✅ Rotated: ${logFile} -> archive/${archiveName} (${sizeMb.toFixed(1)}MB)`);
      result.rotated.push(logFile);
    } catch (err: unknown) {
      const msg = `${logFile}: ${String(err)}`;
      log(`❌ Rotation failed: ${msg}`);
      result.errors.push(msg);
    }
  }

  // 2. Delete expired archives (> ARCHIVE_KEEP_DAYS days)
  const archiveFiles = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR) : [];
  const archiveCutoffMs = Date.now() - ARCHIVE_KEEP_DAYS * 86_400_000;

  for (const file of archiveFiles) {
    const filePath = path.join(ARCHIVE_DIR, file);
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs < archiveCutoffMs) {
        fs.unlinkSync(filePath);
        log(`🗑️  Deleted expired archive: ${file}`);
        result.deleted.push(file);
      }
    } catch { /* Ignore delete failures */ }
  }

  // 3. Clean up expired paper backup files (paper-*-backup-*.json)
  const backupCutoffMs = Date.now() - BACKUP_KEEP_DAYS * 86_400_000;
  const logsFiles = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR) : [];

  for (const file of logsFiles) {
    if (!/^paper-.*backup.*\.json$/.test(file)) continue;
    const filePath = path.join(LOGS_DIR, file);
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      if (mtimeMs < backupCutoffMs) {
        fs.unlinkSync(filePath);
        log(`🗑️  Deleted expired backup: ${file}`);
        result.backupsDeleted++;
      }
    } catch { /* Ignore */ }
  }

  return result;
}

// ─── CLI Entry ─────────────────────────────────────────

if (process.argv[1]?.includes("log-rotate")) {
  const done = ping("log_rotate");
  log("── Log rotation started ──");
  try {
    const result = rotateLogs();
    log(`✅ Rotated: ${result.rotated.length} files`);
    log(`🗑️  Deleted: ${result.deleted.length} archives, ${result.backupsDeleted} backups`);
    log(`⏩ Skipped: ${result.skipped.length} files`);
    if (result.errors.length > 0) log(`❌ Failed: ${result.errors.join(", ")}`);
    done();
  } catch (err: unknown) {
    const msg = String(err);
    log(`❌ Fatal: ${msg}`);
    done(msg);
    process.exit(1);
  }
  log("── Log rotation completed ──");
}

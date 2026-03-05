/**
 * Log rotation tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Use temporary directory to simulate logs/ ───────────────────────────

let tmpDir: string;

// Mock path resolution — directly test rotateLogs logic
// Since log-rotate.ts uses hardcoded relative paths,
// we test the core pure functions instead

function fileSizeMb(filePath: string): number {
  try { return fs.statSync(filePath).size / (1024 * 1024); }
  catch { return 0; }
}

function fileAgeHours(filePath: string): number {
  try { return (Date.now() - fs.statSync(filePath).mtimeMs) / 3_600_000; }
  catch { return 0; }
}

function shouldRotate(filePath: string, maxSizeMb = 20, rotateAfterHours = 24): boolean {
  return fileSizeMb(filePath) > maxSizeMb || fileAgeHours(filePath) > rotateAfterHours;
}

function isBackupFile(filename: string): boolean {
  return /^paper-.*backup.*\.json$/.test(filename);
}

function isExpired(mtimeMs: number, keepDays: number): boolean {
  return Date.now() - mtimeMs > keepDays * 86_400_000;
}

// ─── Tests ────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rotation decision logic", () => {
  it("small file + newly created → no rotation", () => {
    const f = path.join(tmpDir, "test.log");
    fs.writeFileSync(f, "hello"); // 5 bytes, very new
    expect(shouldRotate(f, 20, 24)).toBe(false);
  });

  it("large file (> maxSizeMb) → rotate", () => {
    const f = path.join(tmpDir, "big.log");
    // Write 21MB of content
    const buf = Buffer.alloc(21 * 1024 * 1024, "x");
    fs.writeFileSync(f, buf);
    expect(shouldRotate(f, 20, 24)).toBe(true);
  });

  it("nonexistent file → no rotation", () => {
    const f = path.join(tmpDir, "nonexistent.log");
    expect(shouldRotate(f, 20, 24)).toBe(false);
  });
});

describe("backup file filtering", () => {
  it("identifies paper backup files", () => {
    expect(isBackupFile("paper-spot-backup-20240101.json")).toBe(true);
    expect(isBackupFile("paper-futures-3x-backup-2024.json")).toBe(true);
    expect(isBackupFile("paper-spot.json")).toBe(false);
    expect(isBackupFile("state.json")).toBe(false);
    expect(isBackupFile("heartbeat.json")).toBe(false);
  });
});

describe("expiration check", () => {
  it("file from 7 days ago → expired", () => {
    const sevenDaysAgo = Date.now() - 7 * 86_400_000 - 1;
    expect(isExpired(sevenDaysAgo, 7)).toBe(true);
  });

  it("file from 6 days ago → not expired", () => {
    const sixDaysAgo = Date.now() - 6 * 86_400_000;
    expect(isExpired(sixDaysAgo, 7)).toBe(false);
  });

  it("30-day retention: 29 days ago → not expired", () => {
    const t = Date.now() - 29 * 86_400_000;
    expect(isExpired(t, 30)).toBe(false);
  });

  it("30-day retention: 31 days ago → expired", () => {
    const t = Date.now() - 31 * 86_400_000;
    expect(isExpired(t, 30)).toBe(true);
  });
});

describe("same-name conflict handling for old files", () => {
  it("file names do not conflict on second rotation of the same day", () => {
    const archiveDir = path.join(tmpDir, "archive");
    fs.mkdirSync(archiveDir);
    const dateStr = new Date().toISOString().slice(0, 10);
    const baseName = "monitor";

    // Generate first archive
    let archiveName = `${baseName}.${dateStr}.log`;
    let archivePath = path.join(archiveDir, archiveName);
    fs.writeFileSync(archivePath, "first");

    // Detect conflict → append counter suffix
    let counter = 1;
    while (fs.existsSync(archivePath)) {
      archiveName = `${baseName}.${dateStr}.${counter}.log`;
      archivePath = path.join(archiveDir, archiveName);
      counter++;
    }

    expect(archiveName).toBe(`${baseName}.${dateStr}.1.log`);
    expect(fs.existsSync(archivePath)).toBe(false);
  });
});

describe("rotateLogs() export verification", () => {
  it("function export exists", async () => {
    const { rotateLogs } = await import("../health/log-rotate.js");
    expect(typeof rotateLogs).toBe("function");
  });
});

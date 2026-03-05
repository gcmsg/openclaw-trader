/**
 * Emergency news monitoring tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import {
  scanEmergencyKeywords,
  writeEmergencyHalt,
  readEmergencyHalt,
} from "../news/emergency-monitor.js";

describe("scanEmergencyKeywords()", () => {
  it("hack keyword match", () => {
    const matches = scanEmergencyKeywords("Major exchange hacked, $100M stolen");
    expect(matches).toContain("hack");
    expect(matches).toContain("stolen");
  });

  it("regulatory keyword match", () => {
    const matches = scanEmergencyKeywords("SEC charges CEO of major crypto exchange");
    expect(matches).toContain("sec charges");
  });

  it("withdrawal suspension match", () => {
    const matches = scanEmergencyKeywords("Exchange halted withdrawals citing security concerns");
    expect(matches).toContain("halted withdrawals");
  });

  it("stablecoin depeg match", () => {
    const matches = scanEmergencyKeywords("USDT depeg concerns as reserves questioned");
    expect(matches).toContain("usdt depeg");
    expect(matches).toContain("depeg");
  });

  it("normal news does not trigger", () => {
    const matches = scanEmergencyKeywords("Bitcoin price rises 5% as market recovers");
    expect(matches).toHaveLength(0);
  });

  it("case insensitive", () => {
    const matches = scanEmergencyKeywords("EXCHANGE HACKED AND FUNDS STOLEN");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("low risk news does not trigger (single word edge case)", () => {
    const matches = scanEmergencyKeywords("New security features announced for Binance");
    expect(matches).toHaveLength(0);
  });
});

describe("trigger condition: requires at least 2 keywords (reduce false positives)", () => {
  it("single keyword does not trigger halt", () => {
    // Only 1 matching word → should not trigger halt (checkEmergencyNews internal logic)
    const matches = scanEmergencyKeywords("Bitcoin price banned in one country");
    // "banned" is one keyword, but a single word is not enough to trigger
    expect(matches.length).toBeLessThan(2);
  });

  it("multiple keywords trigger halt", () => {
    const matches = scanEmergencyKeywords("Exchange hacked, withdrawals halted, funds stolen");
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("EmergencyState type validation", () => {
  it("readEmergencyHalt exports exist", async () => {
    const { readEmergencyHalt, writeEmergencyHalt, clearEmergencyHalt } = await import("../news/emergency-monitor.js");
    expect(typeof readEmergencyHalt).toBe("function");
    expect(typeof writeEmergencyHalt).toBe("function");
    expect(typeof clearEmergencyHalt).toBe("function");
  });
});

describe("seenUrls circular trigger prevention", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readFileSyncSpy: any;
  let writtenState: Record<string, unknown> = {};

  beforeEach(() => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation((_p: unknown, data: unknown) => {
      writtenState = JSON.parse(data as string) as Record<string, unknown>;
    });
    // Default: no historical seenUrls (readFileSync throws → falls back to empty state)
    readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no file");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    writtenState = {};
  });

  it("writeEmergencyHalt writes seenUrls with 24h expiry", () => {
    const before = Date.now();
    writeEmergencyHalt("Exchange hacked", ["hack", "stolen"], "https://news.example.com/hack");
    const after = Date.now();

    expect(writtenState["halt"]).toBe(true);
    const seenUrls = writtenState["seenUrls"] as Record<string, number>;
    expect(seenUrls).toBeDefined();
    const expiry = seenUrls["https://news.example.com/hack"] as number;
    expect(expiry).toBeGreaterThan(before + 23 * 3600_000); // close to 24h
    expect(expiry).toBeLessThan(after + 25 * 3600_000);
  });

  it("writeEmergencyHalt preserves existing seenUrls (across halt cycles)", () => {
    const existingExpiry = Date.now() + 20 * 3600_000;
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        halt: false,
        autoCleared: true,
        keywords: [],
        seenUrls: { "https://old-article.com": existingExpiry },
      })
    );

    writeEmergencyHalt("New hack", ["hack", "stolen"], "https://new-article.com");

    const seenUrls = writtenState["seenUrls"] as Record<string, number>;
    expect(seenUrls["https://old-article.com"]).toBe(existingExpiry); // old entry preserved
    expect(seenUrls["https://new-article.com"]).toBeGreaterThan(Date.now()); // new entry written
  });

  it("writeEmergencyHalt cleans up expired seenUrls", () => {
    const expiredTime = Date.now() - 1000; // already expired
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        halt: false,
        keywords: [],
        seenUrls: { "https://expired.com": expiredTime },
      })
    );

    writeEmergencyHalt("New hack", ["hack", "stolen"], "https://new-article.com");

    const seenUrls = writtenState["seenUrls"] as Record<string, number>;
    expect(seenUrls["https://expired.com"]).toBeUndefined(); // expired entry cleared
    expect(seenUrls["https://new-article.com"]).toBeDefined(); // new entry preserved
  });

  it("seenUrls preserved via state spread after halt auto-clears", () => {
    const validExpiry = Date.now() + 20 * 3600_000;
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        halt: true,
        expiresAt: Date.now() - 1000, // expired (2h auto-clear)
        keywords: ["hack"],
        seenUrls: { "https://already-triggered.com": validExpiry },
      })
    );

    const result = readEmergencyHalt();

    expect(result.halt).toBe(false); // auto-cleared
    expect(result.autoCleared).toBe(true);
    // seenUrls preserved in written state via spread
    const written = writtenState["seenUrls"] as Record<string, number>;
    expect(written["https://already-triggered.com"]).toBe(validExpiry);
  });
});

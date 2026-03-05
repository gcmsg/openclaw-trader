/**
 * notifyError cooldown tests
 *
 * Verifies: repeated calls to notifyError with the same context within 30 minutes will not send duplicate notifications
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "child_process";

// Mock spawnSync to avoid real openclaw CLI calls
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawnSync: vi.fn().mockReturnValue({ status: 0, stderr: "" }) };
});

// Note: must import after mock, use dynamic import to ensure mock takes effect
let notifyError: (context: string, error: Error) => void;

beforeEach(async () => {
  vi.resetModules(); // Reset modules to clear cooldown Map
  const mod = await import("../notify/openclaw.js");
  notifyError = mod.notifyError;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyError cooldown mechanism", () => {
  it("first call should send notification", async () => {
    const { spawnSync } = await import("child_process");
    notifyError("test-context", new Error("something failed"));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("immediate repeated calls with same context → only sent once", async () => {
    const { spawnSync } = await import("child_process");
    notifyError("test-context", new Error("fail 1"));
    notifyError("test-context", new Error("fail 2"));
    notifyError("test-context", new Error("fail 3"));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("different contexts → sent independently", async () => {
    const { spawnSync } = await import("child_process");
    notifyError("context-A", new Error("fail A"));
    notifyError("context-B", new Error("fail B"));
    notifyError("context-A", new Error("fail A again")); // in cooldown, skipped
    expect(spawnSync).toHaveBeenCalledTimes(2); // once each for A and B
  });
});

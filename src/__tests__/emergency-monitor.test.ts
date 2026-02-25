/**
 * 突发新闻监控测试
 */
import { describe, it, expect } from "vitest";
import { scanEmergencyKeywords } from "../news/emergency-monitor.js";

describe("scanEmergencyKeywords()", () => {
  it("hack 关键词匹配", () => {
    const matches = scanEmergencyKeywords("Major exchange hacked, $100M stolen");
    expect(matches).toContain("hack");
    expect(matches).toContain("stolen");
  });

  it("监管关键词匹配", () => {
    const matches = scanEmergencyKeywords("SEC charges CEO of major crypto exchange");
    expect(matches).toContain("sec charges");
  });

  it("提款暂停匹配", () => {
    const matches = scanEmergencyKeywords("Exchange halted withdrawals citing security concerns");
    expect(matches).toContain("halted withdrawals");
  });

  it("稳定币脱锚匹配", () => {
    const matches = scanEmergencyKeywords("USDT depeg concerns as reserves questioned");
    expect(matches).toContain("usdt depeg");
    expect(matches).toContain("depeg");
  });

  it("普通新闻不触发", () => {
    const matches = scanEmergencyKeywords("Bitcoin price rises 5% as market recovers");
    expect(matches).toHaveLength(0);
  });

  it("大小写不敏感", () => {
    const matches = scanEmergencyKeywords("EXCHANGE HACKED AND FUNDS STOLEN");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("低风险新闻不触发（单个词的边界情况）", () => {
    const matches = scanEmergencyKeywords("New security features announced for Binance");
    expect(matches).toHaveLength(0);
  });
});

describe("触发条件：需要至少 2 个关键词（减少误报）", () => {
  it("单关键词不触发 halt", () => {
    // 只有 1 个匹配词 → 不应触发 halt（checkEmergencyNews 内部逻辑）
    const matches = scanEmergencyKeywords("Bitcoin price banned in one country");
    // "banned" 是关键词之一，但单个词不够触发
    expect(matches.length).toBeLessThan(2);
  });

  it("多关键词触发 halt", () => {
    const matches = scanEmergencyKeywords("Exchange hacked, withdrawals halted, funds stolen");
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("EmergencyState 类型验证", () => {
  it("readEmergencyHalt 导出存在", async () => {
    const { readEmergencyHalt, writeEmergencyHalt, clearEmergencyHalt } = await import("../news/emergency-monitor.js");
    expect(typeof readEmergencyHalt).toBe("function");
    expect(typeof writeEmergencyHalt).toBe("function");
    expect(typeof clearEmergencyHalt).toBe("function");
  });
});

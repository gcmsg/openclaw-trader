/**
 * Bug 5: 文件 I/O 原子写入测试
 *
 * 验证 saveAccount 使用原子写入（先写 .tmp 再 rename），
 * 防止并发写入导致数据损坏。
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import { saveAccount, loadAccount, getAccountPath } from "../paper/account.js";
import type { PaperAccount } from "../paper/account.js";

const TEST_IDS: string[] = [];

function uniqueId(): string {
  const id = `atomic-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  TEST_IDS.push(id);
  return id;
}

function makeAccount(usdt = 1000): PaperAccount {
  return {
    initialUsdt: usdt,
    usdt,
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
  };
}

afterEach(() => {
  // 清理测试生成的文件
  for (const id of TEST_IDS) {
    try { fs.rmSync(getAccountPath(id)); } catch { /* ignore */ }
    try { fs.rmSync(getAccountPath(id) + ".tmp"); } catch { /* ignore */ }
  }
  TEST_IDS.length = 0;
});

describe("saveAccount — 原子写入", () => {
  it("save 后文件存在且无 .tmp 残留", () => {
    const id = uniqueId();
    saveAccount(makeAccount(), id);

    const filePath = getAccountPath(id);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(filePath + ".tmp")).toBe(false);
  });

  it("save 后 load 读回数据一致", () => {
    const id = uniqueId();
    const account = makeAccount(5000);
    account.trades.push({
      id: "T1",
      symbol: "BTCUSDT",
      side: "buy",
      quantity: 0.1,
      price: 50000,
      usdtAmount: 5000,
      fee: 5,
      slippage: 0,
      timestamp: Date.now(),
      reason: "test",
    });

    saveAccount(account, id);
    const loaded = loadAccount(5000, id);

    expect(loaded.usdt).toBe(5000);
    expect(loaded.trades).toHaveLength(1);
    expect(loaded.trades[0]!.symbol).toBe("BTCUSDT");
  });

  it("连续 save 两次不产生 .tmp 残留", () => {
    const id = uniqueId();
    saveAccount(makeAccount(1000), id);
    saveAccount(makeAccount(2000), id);

    const filePath = getAccountPath(id);
    expect(fs.existsSync(filePath + ".tmp")).toBe(false);

    const loaded = loadAccount(1000, id);
    expect(loaded.usdt).toBe(2000);
  });

  it("写入的文件内容是有效 JSON", () => {
    const id = uniqueId();
    saveAccount(makeAccount(3000), id);

    const raw = fs.readFileSync(getAccountPath(id), "utf-8");
    const parsed = JSON.parse(raw) as PaperAccount;
    expect(parsed.usdt).toBe(3000);
    expect(parsed.initialUsdt).toBe(3000);
  });

  it("不同 scenarioId 写不同文件", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    saveAccount(makeAccount(1000), id1);
    saveAccount(makeAccount(2000), id2);

    expect(loadAccount(1000, id1).usdt).toBe(1000);
    expect(loadAccount(2000, id2).usdt).toBe(2000);
  });
});

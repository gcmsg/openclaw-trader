/**
 * BTC 主导率趋势追踪测试
 *
 * 覆盖：trackBtcDominance / getBtcDominanceTrend / getLatestDominance
 * 所有文件 I/O 均通过 vi.spyOn(fs, ...) mock，不读写真实磁盘。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

import {
  trackBtcDominance,
  getBtcDominanceTrend,
  getLatestDominance,
} from "../strategy/btc-dominance.js";
import type { DominanceRecord } from "../strategy/btc-dominance.js";

// ─── helpers ──────────────────────────────────────────────────────

function makeRecord(date: string, dom: number): DominanceRecord {
  return { date, dom, ts: Date.now() };
}

/** 构造 N 天连续记录（从 startDate 往后 N 天，dom 线性变化） */
function makeRecords(startDate: string, count: number, startDom: number, endDom: number): DominanceRecord[] {
  const records: DominanceRecord[] = [];
  const start = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const dom = startDom + (endDom - startDom) * (i / (count - 1 || 1));
    records.push({ date, dom, ts: Date.now() });
  }
  return records;
}

// ─── trackBtcDominance ────────────────────────────────────────────

describe("trackBtcDominance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("写入新记录时调用 writeFileSync", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    trackBtcDominance(55.2);

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0]?.[1] as string;
    const records = JSON.parse(written) as DominanceRecord[];
    expect(records.length).toBeGreaterThan(0);
    const last = records[records.length - 1];
    expect(last?.dom).toBeCloseTo(55.2);
  });

  it("同一天重复写入时覆盖旧记录（只保留最新）", () => {
    const today = new Date().toISOString().slice(0, 10);
    const existing: DominanceRecord[] = [makeRecord(today, 50.0)];

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(existing));
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    trackBtcDominance(55.5);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const records = JSON.parse(written) as DominanceRecord[];
    // 同一天只保留一条
    const todayRecords = records.filter((r) => r.date === today);
    expect(todayRecords).toHaveLength(1);
    expect(todayRecords[0]?.dom).toBeCloseTo(55.5);
  });

  it("超过 30 天的旧记录被截断", () => {
    // 制造 40 条历史记录
    const records = makeRecords("2025-01-01", 40, 50, 55);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    trackBtcDominance(55.0);

    const written = writeSpy.mock.calls[0]?.[1] as string;
    const saved = JSON.parse(written) as DominanceRecord[];
    // MAX_DAYS = 30, 加上今天的新记录，总数应 <= 30
    expect(saved.length).toBeLessThanOrEqual(30);
  });

  it("文件不存在时从空数组开始", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    trackBtcDominance(53.0);

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0]?.[1] as string;
    const records = JSON.parse(written) as DominanceRecord[];
    expect(records).toHaveLength(1);
  });
});

// ─── getBtcDominanceTrend ─────────────────────────────────────────

describe("getBtcDominanceTrend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无历史记录时返回 direction=neutral 且 latest=NaN", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const trend = getBtcDominanceTrend();
    expect(trend.direction).toBe("neutral");
    expect(trend.records).toHaveLength(0);
    expect(isNaN(trend.latest)).toBe(true);
  });

  it("主导率上升 > 0.5% → direction=rising", () => {
    // 7 天前 52%，今天 54%，变化 +2%
    const records = makeRecords("2025-02-01", 8, 52.0, 54.0);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const trend = getBtcDominanceTrend(7);
    expect(trend.direction).toBe("rising");
    expect(trend.change).toBeGreaterThan(0.5);
  });

  it("主导率下降 > 0.5% → direction=falling", () => {
    // 7 天前 56%，今天 54%，变化 -2%
    const records = makeRecords("2025-02-01", 8, 56.0, 54.0);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const trend = getBtcDominanceTrend(7);
    expect(trend.direction).toBe("falling");
    expect(trend.change).toBeLessThan(-0.5);
  });

  it("变化 < neutralThreshold → direction=neutral", () => {
    // 7 天变化仅 +0.2%，低于默认阈值 0.5%
    const records = makeRecords("2025-02-01", 8, 54.0, 54.2);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const trend = getBtcDominanceTrend(7);
    expect(trend.direction).toBe("neutral");
  });

  it("自定义 neutralThreshold 有效", () => {
    // 变化 +0.8%，默认阈值 0.5% 会触发 rising，但自定义 1.0% 不触发
    const records = makeRecords("2025-02-01", 8, 54.0, 54.8);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const trend = getBtcDominanceTrend(7, 1.0);
    expect(trend.direction).toBe("neutral");
  });

  it("返回的 latest 与历史记录最后一条一致", () => {
    const records = makeRecords("2025-02-01", 5, 50.0, 53.0);

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const trend = getBtcDominanceTrend(7);
    expect(trend.latest).toBeCloseTo(records[records.length - 1]!.dom);
  });
});

// ─── getLatestDominance ───────────────────────────────────────────

describe("getLatestDominance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无记录时返回 undefined", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(getLatestDominance()).toBeUndefined();
  });

  it("有记录时返回最后一条", () => {
    const records: DominanceRecord[] = [
      makeRecord("2025-02-01", 52.0),
      makeRecord("2025-02-02", 53.0),
      makeRecord("2025-02-03", 54.5),
    ];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(records));

    const latest = getLatestDominance();
    expect(latest).toBeDefined();
    expect(latest?.dom).toBeCloseTo(54.5);
    expect(latest?.date).toBe("2025-02-03");
  });

  it("文件损坏时返回 undefined（不抛出异常）", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("invalid json !!!");

    expect(() => getLatestDominance()).not.toThrow();
    expect(getLatestDominance()).toBeUndefined();
  });
});

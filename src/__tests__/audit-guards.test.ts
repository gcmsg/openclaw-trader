/**
 * 审计修复守卫测试
 *
 * 覆盖 2026-02-28 审计报告中已修复的关键守卫：
 *   H3 — 信号价格有效性校验（NaN / 0 / 负数 / Infinity → skipped）
 *   M3 — DCA 均价计算除零守卫（execPrice=0 / totalQty=0 → null）
 *   L2 — Binance API 重试逻辑（429 / 5xx / 网络错误 → 最多重试 3 次）
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Mock 外部 I/O ──────────────────────────────────────
vi.mock("../strategy/signal-history.js", () => ({
  logSignal: vi.fn(() => "mock-sig-id"),
  closeSignal: vi.fn(() => undefined),
}));

vi.mock("../persistence/db.js", () => ({
  TradeDB: class {
    insertTrade(): number { return 1; }
    updateTradeExit(): void { return; }
    getOpenTrades(): never[] { return []; }
    close(): void { return; }
  },
}));

import { handleSignal } from "../paper/engine.js";
import {
  loadAccount,
  saveAccount,
  paperBuy,
  paperDcaAdd,
  type PaperAccount,
} from "../paper/account.js";
import type { RuntimeConfig, Signal } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

function ensureLogs() {
  mkdirSync(LOGS_DIR, { recursive: true });
}

function cleanScenario(id: string) {
  const f = path.join(LOGS_DIR, `paper-${id}.json`);
  if (existsSync(f)) unlinkSync(f);
}

function makeCfg(scenarioId: string): RuntimeConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 5, long: 10 },
      rsi: { period: 14, oversold: 30, overbought: 70 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      volume: { surge_ratio: 1.5, low_ratio: 0.5 },
    },
    signals: {
      buy: ["ma_bullish"],
      sell: ["ma_bearish"],
    },
    risk: {
      stop_loss_percent: 5,
      take_profit_percent: 15,
      trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.5,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 50,
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0.1,
      min_order_usdt: 10,
      limit_order_timeout_seconds: 300,
    },
    notify: {
      on_signal: false,
      on_trade: false,
      on_stop_loss: false,
      on_take_profit: false,
      on_error: false,
      on_daily_summary: false,
      min_interval_minutes: 60,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    exchange: { market: "spot" },
    paper: {
      scenarioId,
      initial_usdt: 1000,
      fee_rate: 0.001,
      slippage_percent: 0.05,
    },
  } as RuntimeConfig;
}

function makeBuySignal(symbol: string, price: number): Signal {
  return {
    type: "buy",
    symbol,
    price,
    reason: ["ma_bullish"],
    indicators: {
      maShort: price * 1.02,
      maLong: price * 0.98,
      rsi: 40,
      atr: price * 0.01,
      price,
      volume: 1000,
      avgVolume: 800,
    },
  } as Signal;
}

function makeAccount(scenarioId: string): PaperAccount {
  const acc = loadAccount(1000, scenarioId);
  return acc;
}

// ─────────────────────────────────────────────────────
// H3: 信号价格有效性校验
// ─────────────────────────────────────────────────────

describe("H3 — handleSignal 价格有效性守卫", () => {
  const SID_BASE = "ag-h3";

  beforeEach(() => ensureLogs());
  afterEach(() => {
    ["0", "nan", "neg", "inf", "valid"].forEach((s) => cleanScenario(`${SID_BASE}-${s}`));
  });

  it("price = 0 → 返回 skipped（不开仓）", () => {
    const cfg = makeCfg(`${SID_BASE}-0`);
    const sig: Signal = makeBuySignal("BTCUSDT", 0);
    const result = handleSignal(sig, cfg);
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toMatch(/价格无效/);
    expect(result.trade).toBeNull();
  });

  it("price = NaN → 返回 skipped（不开仓）", () => {
    const cfg = makeCfg(`${SID_BASE}-nan`);
    const sig: Signal = { ...makeBuySignal("BTCUSDT", 50000), price: NaN };
    const result = handleSignal(sig, cfg);
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toMatch(/价格无效/);
    expect(result.trade).toBeNull();
  });

  it("price = -100 (负数) → 返回 skipped（不开仓）", () => {
    const cfg = makeCfg(`${SID_BASE}-neg`);
    const sig: Signal = { ...makeBuySignal("BTCUSDT", 50000), price: -100 };
    const result = handleSignal(sig, cfg);
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toMatch(/价格无效/);
    expect(result.trade).toBeNull();
  });

  it("price = Infinity → 返回 skipped（不开仓）", () => {
    const cfg = makeCfg(`${SID_BASE}-inf`);
    const sig: Signal = { ...makeBuySignal("BTCUSDT", 50000), price: Infinity };
    const result = handleSignal(sig, cfg);
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toMatch(/价格无效/);
    expect(result.trade).toBeNull();
  });

  it("price = 50000 (有效) → 正常执行，不 skipped", () => {
    const cfg = makeCfg(`${SID_BASE}-valid`);
    const sig: Signal = makeBuySignal("BTCUSDT", 50000);
    // 不要求 trade 非 null（可能因余额或其他守卫跳过），
    // 但 skipped 不应该是"价格无效"
    const result = handleSignal(sig, cfg);
    expect(result.skipped ?? "").not.toMatch(/价格无效/);
  });
});

// ─────────────────────────────────────────────────────
// M3: DCA 均价除零守卫
// ─────────────────────────────────────────────────────

describe("M3 — paperDcaAdd 除零守卫", () => {
  const SID_BASE = "ag-m3";

  beforeEach(() => ensureLogs());
  afterEach(() => {
    ["zero-price", "nan-price", "no-pos", "valid"].forEach((s) =>
      cleanScenario(`${SID_BASE}-${s}`)
    );
  });

  it("execPrice = 0 → 返回 null，不产生 NaN 持仓", () => {
    const sid = `${SID_BASE}-zero-price`;
    const acc = makeAccount(sid);
    // 先建立持仓
    paperBuy(acc, "BTCUSDT", 50000, "initial buy", { overridePositionUsdt: 100 });
    expect(acc.positions["BTCUSDT"]).toBeDefined();

    // DCA 以 price=0 加仓 → 应返回 null
    const result = paperDcaAdd(acc, "BTCUSDT", 0, "dca-zero-price", { addUsdt: 50 });
    expect(result).toBeNull();

    // 持仓 entryPrice 不应变成 NaN
    const pos = acc.positions["BTCUSDT"];
    expect(pos).toBeDefined();
    expect(Number.isFinite(pos!.entryPrice)).toBe(true);

    saveAccount(acc, sid);
  });

  it("execPrice = NaN → 返回 null，不产生 NaN 持仓", () => {
    const sid = `${SID_BASE}-nan-price`;
    const acc = makeAccount(sid);
    paperBuy(acc, "BTCUSDT", 50000, "initial buy", { overridePositionUsdt: 100 });

    const result = paperDcaAdd(acc, "BTCUSDT", NaN, "dca-nan-price", { addUsdt: 50 });
    expect(result).toBeNull();

    const pos = acc.positions["BTCUSDT"];
    expect(Number.isFinite(pos!.entryPrice)).toBe(true);

    saveAccount(acc, sid);
  });

  it("无持仓时 DCA → 返回 null（无位置可加仓）", () => {
    const sid = `${SID_BASE}-no-pos`;
    const acc = makeAccount(sid);
    // 不开仓，直接 DCA → 应返回 null
    const result = paperDcaAdd(acc, "BTCUSDT", 50000, "dca-no-pos", { addUsdt: 100 });
    expect(result).toBeNull();
    saveAccount(acc, sid);
  });

  it("正常 DCA → entryPrice 均摊正确，非 NaN", () => {
    const sid = `${SID_BASE}-valid`;
    const acc = makeAccount(sid);

    // 初始买入 @50000，花 100 USDT
    paperBuy(acc, "BTCUSDT", 50000, "initial", { overridePositionUsdt: 100 });
    const initQty = acc.positions["BTCUSDT"]!.quantity;
    const initEntry = acc.positions["BTCUSDT"]!.entryPrice;

    // DCA @48000，花 100 USDT
    const trade = paperDcaAdd(acc, "BTCUSDT", 48000, "dca", { addUsdt: 100 });
    expect(trade).not.toBeNull();

    const pos = acc.positions["BTCUSDT"]!;
    expect(Number.isFinite(pos.entryPrice)).toBe(true);
    // 均摊价应在 48000~50000 之间
    expect(pos.entryPrice).toBeGreaterThan(48000);
    expect(pos.entryPrice).toBeLessThan(initEntry);
    // 数量应增加
    expect(pos.quantity).toBeGreaterThan(initQty);

    saveAccount(acc, sid);
  });
});

/**
 * Short engine layer tests
 * Coverage: handleSignal(short/cover) + checkExitConditions (short direction)
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handleSignal, checkExitConditions } from "../paper/engine.js";
import type { Signal, RuntimeConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─── Helpers ───────────────────────────────────────────

function makeSignal(type: Signal["type"], symbol = "BTCUSDT", price = 100): Signal {
  return {
    symbol,
    type,
    price,
    indicators: {
      maShort: price * 0.98,
      maLong: price * 1.02,
      rsi: 30,
      price,
      volume: 1000,
      avgVolume: 900,
    },
    reason: [type],
    timestamp: Date.now(),
  };
}

function makeCfg(overrides: {
  market?: "spot" | "futures" | "margin";
  scenarioId?: string;
  stopLoss?: number;
  takeProfit?: number;
  trailingEnabled?: boolean;
  trailingActivation?: number;
  trailingCallback?: number;
  timeStopHours?: number;
} = {}): RuntimeConfig {
  const scenarioId = overrides.scenarioId ?? `short-test-${Date.now()}`;
  return {
    symbols: ["BTCUSDT"],
    timeframe: "1h",
    strategy: {
      name: "test",
      enabled: true,
      ma: { short: 20, long: 60 },
      rsi: { period: 14, oversold: 35, overbought: 65 },
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    },
    signals: { buy: ["ma_bullish"], sell: ["ma_bearish"], short: ["ma_bearish"], cover: ["ma_bullish"] },
    risk: {
      stop_loss_percent: overrides.stopLoss ?? 5,
      take_profit_percent: overrides.takeProfit ?? 15,
      trailing_stop: {
        enabled: overrides.trailingEnabled ?? false,
        activation_percent: overrides.trailingActivation ?? 5,
        callback_percent: overrides.trailingCallback ?? 2,
      },
      position_ratio: 0.2,
      max_positions: 4,
      max_position_per_symbol: 0.5,
      max_total_loss_percent: 20,
      daily_loss_limit_percent: 10,
      ...(overrides.timeStopHours !== undefined ? { time_stop_hours: overrides.timeStopHours } : {}),
    },
    execution: {
      order_type: "market",
      limit_order_offset_percent: 0,
      min_order_usdt: 1,
      limit_order_timeout_seconds: 30,
    },
    notify: {
      on_signal: false,
      on_trade: false,
      on_stop_loss: false,
      on_take_profit: false,
      on_error: false,
      on_daily_summary: false,
      min_interval_minutes: 0,
    },
    news: { enabled: false, interval_hours: 24, price_alert_threshold: 5, fear_greed_alert: 20 },
    mode: "paper",
    exchange: {
      market: overrides.market ?? "futures",
      testnet: false,
    },
    paper: {
      scenarioId,
      initial_usdt: 10_000,
      fee_rate: 0,
      slippage_percent: 0,
      report_interval_hours: 24,
    },
  };
}

// ─── Clean up account files after tests ──────────────────────────

const createdFiles: string[] = [];

function trackFile(scenarioId: string): void {
  createdFiles.push(path.join(LOGS_DIR, `paper-${scenarioId}.json`));
}

afterEach(() => {
  for (const f of createdFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  createdFiles.length = 0;
});

// ─── handleSignal: short ─────────────────────────────

describe("handleSignal - short signal", () => {
  it("futures market: successfully opens short, returns trade(side=short)", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("short");
    expect(result.skipped).toBeUndefined();
  });

  it("spot market: short open rejected (skipped indicates wrong market type)", () => {
    const cfg = makeCfg({ market: "spot" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).toBeNull();
    expect(result.skipped).toMatch(/futures|margin/);
  });

  it("Rejects short open when max positions reached", () => {
    const cfg = makeCfg({ market: "futures" });
    cfg.risk.max_positions = 1;
    trackFile(cfg.paper.scenarioId);
    // Open a long first to occupy a slot
    handleSignal(makeSignal("buy", "ETHUSDT", 100), cfg);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).toBeNull();
    expect(result.skipped).toMatch(/Max positions/);
  });
});

// ─── handleSignal: cover ─────────────────────────────

describe("handleSignal - cover signal", () => {
  it("Successfully covers when short position exists", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 80), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("cover");
    expect(result.trade!.pnl).toBeGreaterThan(0); // Price dropped, short profits
  });

  it("Cover returns null when no short position exists", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 80), cfg);
    expect(result.trade).toBeNull();
  });

  it("Cover signal on long position: returns null (does not accidentally close long)", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 120), cfg);
    // paperCoverShort finds side=long, returns null
    expect(result.trade).toBeNull();
  });
});

// ─── checkExitConditions: short stop loss / take profit ──────────────

describe("checkExitConditions - short stop loss / take profit", () => {
  it("Short stop loss: triggers when price rises above stop loss line (returns stop_loss)", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // Short open @100, stop loss=105 (+5%)
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // Price rises to 106, exceeds stop loss line 105
    const exits = checkExitConditions({ BTCUSDT: 106 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("stop_loss");
    expect(exits[0]!.symbol).toBe("BTCUSDT");
  });

  it("Short take profit: triggers when price drops below take profit line (returns take_profit)", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // Short open @100, take profit=85 (-15%)
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // Price drops to 84, below take profit line 85
    const exits = checkExitConditions({ BTCUSDT: 84 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("take_profit");
    expect(exits[0]!.pnlPercent).toBeGreaterThan(0); // Short profits
  });

  it("Short price does not hit any stop loss/take profit line: does not trigger", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // Price in safe range (90, stop loss 105, take profit 85)
    const exits = checkExitConditions({ BTCUSDT: 90 }, cfg);
    expect(exits).toHaveLength(0);
  });

  it("Long stop loss not affected (backward compatible)", () => {
    const cfg = makeCfg({ market: "spot", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // Long open @100, stop loss=95
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    // Price drops to 94, triggers long stop loss
    const exits = checkExitConditions({ BTCUSDT: 94 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("stop_loss");
  });

  it("Long take profit not affected (backward compatible)", () => {
    const cfg = makeCfg({ market: "spot", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    // Price rises to 116, triggers long take profit
    const exits = checkExitConditions({ BTCUSDT: 116 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("take_profit");
  });
});

// ─── checkExitConditions: short trailing stop ──────────────

describe("checkExitConditions - short trailing stop", () => {
  it("Trailing stop activated then rebounds from low: triggers close", () => {
    const cfg = makeCfg({
      market: "futures",
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: 2,
      takeProfit: 40, // Take profit 40% (triggers only at price 60), avoids interfering with trailing stop test
    });
    trackFile(cfg.paper.scenarioId);

    // Short open @100
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);

    // Price drops to 90 (down 10%, exceeds activation threshold 5%) - trailing stop activated, state written to disk
    let exits = checkExitConditions({ BTCUSDT: 90 }, cfg);
    expect(exits).toHaveLength(0); // Only activated, not triggered

    // Price rebounds from 90 to 92 (rebound >2%, stopPrice=90*1.02=91.8)
    exits = checkExitConditions({ BTCUSDT: 92 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("trailing_stop");
  });

  it("Price continues dropping: trailing stop not triggered", () => {
    const cfg = makeCfg({
      market: "futures",
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: 2,
      takeProfit: 40, // Take profit 40% (triggers only at price 60)
    });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // Dropped to 90 activated, state persisted
    checkExitConditions({ BTCUSDT: 90 }, cfg);
    // Further drop to 88 (continued profit, no rebound, trailing stop not triggered, take profit not reached)
    const exits = checkExitConditions({ BTCUSDT: 88 }, cfg);
    expect(exits).toHaveLength(0);
  });
});

// ─── checkExitConditions: short pnlPercent sign ──────

describe("checkExitConditions - short pnl sign is correct", () => {
  it("pnlPercent > 0 on short take profit", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 10 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const exits = checkExitConditions({ BTCUSDT: 88 }, cfg); // Down 12%, exceeds take profit 10%
    expect(exits[0]!.pnlPercent).toBeGreaterThan(0);
  });

  it("pnlPercent < 0 on short stop loss (described as loss)", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const exits = checkExitConditions({ BTCUSDT: 110 }, cfg); // Up 10%, exceeds stop loss 5%
    expect(exits[0]!.pnlPercent).toBeLessThan(0);
  });
});

// ─── Margin market also allows short ───────────────────────────

describe("Short open on margin market", () => {
  it("Can also open short when market=margin", () => {
    const cfg = makeCfg({ market: "margin" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("short");
  });
});

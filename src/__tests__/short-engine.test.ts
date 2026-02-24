/**
 * 空头引擎层测试
 * 覆盖：handleSignal(short/cover) + checkExitConditions(空头方向)
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handleSignal, checkExitConditions } from "../paper/engine.js";
import type { Signal, RuntimeConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─── 辅助 ───────────────────────────────────────────

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

// ─── 测试结束后清理账户文件 ──────────────────────────

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

describe("handleSignal - short 信号", () => {
  it("futures 市场：成功开空，返回 trade(side=short)", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("short");
    expect(result.skipped).toBeUndefined();
  });

  it("spot 市场：开空被拒绝（skipped 提示市场类型不对）", () => {
    const cfg = makeCfg({ market: "spot" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).toBeNull();
    expect(result.skipped).toMatch(/futures|margin/);
  });

  it("已达最大持仓数时拒绝开空", () => {
    const cfg = makeCfg({ market: "futures" });
    cfg.risk.max_positions = 1;
    trackFile(cfg.paper.scenarioId);
    // 先开一个多头占用名额
    handleSignal(makeSignal("buy", "ETHUSDT", 100), cfg);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).toBeNull();
    expect(result.skipped).toMatch(/最大持仓数/);
  });
});

// ─── handleSignal: cover ─────────────────────────────

describe("handleSignal - cover 信号", () => {
  it("有空头仓位时平空成功", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 80), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("cover");
    expect(result.trade!.pnl).toBeGreaterThan(0); // 价格跌了，空头盈利
  });

  it("无空头仓位时平空返回 null", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 80), cfg);
    expect(result.trade).toBeNull();
  });

  it("对多头仓位发 cover 信号：返回 null（不会误平多头）", () => {
    const cfg = makeCfg({ market: "futures" });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    const result = handleSignal(makeSignal("cover", "BTCUSDT", 120), cfg);
    // paperCoverShort 发现 side=long，返回 null
    expect(result.trade).toBeNull();
  });
});

// ─── checkExitConditions: 空头止损 ──────────────────

describe("checkExitConditions - 空头止损/止盈", () => {
  it("空头止损：价格涨破止损线时触发（返回 stop_loss）", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // 开空 @100，止损=105（+5%）
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // 价格涨到 106，超过止损线 105
    const exits = checkExitConditions({ BTCUSDT: 106 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("stop_loss");
    expect(exits[0]!.symbol).toBe("BTCUSDT");
  });

  it("空头止盈：价格跌破止盈线时触发（返回 take_profit）", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // 开空 @100，止盈=85（-15%）
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // 价格跌到 84，低于止盈线 85
    const exits = checkExitConditions({ BTCUSDT: 84 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("take_profit");
    expect(exits[0]!.pnlPercent).toBeGreaterThan(0); // 空头盈利
  });

  it("空头价格不触及任何止损/止盈线：不触发", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // 价格在安全区间（90，止损105，止盈85）
    const exits = checkExitConditions({ BTCUSDT: 90 }, cfg);
    expect(exits).toHaveLength(0);
  });

  it("多头止损不受影响（向后兼容）", () => {
    const cfg = makeCfg({ market: "spot", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    // 开多 @100，止损=95
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    // 价格跌到 94，触发多头止损
    const exits = checkExitConditions({ BTCUSDT: 94 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("stop_loss");
  });

  it("多头止盈不受影响（向后兼容）", () => {
    const cfg = makeCfg({ market: "spot", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("buy", "BTCUSDT", 100), cfg);
    // 价格涨到 116，触发多头止盈
    const exits = checkExitConditions({ BTCUSDT: 116 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("take_profit");
  });
});

// ─── checkExitConditions: 空头追踪止损 ──────────────

describe("checkExitConditions - 空头追踪止损", () => {
  it("追踪止损激活后从低点反弹：触发平仓", () => {
    const cfg = makeCfg({
      market: "futures",
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: 2,
      takeProfit: 40, // 止盈 40%（价格到 60 才触发），避免干扰追踪止损测试
    });
    trackFile(cfg.paper.scenarioId);

    // 开空 @100
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);

    // 价格跌到 90（跌 10%，超过激活阈值 5%）— 追踪止损激活，状态写入磁盘
    let exits = checkExitConditions({ BTCUSDT: 90 }, cfg);
    expect(exits).toHaveLength(0); // 仅激活，未触发

    // 价格从 90 反弹到 92（反弹 >2%，stopPrice=90×1.02=91.8）
    exits = checkExitConditions({ BTCUSDT: 92 }, cfg);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("trailing_stop");
  });

  it("价格继续下跌：不触发追踪止损", () => {
    const cfg = makeCfg({
      market: "futures",
      trailingEnabled: true,
      trailingActivation: 5,
      trailingCallback: 2,
      takeProfit: 40, // 止盈 40%（价格到 60 才触发）
    });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    // 跌到 90 激活，状态持久化
    checkExitConditions({ BTCUSDT: 90 }, cfg);
    // 再跌到 88（继续获利，未反弹，不触发追踪止损，未到止盈）
    const exits = checkExitConditions({ BTCUSDT: 88 }, cfg);
    expect(exits).toHaveLength(0);
  });
});

// ─── checkExitConditions: 空头 pnlPercent 符号 ──────

describe("checkExitConditions - 空头盈亏符号正确", () => {
  it("空头止盈时 pnlPercent > 0", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 10 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const exits = checkExitConditions({ BTCUSDT: 88 }, cfg); // 跌 12%，超过止盈 10%
    expect(exits[0]!.pnlPercent).toBeGreaterThan(0);
  });

  it("空头止损时 pnlPercent < 0（描述为亏损）", () => {
    const cfg = makeCfg({ market: "futures", stopLoss: 5, takeProfit: 15 });
    trackFile(cfg.paper.scenarioId);
    handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    const exits = checkExitConditions({ BTCUSDT: 110 }, cfg); // 涨 10%，超过止损 5%
    expect(exits[0]!.pnlPercent).toBeLessThan(0);
  });
});

// ─── margin 市场也允许开空 ───────────────────────────

describe("margin 市场开空", () => {
  it("market=margin 时也能开空", () => {
    const cfg = makeCfg({ market: "margin" });
    trackFile(cfg.paper.scenarioId);
    const result = handleSignal(makeSignal("short", "BTCUSDT", 100), cfg);
    expect(result.trade).not.toBeNull();
    expect(result.trade!.side).toBe("short");
  });
});

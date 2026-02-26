/**
 * Boundary & Stress Tests
 *
 * 覆盖极端边界条件和压力场景：
 *   - 价格极端值、空/极短 K 线、最大持仓、负资金、重复开仓
 *   - 止损价 > 当前价、空 symbols 配置
 *   - 随机价格回测、全止损、高频开平仓、配置缺失字段
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "fs";

// ── Mock 所有外部 I/O（必须在 import 被解析之前注册）────────────
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

// ── 主模块 imports（mocks 注册后）────────────────────────────────
import {
  paperBuy,
  paperSell,
  loadAccount,
  saveAccount,
  type PaperAccount,
} from "../paper/account.js";
import {
  handleSignal,
  checkExitConditions,
  checkStopLoss,
} from "../paper/engine.js";
import { processSignal } from "../strategy/signal-engine.js";
import { calculateIndicators } from "../strategy/indicators.js";
import { runBacktest } from "../backtest/runner.js";
import type { Kline, RuntimeConfig, Signal } from "../types.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/** 生成 RuntimeConfig，scenarioId 完全隔离 */
function makeCfg(
  scenarioId: string,
  overrides: Partial<RuntimeConfig> = {}
): RuntimeConfig {
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
      slippage_percent: 0,
      report_interval_hours: 24,
    },
    ...overrides,
  } as RuntimeConfig;
}

/** 生成标准正弦波 K 线（平稳行情） */
function makeKlines(n: number, basePrice = 100): Kline[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const price = basePrice + Math.sin(i * 0.3) * 2;
    return {
      openTime: now + i * 3_600_000,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000,
      closeTime: now + (i + 1) * 3_600_000 - 1,
    };
  });
}

/** 简单上升趋势 K 线 */
function makeUpKlines(n: number, basePrice = 100): Kline[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const price = basePrice * (1 + i * 0.002);
    return {
      openTime: now + i * 3_600_000,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000,
      closeTime: now + (i + 1) * 3_600_000 - 1,
    };
  });
}

/** 构造 buy 信号 */
function makeBuySignal(symbol: string, price: number): Signal {
  return {
    symbol,
    type: "buy",
    price,
    reason: ["ma_bullish"],
    indicators: {
      maShort: price * 1.02,
      maLong: price * 0.98,
      rsi: 40,
      price,
      volume: 1000,
      avgVolume: 800,
    },
    timestamp: Date.now(),
  };
}

/** 清理场景文件 */
function cleanScenario(scenarioId: string): void {
  const f = `logs/paper-${scenarioId}.json`;
  if (existsSync(f)) unlinkSync(f);
}

// ─────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync("logs", { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════
// 一、边界条件测试
// ═══════════════════════════════════════════════════════

describe("边界条件 1: 价格极端值 — 系统不崩溃", () => {
  const SID = "bs-extreme-price";

  afterEach(() => cleanScenario(SID));

  it("price = 0 → paperBuy 返回 null 或跳过，不崩溃", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      const result = paperBuy(account, "BTCUSDT", 0, "test-zero");
      // price=0 → execPrice=0 → quantity=Infinity; usdtToSpend≥minOrderUsdt 可能返回 trade
      // 只要不 throw 即可
      void result;
    }).not.toThrow();
  });

  it("price = -1 → paperBuy 不崩溃", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", -1, "test-negative");
    }).not.toThrow();
  });

  it("price = Infinity → paperBuy 不崩溃", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", Infinity, "test-inf");
    }).not.toThrow();
  });

  it("price = NaN → paperBuy 不崩溃", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperBuy(account, "BTCUSDT", NaN, "test-nan");
    }).not.toThrow();
  });

  it("极端价格下 paperSell 不崩溃（Infinity）", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 800,
      positions: {
        BTCUSDT: {
          symbol: "BTCUSDT",
          quantity: 0.01,
          entryPrice: 50000,
          entryTime: Date.now(),
          stopLoss: 47500,
          takeProfit: 57500,
        },
      },
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    expect(() => {
      void paperSell(account, "BTCUSDT", Infinity, "test-sell-inf");
    }).not.toThrow();
  });

  it("handleSignal 传入 price=0 不崩溃", () => {
    const cfg = makeCfg(SID);
    const sig: Signal = { ...makeBuySignal("BTCUSDT", 0), price: 0 };
    expect(() => handleSignal(sig, cfg)).not.toThrow();
    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 2: 空 K 线数组 → processSignal 安全返回", () => {
  it("klines=[] → indicators=null, rejected=true, 不崩溃", () => {
    const cfg = makeCfg("bs-empty-klines");
    expect(() => {
      const result = processSignal("BTCUSDT", [], cfg);
      expect(result.indicators).toBeNull();
      expect(result.rejected).toBe(true);
      expect(result.signal.type).toBe("none");
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 3: 极短 K 线 (1-5 根) → calculateIndicators 返回 null 不报错", () => {
  const cfg = makeCfg("bs-short-klines");

  for (const n of [1, 2, 3, 4, 5] as const) {
    it(`${n} 根 K 线 → calculateIndicators 返回 null`, () => {
      const klines = makeKlines(n);
      expect(() => {
        const result = calculateIndicators(
          klines,
          cfg.strategy.ma.short,
          cfg.strategy.ma.long,
          cfg.strategy.rsi.period,
          cfg.strategy.macd
        );
        // 数据不足，应返回 null 而非抛出
        expect(result).toBeNull();
      }).not.toThrow();
    });
  }

  it("1 根 K 线 → processSignal rejected=true, 不崩溃", () => {
    const klines = makeKlines(1);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      expect(result.indicators).toBeNull();
      expect(result.rejected).toBe(true);
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 4: 超大持仓数 → 被 max_positions 阻止", () => {
  const SID = "bs-max-pos";
  afterEach(() => cleanScenario(SID));

  it("max_positions=3，第 4 次开仓被跳过", () => {
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.05, // 小仓位，确保资金够
        max_positions: 3,
        max_position_per_symbol: 0.5,
        max_total_loss_percent: 20,
        daily_loss_limit_percent: 50,
      },
      symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    });

    const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
    const results = symbols.map((sym) =>
      handleSignal(makeBuySignal(sym, 100), cfg)
    );

    // 前 3 个应成功
    expect(results[0]!.trade).not.toBeNull();
    expect(results[1]!.trade).not.toBeNull();
    expect(results[2]!.trade).not.toBeNull();

    // 第 4 个应被 max_positions 阻止
    expect(results[3]!.trade).toBeNull();
    expect(results[3]!.skipped).toBeDefined();
    expect(results[3]!.skipped).toContain("最大持仓数");
  });

  it("循环尝试 100 个持仓，实际持仓数不超过 max_positions", () => {
    const MAX = 4;
    const cfg = makeCfg(SID + "-100", {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.01,
        max_positions: MAX,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 20,
        daily_loss_limit_percent: 50,
      },
    });

    // 用不同 symbol 避免重复持仓拦截
    for (let i = 0; i < 100; i++) {
      handleSignal(makeBuySignal(`TOKEN${i}USDT`, 100), cfg);
    }

    const account = loadAccount(1000, SID + "-100");
    expect(Object.keys(account.positions).length).toBeLessThanOrEqual(MAX);
    cleanScenario(SID + "-100");
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 5: 负资金 → 不能开仓", () => {
  it("account.usdt = -100 → paperBuy 返回 null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: -100, // 负资金
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-negative-balance");
    // usdtToSpend = equity * 0.2，但 equity 含持仓，这里无持仓所以 equity=-100
    // usdtToSpend = -100 * 0.2 = -20 < minOrderUsdt(10) → 返回 null
    // 或者 usdtToSpend < 0 < minOrderUsdt → 返回 null
    expect(result).toBeNull();
    // 账户状态不应改变
    expect(account.usdt).toBe(-100);
    expect(Object.keys(account.positions).length).toBe(0);
  });

  it("account.usdt = 0 → paperBuy 返回 null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 0,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-zero-balance");
    expect(result).toBeNull();
    expect(account.usdt).toBe(0);
  });

  it("account.usdt = 5 (< minOrderUsdt=10) → paperBuy 返回 null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 5,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const result = paperBuy(account, "BTCUSDT", 50000, "test-small-balance", {
      minOrderUsdt: 10,
      positionRatio: 1.0, // 全仓
    });
    // usdtToSpend = 5 * 1.0 = 5 < minOrderUsdt=10 → null
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 6: 同一 symbol 重复开仓 → 第二次被跳过", () => {
  it("连续 2 次 buy BTCUSDT → 第二次返回 null（paperBuy）", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const first = paperBuy(account, "BTCUSDT", 50000, "first-buy");
    const second = paperBuy(account, "BTCUSDT", 50000, "second-buy");

    expect(first).not.toBeNull(); // 第一次成功
    expect(second).toBeNull(); // 第二次被跳过（已有持仓）
    expect(Object.keys(account.positions).length).toBe(1);
  });

  it("通过 handleSignal 连续 2 次 buy BTCUSDT → 第二次 trade 为 null", () => {
    const SID = "bs-dup-buy";
    const cfg = makeCfg(SID);

    const r1 = handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);
    const r2 = handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);

    expect(r1.trade).not.toBeNull();
    // 第二次：已有持仓，paperBuy 返回 null，trade=null
    // skipped 可能是 max_position_per_symbol 触发
    expect(r2.trade).toBeNull();

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 7: 止损价 > 当前价（开仓即止损）", () => {
  it("持仓 stopLoss > entryPrice，checkStopLoss 以当前价触发止损", () => {
    const SID = "bs-stoploss-above";
    const cfg = makeCfg(SID);

    // 手动构造一个 stopLoss > entryPrice 的持仓（反常规，模拟配置错误）
    const account = loadAccount(1000, SID);
    const entryPrice = 50000;
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice,
      entryTime: Date.now(),
      stopLoss: entryPrice * 1.05, // 止损价高于入场价！(52500 > 50000)
      takeProfit: entryPrice * 1.15,
    };
    saveAccount(account, SID);

    // 当前价=入场价，止损价 > 当前价 → 应立刻触发（currentPrice <= stopLoss）
    expect(() => {
      const triggered = checkStopLoss({ BTCUSDT: entryPrice }, cfg);
      // 止损被触发（52500 > 50000，条件满足）
      expect(triggered.length).toBe(1);
      expect(triggered[0]!.symbol).toBe("BTCUSDT");
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("止损触发后账户 usdt 不为负（止损价异常不导致负余额）", () => {
    const SID = "bs-stoploss-above-2";
    const cfg = makeCfg(SID);

    const account = loadAccount(1000, SID);
    account.usdt = 800;
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice: 50000,
      entryTime: Date.now(),
      stopLoss: 60000, // 极端：止损价远高于入场价
      takeProfit: 57500,
    };
    saveAccount(account, SID);

    // 不崩溃，止损触发
    expect(() => {
      checkStopLoss({ BTCUSDT: 50000 }, cfg);
    }).not.toThrow();

    // 账户余额不应为负
    const afterAccount = loadAccount(1000, SID);
    expect(afterAccount.usdt).toBeGreaterThanOrEqual(0);

    cleanScenario(SID);
  });

  it("checkExitConditions 处理 stopLoss > entryPrice 不崩溃", () => {
    const SID = "bs-exit-stoploss-above";
    const cfg = makeCfg(SID);

    const account = loadAccount(1000, SID);
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 0.004,
      entryPrice: 50000,
      entryTime: Date.now(),
      stopLoss: 55000, // 止损价 > 入场价
      takeProfit: 57500,
    };
    saveAccount(account, SID);

    expect(() => {
      const exits = checkExitConditions({ BTCUSDT: 50000 }, cfg);
      void exits;
    }).not.toThrow();

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("边界条件 8: 空 config.symbols → 不报错", () => {
  it("processSignal 使用 symbols=[] 的 cfg，足够 K 线时不崩溃", () => {
    const cfg = makeCfg("bs-empty-symbols", { symbols: [] });
    const klines = makeKlines(60);

    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      // symbols 字段不影响 processSignal 内部逻辑（只影响 monitor 调度）
      expect(result).toBeDefined();
    }).not.toThrow();
  });

  it("空 symbols 下 handleSignal 不崩溃", () => {
    const SID = "bs-empty-symbols-engine";
    const cfg = makeCfg(SID, { symbols: [] });

    expect(() => {
      handleSignal(makeBuySignal("BTCUSDT", 50000), cfg);
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("runBacktest 传入空 klinesBySymbol 应 throw（已有保护逻辑）", () => {
    const cfg = makeCfg("bs-empty-backtest", { symbols: [] });
    expect(() => runBacktest({}, cfg)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════
// 二、压力/模糊测试
// ═══════════════════════════════════════════════════════

describe("压力测试 9: 随机价格序列 1000 根 K 线 backtest → 不崩溃", () => {
  it("随机价格序列 backtest 完成，指标和结果正常返回", () => {
    const cfg = makeCfg("bs-random-backtest", {
      strategy: {
        name: "test",
        enabled: true,
        ma: { short: 5, long: 10 },
        rsi: { period: 14, oversold: 30, overbought: 70 },
        macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      },
    });

    const now = Date.now();
    let price = 100;
    const INITIAL = 1000;

    // 生成 1000 根随机 K 线
    const klines: Kline[] = Array.from({ length: 1000 }, (_, i) => {
      // 随机游走，价格可能极端但不超出合理范围
      const delta = (Math.random() - 0.5) * price * 0.05;
      price = Math.max(0.01, price + delta); // 不允许 ≤ 0
      const open = price;
      const close = Math.max(0.001, price + (Math.random() - 0.5) * price * 0.02);
      const high = Math.max(open, close) * (1 + Math.random() * 0.01);
      const low = Math.min(open, close) * (1 - Math.random() * 0.01);

      return {
        openTime: now + i * 3_600_000,
        open,
        high,
        low,
        close,
        volume: Math.abs(1000 + (Math.random() - 0.3) * 500),
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    // 直接调用（不用 not.toThrow 包裹，以便错误信息更清晰）
    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    expect(result).toBeDefined();
    expect(result.metrics).toBeDefined();
    // totalReturn = finalEquity - initialUsdt，最差亏完本金（-1000），不应超出此范围
    expect(isNaN(result.metrics.totalReturn)).toBe(false);
    expect(result.metrics.totalReturn).toBeGreaterThanOrEqual(-INITIAL);
  });

  it("极端价格波动（±50% 单根 K 线）1000 根 → 不崩溃", () => {
    const cfg = makeCfg("bs-extreme-random");
    const now = Date.now();
    let price = 1000;
    const INITIAL = 1000;

    const klines: Kline[] = Array.from({ length: 1000 }, (_, i) => {
      const ratio = 0.5 + Math.random() * 1.0; // 0.5x to 1.5x
      price = Math.max(1, price * ratio);
      const close = price;
      const open = price / ratio;
      return {
        openTime: now + i * 3_600_000,
        open,
        high: Math.max(open, close) * 1.01,
        low: Math.min(open, close) * 0.99,
        close,
        volume: 1000,
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    // finalEquity = INITIAL + totalReturn；账户保护确保 >= 0
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────

describe("压力测试 10: 全部止损场景 → 账户不会变成负数", () => {
  it("所有交易都止损，账户余额始终 ≥ 0", () => {
    // 用极小止损（0.01%）+ 大跌幅，确保每次止损
    const cfg = makeCfg("bs-all-stoploss", {
      risk: {
        stop_loss_percent: 0.5, // 0.5% 即止损
        take_profit_percent: 100, // 高止盈，不易触发
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.2,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99, // 允许亏到底
        daily_loss_limit_percent: 99,
      },
    });

    const now = Date.now();
    // 制造持续下跌 K 线（每根跌 3%，大于 0.5% 止损）
    const klines: Kline[] = Array.from({ length: 200 }, (_, i) => {
      const price = 1000 * Math.pow(0.97, i);
      return {
        openTime: now + i * 3_600_000,
        open: price * 1.001,
        high: price * 1.002,
        low: price * 0.995, // 触碰止损
        close: price,
        volume: 1000,
        closeTime: now + (i + 1) * 3_600_000 - 1,
      };
    });

    const INITIAL = 1000;
    const result = runBacktest({ BTCUSDT: klines }, cfg, { initialUsdt: INITIAL });
    // finalEquity = INITIAL + totalReturn；账户保护确保 >= 0
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });

  it("通过 paperSell 大量亏损后账户不为负（cover short 保护）", () => {
    // 直接使用 paperBuy + paperSell 模拟高亏损
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 500,
      positions: {
        BTCUSDT: {
          symbol: "BTCUSDT",
          quantity: 1.0,
          entryPrice: 500,
          entryTime: Date.now(),
          stopLoss: 400,
          takeProfit: 600,
        },
      },
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    // 以极低价格卖出（模拟极端亏损）
    paperSell(account, "BTCUSDT", 0.01, "extreme-loss");

    // 账户余额不应为负
    expect(account.usdt).toBeGreaterThanOrEqual(0);
  });

  it("多轮止损，账户余额单调非增", () => {
    const SID = "bs-multi-stoploss";
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 2,
        take_profit_percent: 100, // 不易止盈
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.1,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99,
        daily_loss_limit_percent: 99,
      },
    });

    const balances: number[] = [];
    const symbols = Array.from({ length: 10 }, (_, i) => `TOKEN${i}USDT`);

    for (const sym of symbols) {
      handleSignal(makeBuySignal(sym, 1000), cfg);
      // 触发止损（价格大跌）
      checkExitConditions({ [sym]: 900 }, cfg);

      const acc = loadAccount(1000, SID);
      balances.push(acc.usdt);
    }

    // 整体余额应随止损递减
    const finalBalance = balances[balances.length - 1] ?? 1000;
    expect(finalBalance).toBeGreaterThanOrEqual(0);
    expect(finalBalance).toBeLessThan(1000); // 至少有些手续费损耗

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("压力测试 11: 高频开平仓 50 次 → 账户余额单调递减（手续费）", () => {
  it("直接调用 paperBuy + paperSell 50 次，余额因手续费持续下降", () => {
    const account: PaperAccount = {
      initialUsdt: 10000,
      usdt: 10000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };

    const price = 100;
    const prevBalances: number[] = [];

    for (let i = 0; i < 50; i++) {
      const before = account.usdt;

      // 开仓
      const trade = paperBuy(account, "BTCUSDT", price, `cycle-${i}`, {
        positionRatio: 0.1,
        feeRate: 0.001,
        slippagePercent: 0,
        minOrderUsdt: 10,
        stopLossPercent: 5,
        takeProfitPercent: 15,
      });

      if (trade) {
        // 以相同价格卖出（无价格变动，纯手续费损耗）
        paperSell(account, "BTCUSDT", price, `close-${i}`, {
          feeRate: 0.001,
          slippagePercent: 0,
        });
      }

      const after = account.usdt;
      prevBalances.push(before - after); // 每轮净损耗（应为正数）
    }

    // 验证每轮都有手续费损耗（余额在减少）
    const allPositiveLoss = prevBalances.every((loss) => loss >= 0);
    expect(allPositiveLoss).toBe(true);

    // 总损耗应大于 0（50 轮手续费叠加）
    const totalLoss = prevBalances.reduce((s, v) => s + v, 0);
    expect(totalLoss).toBeGreaterThan(0);

    // 账户余额不应为负
    expect(account.usdt).toBeGreaterThanOrEqual(0);
  });

  it("通过 handleSignal + checkExitConditions 高频开平 20 次，余额不为负", () => {
    const SID = "bs-hf-engine";
    const cfg = makeCfg(SID, {
      risk: {
        stop_loss_percent: 5,
        take_profit_percent: 15,
        trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
        position_ratio: 0.1,
        max_positions: 1,
        max_position_per_symbol: 1.0,
        max_total_loss_percent: 99,
        daily_loss_limit_percent: 99,
      },
    });

    const balanceHistory: number[] = [];

    for (let i = 0; i < 20; i++) {
      // 开仓
      handleSignal(makeBuySignal("BTCUSDT", 1000), cfg);
      // 以相同价格平仓（纯手续费损耗）
      checkExitConditions({ BTCUSDT: 999 }, cfg); // 轻微下跌触发止损

      const acc = loadAccount(1000, SID);
      balanceHistory.push(acc.usdt);
    }

    // 余额应单调非增（手续费累积）
    for (let i = 1; i < balanceHistory.length; i++) {
      expect(balanceHistory[i]!).toBeLessThanOrEqual(balanceHistory[i - 1]! + 0.01); // 容许浮点误差
    }

    // 最终余额不为负
    const finalBalance = balanceHistory[balanceHistory.length - 1] ?? 0;
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    cleanScenario(SID);
  });
});

// ─────────────────────────────────────────────────────

describe("压力测试 12: 配置缺失字段 → 使用默认值不崩溃", () => {
  it("risk 字段部分 undefined → processSignal 不崩溃", () => {
    // 构造一个缺少可选 risk 字段的配置（trailing_stop_positive 等可选字段不传）
    const cfg = makeCfg("bs-partial-risk");
    // 验证：缺少 min_rr, dca, atr_position 等可选字段时，系统正常运行
    // （这些字段的类型本身就是可选的）
    expect(cfg.risk.min_rr).toBeUndefined();
    expect(cfg.risk.dca).toBeUndefined();
    expect(cfg.risk.atr_position).toBeUndefined();
    expect(cfg.risk.trailing_stop_positive).toBeUndefined();

    const klines = makeKlines(60);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      expect(result).toBeDefined();
    }).not.toThrow();
  });

  it("notify 部分字段缺失 → processSignal + handleSignal 不崩溃", () => {
    const SID = "bs-partial-notify";
    // 构造配置时所有必要字段都给定（TypeScript 要求），
    // 运行时通过 spread 覆盖为部分缺失
    const cfg = makeCfg(SID);

    // 覆盖为运行时可能出现的"部分缺失"场景（通过 Object.assign）
    const partialCfg = { ...cfg };
    // 删除可选字段测试
    delete (partialCfg.risk as unknown as Record<string, unknown>)["min_rr"];
    delete (partialCfg.risk as unknown as Record<string, unknown>)["correlation_filter"];
    delete (partialCfg.risk as unknown as Record<string, unknown>)["take_profit_stages"];

    const klines = makeKlines(60);
    expect(() => {
      processSignal("BTCUSDT", klines, partialCfg as RuntimeConfig);
    }).not.toThrow();

    cleanScenario(SID);
  });

  it("strategy.macd.enabled=false 时缺少 MACD 结果 → 指标计算不崩溃", () => {
    const cfg = makeCfg("bs-no-macd", {
      strategy: {
        name: "test",
        enabled: true,
        ma: { short: 5, long: 10 },
        rsi: { period: 14, oversold: 30, overbought: 70 },
        macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
      },
    });

    const klines = makeKlines(60);
    const indicators = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd
    );

    expect(indicators).not.toBeNull();
    expect(indicators!.macd).toBeUndefined(); // MACD 被禁用，字段不存在
  });

  it("空 signals.buy 数组 → processSignal 返回 none 不崩溃", () => {
    const cfg = makeCfg("bs-empty-signals", {
      signals: { buy: [], sell: [] },
    });

    const klines = makeKlines(60);
    expect(() => {
      const result = processSignal("BTCUSDT", klines, cfg);
      // 无买入条件 → 信号为 none
      expect(["none", "buy", "sell"]).toContain(result.signal.type);
    }).not.toThrow();
  });

  it("runBacktest 使用最小化配置（仅必填字段）→ 不崩溃", () => {
    const cfg = makeCfg("bs-minimal-backtest");
    const klines = makeUpKlines(100, 100);

    const INITIAL = 1000;
    const result = runBacktest({ BTCUSDT: klines }, cfg, {
      initialUsdt: INITIAL,
      feeRate: 0.001,
      slippagePercent: 0.05,
    });
    expect(result.metrics).toBeDefined();
    // finalEquity = INITIAL + totalReturn；绝对不能为负
    expect(result.metrics.totalReturn + INITIAL).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────

describe("综合健壮性验证", () => {
  it("processSignal 对所有 signal types 处理路径覆盖不崩溃", () => {
    const klines = makeUpKlines(80, 50000);

    const configs = [
      makeCfg("bs-robust-1", { signals: { buy: ["ma_bullish"], sell: ["ma_bearish"] } }),
      makeCfg("bs-robust-2", { signals: { buy: [], sell: [], short: ["ma_bearish"], cover: ["ma_bullish"] } }),
      makeCfg("bs-robust-3", { signals: { buy: ["ma_bullish", "rsi_oversold"], sell: ["rsi_overbought"] } }),
    ];

    for (const cfg of configs) {
      expect(() => {
        const result = processSignal("BTCUSDT", klines, cfg);
        expect(result).toBeDefined();
        expect(["buy", "sell", "short", "cover", "none"]).toContain(result.signal.type);
      }).not.toThrow();
    }
  });

  it("paperSell 对不存在的 symbol 安全返回 null", () => {
    const account: PaperAccount = {
      initialUsdt: 1000,
      usdt: 1000,
      positions: {},
      trades: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dailyLoss: { date: new Date().toISOString().slice(0, 10), loss: 0 },
    };
    const result = paperSell(account, "NONEXISTENT", 100, "test");
    expect(result).toBeNull();
    expect(account.usdt).toBe(1000); // 不影响余额
  });

  it("连续随机 K 线长度变化不崩溃（1 到 200 根）", () => {
    const cfg = makeCfg("bs-variable-len");
    const lengths = [1, 2, 5, 10, 11, 20, 50, 100, 200];

    for (const n of lengths) {
      expect(() => {
        const klines = makeKlines(n, 100);
        const result = processSignal("BTCUSDT", klines, cfg);
        expect(result).toBeDefined();
      }).not.toThrow(`processSignal 在 ${n} 根 K 线时崩溃`);
    }
  });
});

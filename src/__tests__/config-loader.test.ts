import { describe, it, expect } from "vitest";
import { mergeRisk, mergeStrategySection } from "../config/loader.js";
import type { RiskConfig, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// 测试辅助
// ─────────────────────────────────────────────────────

function baseRisk(): RiskConfig {
  return {
    stop_loss_percent: 5,
    take_profit_percent: 10,
    trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 },
    max_total_loss_percent: 20,
    position_ratio: 0.2,
    max_positions: 4,
    max_position_per_symbol: 0.3,
    daily_loss_limit_percent: 8,
  };
}

function baseStrategy(): StrategyConfig["strategy"] {
  return {
    name: "base",
    enabled: true,
    ma: { short: 20, long: 60 },
    rsi: { period: 14, oversold: 35, overbought: 65 },
    macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
  };
}

// ─────────────────────────────────────────────────────
// mergeRisk — 风险配置三层合并
// ─────────────────────────────────────────────────────

describe("mergeRisk() - 基础合并", () => {
  it("无覆盖时返回原始配置", () => {
    const base = baseRisk();
    const merged = mergeRisk(base);
    expect(merged).toEqual(base);
  });

  it("单层覆盖：覆盖的字段生效，未覆盖的保持原值", () => {
    const base = baseRisk();
    const merged = mergeRisk(base, { stop_loss_percent: 3, position_ratio: 0.1 });
    expect(merged.stop_loss_percent).toBe(3);
    expect(merged.position_ratio).toBe(0.1);
    expect(merged.max_positions).toBe(4); // 原值保留
  });

  it("三层合并：后层覆盖前层", () => {
    const base = baseRisk();
    const layer1: Partial<RiskConfig> = { stop_loss_percent: 4 };
    const layer2: Partial<RiskConfig> = { stop_loss_percent: 2 };
    const merged = mergeRisk(base, layer1, layer2);
    expect(merged.stop_loss_percent).toBe(2); // layer2 优先
  });

  it("undefined 覆盖层被忽略", () => {
    const base = baseRisk();
    const merged = mergeRisk(base, undefined, { position_ratio: 0.15 }, undefined);
    expect(merged.position_ratio).toBe(0.15);
    expect(merged.stop_loss_percent).toBe(5); // 原值
  });

  it("trailing_stop 子字段深度合并", () => {
    const base = baseRisk(); // trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 }
    const override: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 3, callback_percent: 1.5 },
    };
    const merged = mergeRisk(base, override);
    expect(merged.trailing_stop.enabled).toBe(true);
    expect(merged.trailing_stop.activation_percent).toBe(3);
    expect(merged.trailing_stop.callback_percent).toBe(1.5);
  });

  it("trailing_stop 局部覆盖（只覆盖 enabled）", () => {
    const base = baseRisk();
    const override: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 5, callback_percent: 2 },
    };
    const merged = mergeRisk(base, override);
    // activation_percent 和 callback_percent 应保持原值
    expect(merged.trailing_stop.activation_percent).toBe(5);
    expect(merged.trailing_stop.callback_percent).toBe(2);
    expect(merged.trailing_stop.enabled).toBe(true);
  });

  it("覆盖不影响原始 base 对象（不可变性）", () => {
    const base = baseRisk();
    mergeRisk(base, { stop_loss_percent: 999 });
    expect(base.stop_loss_percent).toBe(5); // 原对象未被修改
  });
});

// ─────────────────────────────────────────────────────
// mergeStrategySection — 策略参数合并
// ─────────────────────────────────────────────────────

describe("mergeStrategySection() - 策略参数合并", () => {
  it("无 override 时返回 base 原值", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, undefined);
    expect(merged).toEqual(base);
  });

  it("MA 参数覆盖：short 改变，long 不变", () => {
    const base = baseStrategy();
    // mergeStrategySection 接收 StrategyProfile["strategy"]（内层对象），不含 name/strategy 包装
    const merged = mergeStrategySection(base, { ma: { short: 10, long: 30 } });
    expect(merged.ma.short).toBe(10);
    expect(merged.ma.long).toBe(30);
  });

  it("RSI 参数覆盖：oversold 改变", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, {
      rsi: { period: 14, oversold: 28, overbought: 72 },
    });
    expect(merged.rsi.oversold).toBe(28);
    expect(merged.rsi.overbought).toBe(72);
    expect(merged.rsi.period).toBe(14);
  });

  it("MACD 参数覆盖：禁用 MACD", () => {
    const base = baseStrategy(); // macd enabled: true
    const merged = mergeStrategySection(base, {
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    });
    expect(merged.macd.enabled).toBe(false);
  });

  it("profile.strategy 为空时，base 不被修改", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, undefined);
    expect(merged.ma.short).toBe(base.ma.short);
    expect(merged.rsi.oversold).toBe(base.rsi.oversold);
  });

  it("profile 的 name/enabled 不影响 base 的值", () => {
    const base = baseStrategy();
    base.enabled = true;
    const merged = mergeStrategySection(base, { ma: { short: 50, long: 200 } });
    // enabled 来自 base（profile 层不应覆盖）
    expect(merged.name).toBe("base"); // name 不被 profile 的覆盖
  });
});

// ─────────────────────────────────────────────────────
// 三层合并场景模拟
// ─────────────────────────────────────────────────────

describe("三层合并场景 - 优先级验证", () => {
  it("场景覆盖 > profile 覆盖 > 全局 base（止损）", () => {
    const global = baseRisk(); // stop_loss: 5
    const profileOverride: Partial<RiskConfig> = { stop_loss_percent: 4 }; // profile: 4
    const scenarioOverride: Partial<RiskConfig> = { stop_loss_percent: 2 }; // scenario: 2
    const merged = mergeRisk(global, profileOverride, scenarioOverride);
    expect(merged.stop_loss_percent).toBe(2);
  });

  it("场景未覆盖时 profile 值生效", () => {
    const global = baseRisk(); // position_ratio: 0.2
    const profileOverride: Partial<RiskConfig> = { position_ratio: 0.1 }; // profile: 0.1
    const merged = mergeRisk(global, profileOverride, undefined);
    expect(merged.position_ratio).toBe(0.1);
  });

  it("profile 和场景都未覆盖时 global 值生效", () => {
    const global = baseRisk(); // max_positions: 4
    const merged = mergeRisk(global, {}, {});
    expect(merged.max_positions).toBe(4);
  });

  it("trailing_stop 在三层中正确合并", () => {
    const global = baseRisk(); // trailing: disabled, activation: 5, callback: 2
    const profileOverride: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 5, callback_percent: 2 },
    };
    const scenarioOverride: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 3, callback_percent: 1.5 },
    };
    const merged = mergeRisk(global, profileOverride, scenarioOverride);
    expect(merged.trailing_stop.enabled).toBe(true);
    expect(merged.trailing_stop.activation_percent).toBe(3); // scenario 覆盖
    expect(merged.trailing_stop.callback_percent).toBe(1.5); // scenario 覆盖
  });
});

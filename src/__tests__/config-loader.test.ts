import { describe, it, expect } from "vitest";
import { mergeRisk, mergeStrategySection } from "../config/loader.js";
import type { RiskConfig, StrategyConfig } from "../types.js";

// ─────────────────────────────────────────────────────
// Test helpers
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
// mergeRisk — three-layer risk config merge
// ─────────────────────────────────────────────────────

describe("mergeRisk() - basic merge", () => {
  it("returns original config when no overrides", () => {
    const base = baseRisk();
    const merged = mergeRisk(base);
    expect(merged).toEqual(base);
  });

  it("single-layer override: overridden fields take effect, others keep original values", () => {
    const base = baseRisk();
    const merged = mergeRisk(base, { stop_loss_percent: 3, position_ratio: 0.1 });
    expect(merged.stop_loss_percent).toBe(3);
    expect(merged.position_ratio).toBe(0.1);
    expect(merged.max_positions).toBe(4); // original value preserved
  });

  it("three-layer merge: later layers override earlier ones", () => {
    const base = baseRisk();
    const layer1: Partial<RiskConfig> = { stop_loss_percent: 4 };
    const layer2: Partial<RiskConfig> = { stop_loss_percent: 2 };
    const merged = mergeRisk(base, layer1, layer2);
    expect(merged.stop_loss_percent).toBe(2); // layer2 takes priority
  });

  it("undefined override layers are ignored", () => {
    const base = baseRisk();
    const merged = mergeRisk(base, undefined, { position_ratio: 0.15 }, undefined);
    expect(merged.position_ratio).toBe(0.15);
    expect(merged.stop_loss_percent).toBe(5); // original value
  });

  it("trailing_stop sub-fields deep merged", () => {
    const base = baseRisk(); // trailing_stop: { enabled: false, activation_percent: 5, callback_percent: 2 }
    const override: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 3, callback_percent: 1.5 },
    };
    const merged = mergeRisk(base, override);
    expect(merged.trailing_stop.enabled).toBe(true);
    expect(merged.trailing_stop.activation_percent).toBe(3);
    expect(merged.trailing_stop.callback_percent).toBe(1.5);
  });

  it("trailing_stop partial override (only enabled)", () => {
    const base = baseRisk();
    const override: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 5, callback_percent: 2 },
    };
    const merged = mergeRisk(base, override);
    // activation_percent and callback_percent should keep original values
    expect(merged.trailing_stop.activation_percent).toBe(5);
    expect(merged.trailing_stop.callback_percent).toBe(2);
    expect(merged.trailing_stop.enabled).toBe(true);
  });

  it("override does not mutate original base object (immutability)", () => {
    const base = baseRisk();
    mergeRisk(base, { stop_loss_percent: 999 });
    expect(base.stop_loss_percent).toBe(5); // original object not modified
  });
});

// ─────────────────────────────────────────────────────
// mergeStrategySection — strategy parameter merge
// ─────────────────────────────────────────────────────

describe("mergeStrategySection() - strategy parameter merge", () => {
  it("returns base original value when no override", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, undefined);
    expect(merged).toEqual(base);
  });

  it("MA parameter override: short changes, long unchanged", () => {
    const base = baseStrategy();
    // mergeStrategySection receives StrategyProfile["strategy"] (inner object), not wrapped with name/strategy
    const merged = mergeStrategySection(base, { ma: { short: 10, long: 30 } });
    expect(merged.ma.short).toBe(10);
    expect(merged.ma.long).toBe(30);
  });

  it("RSI parameter override: oversold changes", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, {
      rsi: { period: 14, oversold: 28, overbought: 72 },
    });
    expect(merged.rsi.oversold).toBe(28);
    expect(merged.rsi.overbought).toBe(72);
    expect(merged.rsi.period).toBe(14);
  });

  it("MACD parameter override: disable MACD", () => {
    const base = baseStrategy(); // macd enabled: true
    const merged = mergeStrategySection(base, {
      macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    });
    expect(merged.macd.enabled).toBe(false);
  });

  it("profile.strategy is empty -> base not modified", () => {
    const base = baseStrategy();
    const merged = mergeStrategySection(base, undefined);
    expect(merged.ma.short).toBe(base.ma.short);
    expect(merged.rsi.oversold).toBe(base.rsi.oversold);
  });

  it("profile name/enabled does not affect base values", () => {
    const base = baseStrategy();
    base.enabled = true;
    const merged = mergeStrategySection(base, { ma: { short: 50, long: 200 } });
    // enabled comes from base (profile layer should not override)
    expect(merged.name).toBe("base"); // name not overridden by profile
  });
});

// ─────────────────────────────────────────────────────
// Three-layer merge scenario simulation
// ─────────────────────────────────────────────────────

describe("Three-layer merge scenario — priority verification", () => {
  it("scenario override > profile override > global base (stop loss)", () => {
    const global = baseRisk(); // stop_loss: 5
    const profileOverride: Partial<RiskConfig> = { stop_loss_percent: 4 }; // profile: 4
    const scenarioOverride: Partial<RiskConfig> = { stop_loss_percent: 2 }; // scenario: 2
    const merged = mergeRisk(global, profileOverride, scenarioOverride);
    expect(merged.stop_loss_percent).toBe(2);
  });

  it("profile value takes effect when scenario does not override", () => {
    const global = baseRisk(); // position_ratio: 0.2
    const profileOverride: Partial<RiskConfig> = { position_ratio: 0.1 }; // profile: 0.1
    const merged = mergeRisk(global, profileOverride, undefined);
    expect(merged.position_ratio).toBe(0.1);
  });

  it("global value takes effect when neither profile nor scenario override", () => {
    const global = baseRisk(); // max_positions: 4
    const merged = mergeRisk(global, {}, {});
    expect(merged.max_positions).toBe(4);
  });

  it("trailing_stop merges correctly across three layers", () => {
    const global = baseRisk(); // trailing: disabled, activation: 5, callback: 2
    const profileOverride: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 5, callback_percent: 2 },
    };
    const scenarioOverride: Partial<RiskConfig> = {
      trailing_stop: { enabled: true, activation_percent: 3, callback_percent: 1.5 },
    };
    const merged = mergeRisk(global, profileOverride, scenarioOverride);
    expect(merged.trailing_stop.enabled).toBe(true);
    expect(merged.trailing_stop.activation_percent).toBe(3); // scenario override
    expect(merged.trailing_stop.callback_percent).toBe(1.5); // scenario override
  });
});

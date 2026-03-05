/**
 * Configuration Loader
 * Priority (high -> low): scenario override > strategy profile > strategy.yaml global defaults
 * Generates RuntimeConfig for use by all modules
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import type {
  StrategyConfig,
  StrategyProfile,
  PaperFileConfig,
  PaperScenario,
  LiveConfig,
  RuntimeConfig,
  RiskConfig,
  ExchangeConfig,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "../../config");

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function readYaml<T>(filePath: string): T {
  return parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function loadStrategyConfig(): StrategyConfig {
  return readYaml<StrategyConfig>(path.join(CONFIG_DIR, "strategy.yaml"));
}

export function loadPaperConfig(): PaperFileConfig {
  return readYaml<PaperFileConfig>(path.join(CONFIG_DIR, "paper.yaml"));
}

export function loadLiveConfig(): LiveConfig {
  return readYaml<LiveConfig>(path.join(CONFIG_DIR, "live.yaml"));
}

export function loadStrategyProfile(strategyId: string): StrategyProfile {
  const filePath = path.join(CONFIG_DIR, "strategies", `${strategyId}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Strategy file not found: config/strategies/${strategyId}.yaml`);
  }
  return readYaml<StrategyProfile>(filePath);
}

/** List all available strategies */
export function listStrategyProfiles(): string[] {
  const dir = path.join(CONFIG_DIR, "strategies");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(".yaml", ""));
}

// ─────────────────────────────────────────────────────
// Merge utilities (exported for testing)
// ─────────────────────────────────────────────────────

export function mergeRisk(
  base: RiskConfig,
  ...overrides: (Partial<RiskConfig> | undefined)[]
): RiskConfig {
  let result = { ...base };
  for (const override of overrides) {
    if (!override) continue;
    result = {
      ...result,
      ...override,
      // Deep merge all nested objects to avoid losing base fields when override only specifies partial fields
      trailing_stop: {
        ...result.trailing_stop,
        ...(override.trailing_stop ?? {}),
      },
      // exactOptionalPropertyTypes: only set optional nested objects when they have values (deep merge)
      ...(result.atr_position !== undefined || override.atr_position !== undefined
        ? ({ atr_position: { ...result.atr_position, ...override.atr_position } } as Pick<RiskConfig, "atr_position">)
        : {}),
      ...(result.correlation_filter !== undefined || override.correlation_filter !== undefined
        ? ({ correlation_filter: { ...result.correlation_filter, ...override.correlation_filter } } as Pick<RiskConfig, "correlation_filter">)
        : {}),
    };
  }
  return result;
}

export function mergeStrategySection(
  base: StrategyConfig["strategy"],
  override?: StrategyProfile["strategy"]
): StrategyConfig["strategy"] {
  if (!override) return base;
  const mergedVolume = override.volume
    ? { ...(base.volume ?? { surge_ratio: 1.5, low_ratio: 0.5 }), ...override.volume }
    : base.volume;

  return {
    ...base,
    ma: { ...base.ma, ...(override.ma ?? {}) },
    rsi: { ...base.rsi, ...(override.rsi ?? {}) },
    macd: { ...base.macd, ...(override.macd ?? {}) },
    // exactOptionalPropertyTypes: only set volume when it has a value
    ...(mergedVolume !== undefined ? { volume: mergedVolume } : {}),
  };
}

// ─────────────────────────────────────────────────────
// Build RuntimeConfig
// ─────────────────────────────────────────────────────

/**
 * Build complete RuntimeConfig for a single paper scenario
 * Priority: scenario > strategy profile > strategy.yaml
 */
export function buildPaperRuntime(
  base: StrategyConfig,
  paperCfg: PaperFileConfig,
  scenario: PaperScenario
): RuntimeConfig {
  const profile = loadStrategyProfile(scenario.strategy_id);

  // symbols: scenario > profile > global
  const symbols = scenario.symbols ?? profile.symbols ?? base.symbols;

  // timeframe: profile > global
  const timeframe = profile.timeframe ?? base.timeframe;

  // trend_timeframe: profile > global (optional, for MTF trend filtering)
  const trend_timeframe = profile.trend_timeframe ?? base.trend_timeframe;

  // strategy section: profile overrides global
  const strategy = mergeStrategySection(base.strategy, profile.strategy);

  // signals: profile > global (short/cover only override when configured and non-empty array)
  const signals: StrategyConfig["signals"] = {
    buy: profile.signals?.buy ?? base.signals.buy,
    sell: profile.signals?.sell ?? base.signals.sell,
    ...(profile.signals?.short !== undefined
      ? { short: profile.signals.short }
      : base.signals.short !== undefined
        ? { short: base.signals.short }
        : {}),
    ...(profile.signals?.cover !== undefined
      ? { cover: profile.signals.cover }
      : base.signals.cover !== undefined
        ? { cover: base.signals.cover }
        : {}),
  };

  // risk: scenario override > profile override > global
  const risk = mergeRisk(base.risk, profile.risk, scenario.risk);

  // exchange
  const exchange: ExchangeConfig = {
    name: "binance",
    credentials_path: ".secrets/binance.json",
    ...scenario.exchange,
  };

  return {
    ...base,
    symbols,
    timeframe,
    ...(trend_timeframe !== undefined ? { trend_timeframe } : {}),
    strategy,
    signals,
    risk,
    exchange,
    // F4: pass strategy plugin ID (from profile > base, default undefined = "default")
    ...(profile.strategy_id !== undefined
      ? { strategy_id: profile.strategy_id }
      : base.strategy_id !== undefined
        ? { strategy_id: base.strategy_id }
        : {}),
    paper: {
      scenarioId: scenario.id,
      initial_usdt: scenario.initial_usdt,
      fee_rate: scenario.fee_rate,
      slippage_percent: scenario.slippage_percent,
      report_interval_hours: paperCfg.report_interval_hours,
    },
  };
}

/**
 * Build RuntimeConfig for live trading
 */
export function buildLiveRuntime(base: StrategyConfig, live: LiveConfig): RuntimeConfig {
  const { name, credentials_path, ...restExchange } = live.exchange;
  return {
    ...base,
    exchange: {
      name,
      credentials_path,
      ...restExchange,
    },
    symbols: live.symbols ?? base.symbols,
    risk: mergeRisk(base.risk, live.risk),
    paper: {
      scenarioId: "live",
      initial_usdt: 0,
      fee_rate: 0,
      slippage_percent: 0,
      report_interval_hours: 0,
    },
  };
}

/**
 * Load RuntimeConfig for all enabled scenarios
 */
export function loadEnabledPaperRuntimes(): RuntimeConfig[] {
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();
  return paperCfg.scenarios
    .filter((s) => s.enabled)
    .map((s) => buildPaperRuntime(base, paperCfg, s));
}

/**
 * Dispatch loading based on current mode
 */
export function loadRuntimeConfigs(): RuntimeConfig[] {
  const base = loadStrategyConfig();

  if (base.mode === "paper") {
    const runtimes = loadEnabledPaperRuntimes();
    if (runtimes.length === 0) {
      throw new Error("No scenarios with enabled: true found in paper.yaml, please enable at least one");
    }
    return runtimes;
  }

  if (base.mode === "auto") {
    return [buildLiveRuntime(base, loadLiveConfig())];
  }

  return [
    {
      ...base,
      exchange: { market: "spot" },
      paper: {
        scenarioId: "notify",
        initial_usdt: 0,
        fee_rate: 0,
        slippage_percent: 0,
        report_interval_hours: 0,
      },
    },
  ];
}

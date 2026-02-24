/**
 * 配置加载器
 * 优先级（高→低）：场景覆盖 > 策略 profile > strategy.yaml 全局默认
 * 最终生成 RuntimeConfig 供各模块使用
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
    throw new Error(`策略文件不存在: config/strategies/${strategyId}.yaml`);
  }
  return readYaml<StrategyProfile>(filePath);
}

/** 列出所有可用策略 */
export function listStrategyProfiles(): string[] {
  const dir = path.join(CONFIG_DIR, "strategies");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(".yaml", ""));
}

// ─────────────────────────────────────────────────────
// 合并工具（导出供测试使用）
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
      // 深合并所有嵌套对象，避免 override 只写部分字段时丢失 base 的其他字段
      trailing_stop: {
        ...result.trailing_stop,
        ...(override.trailing_stop ?? {}),
      },
      // exactOptionalPropertyTypes: 只在有值时设置可选嵌套对象（深合并）
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
    // exactOptionalPropertyTypes: 只在有值时才设置 volume
    ...(mergedVolume !== undefined ? { volume: mergedVolume } : {}),
  };
}

// ─────────────────────────────────────────────────────
// 构建 RuntimeConfig
// ─────────────────────────────────────────────────────

/**
 * 为单个 paper scenario 构建完整 RuntimeConfig
 * 优先级：scenario > strategy profile > strategy.yaml
 */
export function buildPaperRuntime(
  base: StrategyConfig,
  paperCfg: PaperFileConfig,
  scenario: PaperScenario
): RuntimeConfig {
  const profile = loadStrategyProfile(scenario.strategy_id);

  // symbols：场景 > profile > 全局
  const symbols = scenario.symbols ?? profile.symbols ?? base.symbols;

  // timeframe：profile > 全局
  const timeframe = profile.timeframe ?? base.timeframe;

  // trend_timeframe：profile > 全局（可选，用于 MTF 趋势过滤）
  const trend_timeframe = profile.trend_timeframe ?? base.trend_timeframe;

  // strategy section：profile 覆盖全局
  const strategy = mergeStrategySection(base.strategy, profile.strategy);

  // signals：profile > 全局（short/cover 仅在配置了且为非空数组时覆盖）
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

  // risk：场景覆盖 > profile 覆盖 > 全局
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
 * 为实盘构建 RuntimeConfig
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
 * 加载所有启用场景的 RuntimeConfig
 */
export function loadEnabledPaperRuntimes(): RuntimeConfig[] {
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();
  return paperCfg.scenarios
    .filter((s) => s.enabled)
    .map((s) => buildPaperRuntime(base, paperCfg, s));
}

/**
 * 按当前 mode 分发加载
 */
export function loadRuntimeConfigs(): RuntimeConfig[] {
  const base = loadStrategyConfig();

  if (base.mode === "paper") {
    const runtimes = loadEnabledPaperRuntimes();
    if (runtimes.length === 0) {
      throw new Error("paper.yaml 中没有 enabled: true 的场景，请至少启用一个");
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

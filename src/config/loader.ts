/**
 * 配置加载器
 * 负责加载和合并 strategy.yaml + paper.yaml / live.yaml
 * 生成 RuntimeConfig 供各模块使用
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import type {
  StrategyConfig,
  PaperFileConfig,
  PaperScenario,
  LiveConfig,
  RuntimeConfig,
  RiskConfig,
  ExchangeConfig,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "../../config");

function readYaml<T>(filename: string): T {
  const filePath = path.join(CONFIG_DIR, filename);
  return parse(fs.readFileSync(filePath, "utf-8")) as T;
}

/** 加载核心策略配置 */
export function loadStrategyConfig(): StrategyConfig {
  return readYaml<StrategyConfig>("strategy.yaml");
}

/** 加载模拟盘配置 */
export function loadPaperConfig(): PaperFileConfig {
  return readYaml<PaperFileConfig>("paper.yaml");
}

/** 加载实盘配置 */
export function loadLiveConfig(): LiveConfig {
  return readYaml<LiveConfig>("live.yaml");
}

// ─────────────────────────────────────────────────────
// 深合并工具：将 override 的非 undefined 字段覆盖到 base
// ─────────────────────────────────────────────────────

function mergeRisk(base: RiskConfig, override?: Partial<RiskConfig>): RiskConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    trailing_stop: {
      ...base.trailing_stop,
      ...(override.trailing_stop ?? {}),
    },
  };
}

// ─────────────────────────────────────────────────────
// 合并成 RuntimeConfig
// ─────────────────────────────────────────────────────

/**
 * 为某个 paper scenario 生成完整的 RuntimeConfig
 * 优先级：scenario.risk > strategy.risk
 *         scenario.symbols > strategy.symbols
 */
export function buildPaperRuntime(
  strategy: StrategyConfig,
  paperCfg: PaperFileConfig,
  scenario: PaperScenario
): RuntimeConfig {
  // leverage 字段：优先 scenario 顶层 leverage，否则 exchange.leverage
  const leverage = scenario.leverage ?? scenario.exchange.leverage ?? {
    enabled: false,
    default: 1,
    max: 1,
  };

  const exchange: ExchangeConfig = {
    name: "binance",
    credentials_path: ".secrets/binance.json",
    ...scenario.exchange,
    leverage,
  };

  return {
    ...strategy,
    exchange,
    symbols: scenario.symbols ?? strategy.symbols,
    risk: mergeRisk(strategy.risk, scenario.risk),
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
 * 为实盘生成 RuntimeConfig
 */
export function buildLiveRuntime(
  strategy: StrategyConfig,
  live: LiveConfig
): RuntimeConfig {
  const { name, credentials_path, ...restExchange } = live.exchange;
  return {
    ...strategy,
    exchange: {
      name: name ?? "binance",
      credentials_path: credentials_path ?? ".secrets/binance.json",
      ...restExchange,
    },
    symbols: live.symbols ?? strategy.symbols,
    risk: mergeRisk(strategy.risk, live.risk),
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
 * 加载所有启用的模拟盘运行时配置
 */
export function loadEnabledPaperRuntimes(): RuntimeConfig[] {
  const strategy = loadStrategyConfig();
  const paperCfg = loadPaperConfig();
  return paperCfg.scenarios
    .filter((s) => s.enabled)
    .map((s) => buildPaperRuntime(strategy, paperCfg, s));
}

/**
 * 根据当前 mode 加载对应的运行时配置列表
 * - paper → 返回所有启用的场景（1+个）
 * - auto  → 返回单个实盘配置
 * - notify_only → 返回策略配置（无 exchange）
 */
export function loadRuntimeConfigs(): RuntimeConfig[] {
  const strategy = loadStrategyConfig();

  if (strategy.mode === "paper") {
    const runtimes = loadEnabledPaperRuntimes();
    if (runtimes.length === 0) {
      throw new Error("paper.yaml 中没有 enabled: true 的场景，请至少启用一个");
    }
    return runtimes;
  }

  if (strategy.mode === "auto") {
    const live = loadLiveConfig();
    return [buildLiveRuntime(strategy, live)];
  }

  // notify_only: 不需要 exchange，返回带默认 paper 字段的 config
  return [{
    ...strategy,
    exchange: { market: "spot" },
    paper: { scenarioId: "notify", initial_usdt: 0, fee_rate: 0, slippage_percent: 0, report_interval_hours: 0 },
  }];
}

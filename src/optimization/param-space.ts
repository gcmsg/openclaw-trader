/**
 * P6.1 Hyperopt — 参数空间定义
 *
 * 定义策略参数的可搜索范围，供贝叶斯优化引擎使用。
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface ParamDef {
  name: string;
  type: "int" | "float";
  min: number;
  max: number;
  step?: number; // int 类型的步长（float 忽略）
}

export interface ParamSet {
  [key: string]: number;
}

// ─────────────────────────────────────────────────────
// 默认策略可优化参数空间
// ─────────────────────────────────────────────────────

/**
 * DEFAULT_PARAM_SPACE：8 维参数搜索空间
 *
 * 覆盖 MA 周期、RSI 参数、止损/止盈比例、仓位大小。
 * 约束：ma_short < ma_long（在 objective.ts 中验证）
 */
export const DEFAULT_PARAM_SPACE: ParamDef[] = [
  { name: "ma_short",        type: "int",   min: 5,    max: 50,   step: 1 },
  { name: "ma_long",         type: "int",   min: 20,   max: 200,  step: 5 },
  { name: "rsi_period",      type: "int",   min: 7,    max: 21,   step: 1 },
  { name: "rsi_overbought",  type: "float", min: 60,   max: 80              },
  { name: "rsi_oversold",    type: "float", min: 20,   max: 40              },
  { name: "stop_loss_pct",   type: "float", min: 2,    max: 10              },
  { name: "take_profit_pct", type: "float", min: 5,    max: 30              },
  { name: "position_ratio",  type: "float", min: 0.1,  max: 0.4             },
];

// ─────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────

/**
 * 将连续值 [0,1] 映射到参数实际值
 * int 类型用 step 对齐
 */
export function decodeParam(def: ParamDef, unit: number): number {
  const raw = def.min + unit * (def.max - def.min);
  if (def.type === "int") {
    const step = def.step ?? 1;
    return Math.round(raw / step) * step;
  }
  return raw;
}

/**
 * 将参数实际值编码回 [0,1]
 */
export function encodeParam(def: ParamDef, value: number): number {
  const range = def.max - def.min;
  if (range === 0) return 0;
  return Math.max(0, Math.min(1, (value - def.min) / range));
}

/**
 * 随机采样一组参数（uniform）
 */
export function sampleRandom(space: ParamDef[], rng: () => number): ParamSet {
  const params: ParamSet = {};
  for (const def of space) {
    params[def.name] = decodeParam(def, rng());
  }
  return params;
}

/**
 * 对参数集做小扰动（用于精英进化）
 * @param base   基础参数
 * @param space  参数空间定义
 * @param sigma  扰动幅度（单位空间，默认 0.1）
 * @param rng    随机数生成器
 */
export function perturbParams(
  base: ParamSet,
  space: ParamDef[],
  sigma: number,
  rng: () => number
): ParamSet {
  const result: ParamSet = {};
  for (const def of space) {
    const encoded = encodeParam(def, base[def.name] ?? def.min);
    const noise = (rng() - 0.5) * 2 * sigma;
    const newUnit = Math.max(0, Math.min(1, encoded + noise));
    result[def.name] = decodeParam(def, newUnit);
  }
  return result;
}

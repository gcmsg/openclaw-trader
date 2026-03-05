/**
 * P6.1 Hyperopt — Parameter Space Definition
 *
 * Defines searchable ranges for strategy parameters, used by the Bayesian optimization engine.
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface ParamDef {
  name: string;
  type: "int" | "float";
  min: number;
  max: number;
  step?: number; // Step size for int type (ignored for float)
}

export type ParamSet = Record<string, number>;

// ─────────────────────────────────────────────────────
// Default optimizable parameter space
// ─────────────────────────────────────────────────────

/**
 * DEFAULT_PARAM_SPACE: 8-dimensional parameter search space
 *
 * Covers MA periods, RSI parameters, stop-loss/take-profit ratios, position size.
 * Constraint: ma_short < ma_long (validated in objective.ts)
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
// Utility functions
// ─────────────────────────────────────────────────────

/**
 * Map continuous value [0,1] to actual parameter value.
 * Int types are aligned to step size.
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
 * Encode actual parameter value back to [0,1].
 */
export function encodeParam(def: ParamDef, value: number): number {
  const range = def.max - def.min;
  if (range === 0) return 0;
  return Math.max(0, Math.min(1, (value - def.min) / range));
}

/**
 * Randomly sample a set of parameters (uniform distribution).
 */
export function sampleRandom(space: ParamDef[], rng: () => number): ParamSet {
  const params: ParamSet = {};
  for (const def of space) {
    params[def.name] = decodeParam(def, rng());
  }
  return params;
}

/**
 * Apply small perturbation to parameter set (for elite evolution).
 * @param base   Base parameters
 * @param space  Parameter space definition
 * @param sigma  Perturbation magnitude (unit space, default 0.1)
 * @param rng    Random number generator
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

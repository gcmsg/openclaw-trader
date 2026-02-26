/**
 * P6.1 Hyperopt — 优化引擎
 *
 * 实现简化版 TPE（Tree-structured Parzen Estimator）+ 精英进化混合策略：
 * - 前 N 次（warm-up）随机采样
 * - 之后使用 EI（Expected Improvement）+ 精英进化双轨并行
 * - 不依赖任何外部 ML 库，纯 TypeScript 实现
 */

import type { ParamDef, ParamSet } from "./param-space.js";
import { sampleRandom, perturbParams, encodeParam } from "./param-space.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

interface Observation {
  params: ParamSet;
  score: number;
}

// ─────────────────────────────────────────────────────
// 简单 LCG 伪随机数生成器（可复现）
// ─────────────────────────────────────────────────────

class LCG {
  private state: number;

  constructor(seed: number = Date.now()) {
    this.state = seed >>> 0; // 强制转 uint32
  }

  /** 返回 [0, 1) 的浮点数 */
  next(): number {
    // Park-Miller LCG（32 位）
    this.state = Math.imul(this.state, 1664525) + 1013904223;
    this.state = this.state >>> 0; // 确保 uint32
    return this.state / 0x100000000;
  }
}

// ─────────────────────────────────────────────────────
// 高斯核密度估计（KDE）
// ─────────────────────────────────────────────────────

/**
 * 计算给定点 x 在观测集合 xs 的 KDE 概率密度（高斯核）
 * 带宽用 Silverman 规则估计
 */
function kdeLog(x: number, xs: number[]): number {
  if (xs.length === 0) return Math.log(1e-10);
  const n = xs.length;
  // Silverman's rule: h = 1.06 * std * n^(-1/5)
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  const h = Math.max(1e-4, 1.06 * std * Math.pow(n, -0.2));

  let sum = 0;
  for (const xi of xs) {
    const z = (x - xi) / h;
    sum += Math.exp(-0.5 * z * z);
  }
  const density = sum / (n * h * Math.sqrt(2 * Math.PI));
  return Math.log(Math.max(density, 1e-10));
}

// ─────────────────────────────────────────────────────
// Expected Improvement（EI）计算
// ─────────────────────────────────────────────────────

/**
 * 计算候选参数在单维度上的 EI 近似（TPE 方式）
 *
 * EI ≈ l(x) / g(x)，其中：
 *   l(x) = 好点（top gamma）的 KDE 密度
 *   g(x) = 坏点（bottom 1-gamma）的 KDE 密度
 *
 * @param x       候选值（单位空间 [0,1]）
 * @param goodXs  好点在此维度的编码值数组
 * @param badXs   坏点在此维度的编码值数组
 */
function eiScore(x: number, goodXs: number[], badXs: number[]): number {
  const logL = kdeLog(x, goodXs);
  const logG = kdeLog(x, badXs);
  return logL - logG; // log EI
}

// ─────────────────────────────────────────────────────
// BayesianOptimizer
// ─────────────────────────────────────────────────────

export class BayesianOptimizer {
  private readonly space: ParamDef[];
  private readonly rng: LCG;
  private history: Observation[] = [];

  /** 随机预热次数 */
  private readonly warmup: number;
  /** 精英比例（top gamma 为好点） */
  private readonly gamma: number;
  /** 候选池大小 */
  private readonly candidatePool: number;

  constructor(space: ParamDef[], seed?: number, warmup = 20) {
    this.space = space;
    this.rng = new LCG(seed);
    this.warmup = warmup;
    this.gamma = 0.25;      // top 25% 视为好点
    this.candidatePool = 128;
  }

  // ─────────────────────────────────────────────────
  // 公开 API
  // ─────────────────────────────────────────────────

  /**
   * 建议下一组待评估的参数。
   * - 预热阶段（< warmup）：纯随机采样
   * - 之后：TPE + 精英进化混合
   */
  suggest(): ParamSet {
    if (this.history.length < this.warmup) {
      return sampleRandom(this.space, () => this.rng.next());
    }

    return this.suggestByEI();
  }

  /**
   * 记录一次观测结果。
   */
  observe(params: ParamSet, score: number): void {
    this.history.push({ params, score });
  }

  /**
   * 返回历史最优（score 最高）的参数与分数。
   * 如果无观测历史，返回 null。
   */
  best(): { params: ParamSet; score: number } | null {
    if (this.history.length === 0) return null;
    let best = this.history[0]!;
    for (const obs of this.history) {
      if (obs.score > best.score) best = obs;
    }
    return { params: { ...best.params }, score: best.score };
  }

  /** 返回历史观测次数 */
  get trialCount(): number {
    return this.history.length;
  }

  /** 返回所有历史观测（用于保存结果） */
  getHistory(): Observation[] {
    return [...this.history];
  }

  // ─────────────────────────────────────────────────
  // 内部实现
  // ─────────────────────────────────────────────────

  private suggestByEI(): ParamSet {
    const sorted = [...this.history].sort((a, b) => b.score - a.score);
    const nGood = Math.max(1, Math.floor(sorted.length * this.gamma));
    const goodObs = sorted.slice(0, nGood);
    const badObs  = sorted.slice(nGood);

    // 构建候选池：50% 随机 + 50% 精英扰动
    const candidates: ParamSet[] = [];
    const halfPool = Math.floor(this.candidatePool / 2);

    // 随机候选
    for (let i = 0; i < halfPool; i++) {
      candidates.push(sampleRandom(this.space, () => this.rng.next()));
    }

    // 精英扰动候选
    for (let i = 0; i < this.candidatePool - halfPool; i++) {
      const elite = goodObs[i % goodObs.length];
      if (elite) {
        candidates.push(perturbParams(
          elite.params,
          this.space,
          0.1 + this.rng.next() * 0.1, // sigma: 0.1~0.2
          () => this.rng.next()
        ));
      } else {
        candidates.push(sampleRandom(this.space, () => this.rng.next()));
      }
    }

    // 为每个候选计算 EI 分数（各维度 EI 相加）
    const goodEncodings = this.encodeObservations(goodObs);
    const badEncodings  = this.encodeObservations(badObs);

    let bestCandidate = candidates[0]!;
    let bestEI = -Infinity;

    for (const candidate of candidates) {
      let totalEI = 0;
      for (let di = 0; di < this.space.length; di++) {
        const def = this.space[di]!;
        const x = encodeParam(def, candidate[def.name] ?? def.min);
        totalEI += eiScore(
          x,
          goodEncodings[di] ?? [],
          badEncodings[di]  ?? []
        );
      }
      if (totalEI > bestEI) {
        bestEI = totalEI;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  }

  /** 将观测集合各维度编码为 [0,1] 数组 */
  private encodeObservations(obs: Observation[]): number[][] {
    return this.space.map((def) =>
      obs.map((o) => encodeParam(def, o.params[def.name] ?? def.min))
    );
  }
}

// ─────────────────────────────────────────────────────
// Walk-Forward 数据分割工具
// ─────────────────────────────────────────────────────

/**
 * 将 K 线数据按比例分割为训练集和测试集（时序分割，不打乱）
 *
 * @param klines       全量 K 线
 * @param trainRatio   训练集比例（默认 0.7 = 70%）
 * @returns            { train, test }
 */
export function splitKlines(
  klines: Kline[],
  trainRatio = 0.7
): { train: Kline[]; test: Kline[] } {
  const splitIdx = Math.floor(klines.length * trainRatio);
  return {
    train: klines.slice(0, splitIdx),
    test:  klines.slice(splitIdx),
  };
}

// 导入 Kline 类型（仅 splitKlines 用到）
import type { Kline } from "../types.js";

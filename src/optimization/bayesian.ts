/**
 * P6.1 Hyperopt — Optimization Engine
 *
 * Implements simplified TPE (Tree-structured Parzen Estimator) + elite evolution hybrid strategy:
 * - First N iterations (warm-up): random sampling
 * - Afterwards: EI (Expected Improvement) + elite evolution dual-track parallel
 * - No external ML library dependency, pure TypeScript implementation
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
// Simple LCG pseudo-random number generator (reproducible)
// ─────────────────────────────────────────────────────

class LCG {
  private state: number;

  constructor(seed: number = Date.now()) {
    this.state = seed >>> 0; // Force cast to uint32
  }

  /** Return [0, 1) float */
  next(): number {
    // Park-Miller LCG (32-bit)
    this.state = Math.imul(this.state, 1664525) + 1013904223;
    this.state = this.state >>> 0; // Ensure uint32
    return this.state / 0x100000000;
  }
}

// ─────────────────────────────────────────────────────
// Gaussian Kernel Density Estimation (KDE)
// ─────────────────────────────────────────────────────

/**
 * Calculate KDE probability density (Gaussian kernel) of point x given observations xs.
 * Bandwidth estimated using Silverman's rule.
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
// Expected Improvement (EI) calculation
// ─────────────────────────────────────────────────────

/**
 * Calculate per-dimension EI approximation for a candidate (TPE approach).
 *
 * EI ~ l(x) / g(x), where:
 *   l(x) = KDE density of good points (top gamma)
 *   g(x) = KDE density of bad points (bottom 1-gamma)
 *
 * @param x       Candidate value (unit space [0,1])
 * @param goodXs  Good points' encoded values in this dimension
 * @param badXs   Bad points' encoded values in this dimension
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

  /** Random warm-up iterations */
  private readonly warmup: number;
  /** Elite ratio (top gamma are good points) */
  private readonly gamma: number;
  /** Candidate pool size */
  private readonly candidatePool: number;

  constructor(space: ParamDef[], seed?: number, warmup = 20) {
    this.space = space;
    this.rng = new LCG(seed);
    this.warmup = warmup;
    this.gamma = 0.25;      // top 25% treated as good points
    this.candidatePool = 128;
  }

  // ─────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────

  /**
   * Suggest the next set of parameters to evaluate.
   * - Warm-up phase (< warmup): pure random sampling
   * - Afterwards: TPE + elite evolution hybrid
   */
  suggest(): ParamSet {
    if (this.history.length < this.warmup) {
      return sampleRandom(this.space, () => this.rng.next());
    }

    return this.suggestByEI();
  }

  /**
   * Record an observation result.
   */
  observe(params: ParamSet, score: number): void {
    this.history.push({ params, score });
  }

  /**
   * Return the best (highest score) parameters and score from history.
   * Returns null if no observations have been made.
   */
  best(): { params: ParamSet; score: number } | null {
    if (this.history.length === 0) return null;
    let best = this.history[0]!;
    for (const obs of this.history) {
      if (obs.score > best.score) best = obs;
    }
    return { params: { ...best.params }, score: best.score };
  }

  /** Return the number of historical observations */
  get trialCount(): number {
    return this.history.length;
  }

  /** Return all historical observations (for saving results) */
  getHistory(): Observation[] {
    return [...this.history];
  }

  // ─────────────────────────────────────────────────
  // Internal Implementation
  // ─────────────────────────────────────────────────

  private suggestByEI(): ParamSet {
    const sorted = [...this.history].sort((a, b) => b.score - a.score);
    const nGood = Math.max(1, Math.floor(sorted.length * this.gamma));
    const goodObs = sorted.slice(0, nGood);
    const badObs  = sorted.slice(nGood);

    // Build candidate pool: 50% random + 50% elite perturbation
    const candidates: ParamSet[] = [];
    const halfPool = Math.floor(this.candidatePool / 2);

    // Random candidates
    for (let i = 0; i < halfPool; i++) {
      candidates.push(sampleRandom(this.space, () => this.rng.next()));
    }

    // Elite perturbation candidates
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

    // Calculate EI score for each candidate (sum of per-dimension EI)
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

  /** Encode observation set into per-dimension [0,1] arrays */
  private encodeObservations(obs: Observation[]): number[][] {
    return this.space.map((def) =>
      obs.map((o) => encodeParam(def, o.params[def.name] ?? def.min))
    );
  }
}

// ─────────────────────────────────────────────────────
// Walk-Forward Data Splitting Utility
// ─────────────────────────────────────────────────────

/**
 * Split kline data into train/test sets by ratio (time-series split, no shuffle).
 *
 * @param klines       Full kline data
 * @param trainRatio   Train set ratio (default 0.7 = 70%)
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

// Import Kline type (only used by splitKlines)
import type { Kline } from "../types.js";

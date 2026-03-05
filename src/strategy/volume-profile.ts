/**
 * Volume Profile & Multi-layer Support/Resistance Calculation
 *
 * True support/resistance is not about "finding highs and lows" but "finding volume-dense zones".
 * Where price trades the most is the true value center.
 *
 * Three layers of sources, ranked by confidence:
 *   1. Volume Profile POC (highest volume price zone)         -- most reliable
 *   2. Pivot Points (standard pivots, used by institutions)   -- high reliability
 *   3. Psychological levels ($60K/$65K round numbers)         -- supplementary reference
 *
 * Point of Control (POC): the most volume-dense price zone in the distribution
 * Value Area: the price range containing 70% of volume (VAH/VAL)
 */

import type { Kline } from "../types.js";

// ─── Type Definitions ──────────────────────────────────────────

export interface VolumeNode {
  price: number;         // Price midpoint (bucket center)
  volume: number;        // Total volume at this price level
  volumePct: number;     // Percentage of total volume
  isVAH: boolean;        // Value Area High upper boundary
  isVAL: boolean;        // Value Area Low lower boundary
  isPOC: boolean;        // Point of Control (highest volume)
}

export interface VolumeProfile {
  poc: number;           // Point of Control price
  vah: number;           // Value Area High (70% volume upper bound)
  val: number;           // Value Area Low (70% volume lower bound)
  nodes: VolumeNode[];   // Full volume distribution
}

export interface KeyLevel {
  price: number;
  type: "support" | "resistance";
  source: "volume_poc" | "volume_va" | "pivot" | "psychological" | "structure";
  strength: "major" | "moderate" | "minor";
  description: string;
}

export interface SupportResistance {
  currentPrice: number;
  supports: KeyLevel[];      // Sorted by distance to current price (nearest first)
  resistances: KeyLevel[];   // Sorted by distance to current price (nearest first)
  nearestSupport: KeyLevel | null;
  nearestResistance: KeyLevel | null;
  distanceToSupport: number;    // Percentage distance
  distanceToResistance: number;
}

// ─── Volume Profile Calculation ──────────────────────────────

/**
 * Calculate Volume Profile from kline data
 * @param klines Kline array
 * @param buckets Number of price buckets (default 50, more = finer resolution)
 */
export function calcVolumeProfile(klines: Kline[], buckets = 50): VolumeProfile {
  if (klines.length === 0) {
    return { poc: 0, vah: 0, val: 0, nodes: [] };
  }

  const allHighs = klines.map((k) => k.high);
  const allLows = klines.map((k) => k.low);
  const priceMax = Math.max(...allHighs);
  const priceMin = Math.min(...allLows);
  const bucketSize = (priceMax - priceMin) / buckets;

  if (bucketSize === 0) return { poc: 0, vah: 0, val: 0, nodes: [] };

  // Initialize buckets
  const volumeBuckets = new Array<number>(buckets).fill(0);

  // Distribute each kline's volume across price buckets
  for (const kline of klines) {
    const klHigh = kline.high;
    const klLow = kline.low;
    const klVolume = kline.volume;

    // Determine the bucket range covered by this kline
    const startBucket = Math.floor((klLow - priceMin) / bucketSize);
    const endBucket = Math.min(buckets - 1, Math.floor((klHigh - priceMin) / bucketSize));

    const coveredBuckets = endBucket - startBucket + 1;
    if (coveredBuckets <= 0) continue;

    // Evenly distribute volume across covered buckets
    const volumePerBucket = klVolume / coveredBuckets;
    for (let b = startBucket; b <= endBucket; b++) {
      if (b >= 0 && b < buckets) {
        volumeBuckets[b] = (volumeBuckets[b] ?? 0) + volumePerBucket;
      }
    }
  }

  // Total volume
  const totalVolume = volumeBuckets.reduce((a, b) => a + b, 0);
  if (totalVolume === 0) return { poc: 0, vah: 0, val: 0, nodes: [] };

  // POC: bucket with highest volume
  let pocBucket = 0;
  for (let i = 1; i < buckets; i++) {
    if ((volumeBuckets[i] ?? 0) > (volumeBuckets[pocBucket] ?? 0)) pocBucket = i;
  }
  const poc = priceMin + (pocBucket + 0.5) * bucketSize;

  // Value Area (contains 70% of volume): expand outward from POC
  const targetVolume = totalVolume * 0.7;
  let vaLow = pocBucket;
  let vaHigh = pocBucket;
  let accVolume = volumeBuckets[pocBucket] ?? 0;

  while (accVolume < targetVolume) {
    const expandLow = vaLow > 0 ? (volumeBuckets[vaLow - 1] ?? 0) : 0;
    const expandHigh = vaHigh < buckets - 1 ? (volumeBuckets[vaHigh + 1] ?? 0) : 0;

    if (expandLow === 0 && expandHigh === 0) break;

    if (expandLow >= expandHigh) {
      vaLow--;
      accVolume += expandLow;
    } else {
      vaHigh++;
      accVolume += expandHigh;
    }
  }

  const vah = priceMin + (vaHigh + 0.5) * bucketSize;
  const val = priceMin + (vaLow + 0.5) * bucketSize;

  // Build node list
  const nodes: VolumeNode[] = volumeBuckets.map((vol, i) => ({
    price: priceMin + (i + 0.5) * bucketSize,
    volume: vol,
    volumePct: (vol / totalVolume) * 100,
    isPOC: i === pocBucket,
    isVAH: i === vaHigh,
    isVAL: i === vaLow,
  }));

  return { poc, vah, val, nodes };
}

// ─── Pivot Points ─────────────────────────────────────

export interface PivotPoints {
  pp: number;   // Pivot Point
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
}

/**
 * Calculate standard Pivot Points (based on the most recent complete daily/weekly kline)
 */
export function calcPivotPoints(klines: Kline[]): PivotPoints | null {
  if (klines.length < 2) return null;

  // Use second-to-last kline (most recent complete period) high/low/close
  const prev = klines[klines.length - 2];
  if (!prev) return null;
  const { high, low, close } = prev;
  const range = high - low;

  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    r2: pp + range,
    r3: high + 2 * (pp - low),
    s1: 2 * pp - high,
    s2: pp - range,
    s3: low - 2 * (high - pp),
  };
}

// ─── Psychological Levels ─────────────────────────────────────────

/**
 * Find psychological (round number) levels near the current price
 * BTC: every $1000; ETH: every $100; others: every 10%
 */
function getpsychologicalLevels(symbol: string, price: number, count = 3): number[] {
  let step: number;

  if (symbol.startsWith("BTC")) {
    step = 1000;
  } else if (symbol.startsWith("ETH")) {
    step = 100;
  } else if (symbol.startsWith("BNB")) {
    step = 10;
  } else if (price > 1000) {
    step = 100;
  } else if (price > 100) {
    step = 10;
  } else if (price > 10) {
    step = 1;
  } else {
    step = price * 0.1; // 10% interval
  }

  const levels: number[] = [];
  const nearest = Math.round(price / step) * step;

  for (let i = -count; i <= count; i++) {
    const level = nearest + i * step;
    if (level > 0 && level !== price) levels.push(level);
  }

  return levels;
}

// ─── Combined Support/Resistance ─────────────────────────────────────

/**
 * Calculate combined support and resistance levels
 * @param symbol Trading pair (used for psychological level calculation)
 * @param klines 4h klines (at least 50)
 * @param dailyKlines Daily klines (used for Pivot Points)
 */
export function calcSupportResistance(
  symbol: string,
  klines: Kline[],
  dailyKlines?: Kline[]
): SupportResistance {
  const currentPrice = klines[klines.length - 1]?.close ?? 0;
  const allLevels: KeyLevel[] = [];

  // ① Volume Profile
  const vp = calcVolumeProfile(klines, 60);
  if (vp.poc > 0) {
    const pocType = vp.poc < currentPrice ? "support" : "resistance";
    allLevels.push({
      price: vp.poc,
      type: pocType,
      source: "volume_poc",
      strength: "major",
      description: `Volume POC (highest volume density, ${pocType === "support" ? "support" : "resistance"})`,
    });

    // VAH/VAL
    if (vp.val < currentPrice) {
      allLevels.push({
        price: vp.val,
        type: "support",
        source: "volume_va",
        strength: "moderate",
        description: "Volume Area Low (value area lower boundary)",
      });
    }
    if (vp.vah > currentPrice) {
      allLevels.push({
        price: vp.vah,
        type: "resistance",
        source: "volume_va",
        strength: "moderate",
        description: "Volume Area High (value area upper boundary)",
      });
    }
  }

  // ② Pivot Points
  const pivotData = dailyKlines ? calcPivotPoints(dailyKlines) : calcPivotPoints(klines);
  if (pivotData) {
    const pivotLevels = [
      { price: pivotData.r3, type: "resistance" as const, strength: "minor" as const, desc: "R3" },
      { price: pivotData.r2, type: "resistance" as const, strength: "moderate" as const, desc: "R2" },
      { price: pivotData.r1, type: "resistance" as const, strength: "major" as const, desc: "R1 (most important)" },
      { price: pivotData.pp, type: (currentPrice >= pivotData.pp ? "support" : "resistance"), strength: "major" as const, desc: "PP Pivot" },
      { price: pivotData.s1, type: "support" as const, strength: "major" as const, desc: "S1 (most important)" },
      { price: pivotData.s2, type: "support" as const, strength: "moderate" as const, desc: "S2" },
      { price: pivotData.s3, type: "support" as const, strength: "minor" as const, desc: "S3" },
    ];

    for (const pl of pivotLevels) {
      if (pl.price > 0) {
        allLevels.push({
          price: pl.price,
          type: pl.price < currentPrice ? "support" : "resistance",
          source: "pivot",
          strength: pl.strength,
          description: `Pivot ${pl.desc}`,
        });
      }
    }
  }

  // ③ Psychological levels
  const psychLevels = getpsychologicalLevels(symbol, currentPrice, 3);
  for (const level of psychLevels) {
    allLevels.push({
      price: level,
      type: level < currentPrice ? "support" : "resistance",
      source: "psychological",
      strength: "minor",
      description: `Psychological level $${level.toLocaleString()}`,
    });
  }

  // Deduplicate (price diff < 0.3% treated as same level, keep higher confidence)
  const deduped = deduplicateLevels(allLevels, currentPrice, 0.003);

  // Classify and sort by distance to current price
  const supports = deduped
    .filter((l) => l.type === "support" && l.price < currentPrice)
    .sort((a, b) => b.price - a.price);  // Nearest first

  const resistances = deduped
    .filter((l) => l.type === "resistance" && l.price > currentPrice)
    .sort((a, b) => a.price - b.price); // Nearest first

  const nearestSupport = supports[0] ?? null;
  const nearestResistance = resistances[0] ?? null;

  return {
    currentPrice,
    supports: supports.slice(0, 5),
    resistances: resistances.slice(0, 5),
    nearestSupport,
    nearestResistance,
    distanceToSupport: nearestSupport
      ? ((currentPrice - nearestSupport.price) / currentPrice) * 100 : 100,
    distanceToResistance: nearestResistance
      ? ((nearestResistance.price - currentPrice) / currentPrice) * 100 : 100,
  };
}

/** Deduplicate levels (merge levels with distance < threshold) */
function deduplicateLevels(levels: KeyLevel[], currentPrice: number, threshold: number): KeyLevel[] {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const result: KeyLevel[] = [];

  for (const level of sorted) {
    const existing = result.find(
      (r) => Math.abs(r.price - level.price) / currentPrice < threshold
    );
    if (!existing) {
      result.push(level);
    } else if (strengthRank(level.strength) > strengthRank(existing.strength)) {
      // Replace with stronger level
      const idx = result.indexOf(existing);
      result[idx] = level;
    }
  }

  return result;
}

function strengthRank(s: KeyLevel["strength"]): number {
  return s === "major" ? 3 : s === "moderate" ? 2 : 1;
}

/**
 * Format support/resistance report
 */
export function formatSRReport(sr: SupportResistance, symbol: string): string {
  const coin = symbol.replace("USDT", "");
  const lines: string[] = [`📍 **${coin} Key Levels**\n`];

  const priceStr = (p: number) => `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const strengthEmoji = (s: KeyLevel["strength"]) =>
    s === "major" ? "🔴" : s === "moderate" ? "🟡" : "⚪";

  lines.push(`Current price: ${priceStr(sr.currentPrice)}`);

  if (sr.resistances.length > 0) {
    lines.push("\n🚧 **Resistance** (nearest to farthest)");
    for (const r of sr.resistances.slice(0, 3)) {
      const dist = ((r.price - sr.currentPrice) / sr.currentPrice * 100).toFixed(1);
      lines.push(`  ${strengthEmoji(r.strength)} ${priceStr(r.price)} (+${dist}%)  ${r.description}`);
    }
  }

  if (sr.supports.length > 0) {
    lines.push("\n🛡️ **Support** (nearest to farthest)");
    for (const s of sr.supports.slice(0, 3)) {
      const dist = ((sr.currentPrice - s.price) / sr.currentPrice * 100).toFixed(1);
      lines.push(`  ${strengthEmoji(s.strength)} ${priceStr(s.price)} (-${dist}%)  ${s.description}`);
    }
  }

  if (sr.nearestResistance && sr.nearestSupport) {
    const range = ((sr.nearestResistance.price - sr.nearestSupport.price) / sr.currentPrice * 100).toFixed(1);
    lines.push(`\n-> Immediate range: ${priceStr(sr.nearestSupport.price)} — ${priceStr(sr.nearestResistance.price)} (width ${range}%)`);
  }

  return lines.join("\n");
}

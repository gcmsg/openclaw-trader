/**
 * Volume Profile & 多层支撑阻力计算
 *
 * 真正的支撑/阻力不是「找高低点」，而是「找成交量密集区」。
 * 价格在哪里交易得最多，那里就是真正的价值中心。
 *
 * 三层来源，按置信度排序：
 *   1. Volume Profile POC（成交量最大价格带）      — 最可信
 *   2. Pivot Points（标准枢轴点，机构在用）        — 高可信
 *   3. 整数关口（$60K/$65K 等心理价位）            — 辅助参考
 *
 * Point of Control (POC)：成交量分布中最密集的价格区
 * Value Area：包含 70% 成交量的价格区间（VAH/VAL）
 */

import type { Kline } from "../types.js";

// ─── 类型定义 ──────────────────────────────────────────

export interface VolumeNode {
  price: number;         // 价格中位（桶中心）
  volume: number;        // 该价位的总成交量
  volumePct: number;     // 占总成交量的百分比
  isVAH: boolean;        // Value Area High 上边界
  isVAL: boolean;        // Value Area Low 下边界
  isPOC: boolean;        // Point of Control（成交量最大）
}

export interface VolumeProfile {
  poc: number;           // Point of Control 价格
  vah: number;           // Value Area High（70% 成交量上界）
  val: number;           // Value Area Low（70% 成交量下界）
  nodes: VolumeNode[];   // 完整成交量分布
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
  supports: KeyLevel[];      // 按距离当前价排序（最近的在前）
  resistances: KeyLevel[];   // 按距离当前价排序（最近的在前）
  nearestSupport: KeyLevel | null;
  nearestResistance: KeyLevel | null;
  distanceToSupport: number;    // 百分比距离
  distanceToResistance: number;
}

// ─── Volume Profile 计算 ──────────────────────────────

/**
 * 从 K 线数据计算 Volume Profile
 * @param klines K 线数组
 * @param buckets 价格桶数量（默认 50，越多越精细）
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

  // 初始化桶
  const volumeBuckets = new Array<number>(buckets).fill(0);

  // 每根 K 线的成交量按价格区间分配
  for (const kline of klines) {
    const klHigh = kline.high;
    const klLow = kline.low;
    const klVolume = kline.volume;

    // 确定该 K 线覆盖的桶范围
    const startBucket = Math.floor((klLow - priceMin) / bucketSize);
    const endBucket = Math.min(buckets - 1, Math.floor((klHigh - priceMin) / bucketSize));

    const coveredBuckets = endBucket - startBucket + 1;
    if (coveredBuckets <= 0) continue;

    // 均匀分配成交量到覆盖的桶
    const volumePerBucket = klVolume / coveredBuckets;
    for (let b = startBucket; b <= endBucket; b++) {
      if (b >= 0 && b < buckets) {
        volumeBuckets[b] = (volumeBuckets[b] ?? 0) + volumePerBucket;
      }
    }
  }

  // 总成交量
  const totalVolume = volumeBuckets.reduce((a, b) => a + b, 0);
  if (totalVolume === 0) return { poc: 0, vah: 0, val: 0, nodes: [] };

  // POC：成交量最大的桶
  let pocBucket = 0;
  for (let i = 1; i < buckets; i++) {
    if ((volumeBuckets[i] ?? 0) > (volumeBuckets[pocBucket] ?? 0)) pocBucket = i;
  }
  const poc = priceMin + (pocBucket + 0.5) * bucketSize;

  // Value Area（包含 70% 成交量）：从 POC 向两侧扩展
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

  // 构建节点列表
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
 * 计算标准 Pivot Points（基于最近一根完整日/周 K 线）
 */
export function calcPivotPoints(klines: Kline[]): PivotPoints | null {
  if (klines.length < 2) return null;

  // 用倒数第二根（最近完整周期）的高低收计算
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

// ─── 整数关口 ─────────────────────────────────────────

/**
 * 找当前价格附近的整数关口
 * BTC: 每 $1000；ETH: 每 $100；其他: 每 10%
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
    step = price * 0.1; // 10% 间隔
  }

  const levels: number[] = [];
  const nearest = Math.round(price / step) * step;

  for (let i = -count; i <= count; i++) {
    const level = nearest + i * step;
    if (level > 0 && level !== price) levels.push(level);
  }

  return levels;
}

// ─── 综合支撑阻力 ─────────────────────────────────────

/**
 * 综合计算支撑阻力
 * @param symbol 交易对（用于整数关口计算）
 * @param klines 4h K 线（至少 50 根）
 * @param dailyKlines 日线 K 线（用于 Pivot Points）
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
      description: `Volume POC（成交量最密集，${pocType === "support" ? "支撑" : "阻力"}）`,
    });

    // VAH/VAL
    if (vp.val < currentPrice) {
      allLevels.push({
        price: vp.val,
        type: "support",
        source: "volume_va",
        strength: "moderate",
        description: "Volume Area Low（价值区下边界）",
      });
    }
    if (vp.vah > currentPrice) {
      allLevels.push({
        price: vp.vah,
        type: "resistance",
        source: "volume_va",
        strength: "moderate",
        description: "Volume Area High（价值区上边界）",
      });
    }
  }

  // ② Pivot Points
  const pivotData = dailyKlines ? calcPivotPoints(dailyKlines) : calcPivotPoints(klines);
  if (pivotData) {
    const pivotLevels = [
      { price: pivotData.r3, type: "resistance" as const, strength: "minor" as const, desc: "R3" },
      { price: pivotData.r2, type: "resistance" as const, strength: "moderate" as const, desc: "R2" },
      { price: pivotData.r1, type: "resistance" as const, strength: "major" as const, desc: "R1（最重要）" },
      { price: pivotData.pp, type: (currentPrice >= pivotData.pp ? "support" : "resistance"), strength: "major" as const, desc: "PP 枢轴" },
      { price: pivotData.s1, type: "support" as const, strength: "major" as const, desc: "S1（最重要）" },
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

  // ③ 整数关口
  const psychLevels = getpsychologicalLevels(symbol, currentPrice, 3);
  for (const level of psychLevels) {
    allLevels.push({
      price: level,
      type: level < currentPrice ? "support" : "resistance",
      source: "psychological",
      strength: "minor",
      description: `整数关口 $${level.toLocaleString()}`,
    });
  }

  // 去重（价格差 < 0.3% 视为同一价位，取置信度更高的）
  const deduped = deduplicateLevels(allLevels, currentPrice, 0.003);

  // 分类并按距当前价排序
  const supports = deduped
    .filter((l) => l.type === "support" && l.price < currentPrice)
    .sort((a, b) => b.price - a.price);  // 最近的在前

  const resistances = deduped
    .filter((l) => l.type === "resistance" && l.price > currentPrice)
    .sort((a, b) => a.price - b.price); // 最近的在前

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

/** 去重价位（合并距离 < threshold 的价位） */
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
      // 替换为更强的价位
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
 * 格式化支撑阻力报告
 */
export function formatSRReport(sr: SupportResistance, symbol: string): string {
  const coin = symbol.replace("USDT", "");
  const lines: string[] = [`📍 **${coin} 关键价位**\n`];

  const priceStr = (p: number) => `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const strengthEmoji = (s: KeyLevel["strength"]) =>
    s === "major" ? "🔴" : s === "moderate" ? "🟡" : "⚪";

  lines.push(`当前价: ${priceStr(sr.currentPrice)}`);

  if (sr.resistances.length > 0) {
    lines.push("\n🚧 **阻力位**（由近到远）");
    for (const r of sr.resistances.slice(0, 3)) {
      const dist = ((r.price - sr.currentPrice) / sr.currentPrice * 100).toFixed(1);
      lines.push(`  ${strengthEmoji(r.strength)} ${priceStr(r.price)} (+${dist}%)  ${r.description}`);
    }
  }

  if (sr.supports.length > 0) {
    lines.push("\n🛡️ **支撑位**（由近到远）");
    for (const s of sr.supports.slice(0, 3)) {
      const dist = ((sr.currentPrice - s.price) / sr.currentPrice * 100).toFixed(1);
      lines.push(`  ${strengthEmoji(s.strength)} ${priceStr(s.price)} (-${dist}%)  ${s.description}`);
    }
  }

  if (sr.nearestResistance && sr.nearestSupport) {
    const range = ((sr.nearestResistance.price - sr.nearestSupport.price) / sr.currentPrice * 100).toFixed(1);
    lines.push(`\n→ 即时区间: ${priceStr(sr.nearestSupport.price)} — ${priceStr(sr.nearestResistance.price)} （宽度 ${range}%）`);
  }

  return lines.join("\n");
}

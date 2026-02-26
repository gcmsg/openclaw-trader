/**
 * P6.2 — Dynamic Pairlist
 *
 * 每日从 Binance 自动选取最优交易对，替代固定币种列表。
 * 调用 Binance 24h ticker 接口（无需 API Key）进行筛选和排名。
 */

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface PairlistConfig {
  minMarketCapUsd?: number; // 最低市值（以成交量代理），默认 1B
  minVolume24hUsd?: number; // 最低 24h 成交量 USDT，默认 50M
  maxPairs?: number; // 最多选取数量，默认 15
  blacklist?: string[]; // 强制排除列表
  whitelist?: string[]; // 强制包含列表
  sortBy?: "volume" | "volatility" | "momentum"; // 排序依据，默认 volume
}

export interface RankedPair {
  symbol: string;
  volume24hUsd: number;
  priceChangePercent: number;
  volatility: number; // (high - low) / close × 100 (%)
  score: number; // 综合评分（排序依据的值）
}

/** Binance /api/v3/ticker/24hr 单个 ticker 字段 */
export interface BinanceTicker24h {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string; // base asset volume
  quoteVolume: string; // quote asset volume (USDT for USDT pairs)
  highPrice: string;
  lowPrice: string;
}

// ─────────────────────────────────────────────────────
// Filter constants
// ─────────────────────────────────────────────────────

/** 稳定币 base 名称（排除这些作为 base 资产的 USDT 对） */
const STABLECOIN_BASES = new Set([
  "USDT",
  "BUSD",
  "USDC",
  "DAI",
  "TUSD",
  "USDP",
  "FDUSD",
  "USDD",
  "FRAX",
  "PYUSD",
  "SUSD",
]);

/** 杠杆代币后缀 */
const LEVERAGED_SUFFIXES = ["UP", "DOWN", "BEAR", "BULL"];

/** 判断是否是稳定币 USDT 对（如 USDCUSDT, BUSDUSDT） */
function isStablecoinPair(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  return STABLECOIN_BASES.has(base);
}

/** 判断是否是杠杆代币（如 BTCUPUSDT, ETHDOWNUSDT） */
function isLeveragedToken(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  return LEVERAGED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

// ─────────────────────────────────────────────────────
// Main functions
// ─────────────────────────────────────────────────────

/**
 * 从 Binance 拉取 24h ticker，按规则筛选和排名，返回 RankedPair 数组。
 *
 * @param cfg - 筛选配置（可选，全部有默认值）
 * @returns 排名后的交易对列表（已按 sortBy 降序排列）
 */
export async function fetchDynamicPairlist(cfg?: PairlistConfig): Promise<RankedPair[]> {
  const minVolume = cfg?.minVolume24hUsd ?? 50_000_000;
  const maxPairs = cfg?.maxPairs ?? 15;
  const blacklist = cfg?.blacklist ?? [];
  const whitelist = cfg?.whitelist ?? [];
  const sortBy = cfg?.sortBy ?? "volume";

  // 1. 拉取 Binance 24h tickers（AbortController 10s 超时保护）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  let tickers: BinanceTicker24h[];
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }
    tickers = (await response.json()) as BinanceTicker24h[];
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Binance API timeout after 10s");
    }
    if (err instanceof Error && err.message.startsWith("Binance API error:")) {
      throw err;
    }
    throw new Error(`Binance fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. 过滤
  const filtered = tickers.filter((t) => {
    // 只保留 USDT 计价
    if (!t.symbol.endsWith("USDT")) return false;
    // 排除稳定币对
    if (isStablecoinPair(t.symbol)) return false;
    // 排除杠杆代币
    if (isLeveragedToken(t.symbol)) return false;
    // 排除 blacklist
    if (blacklist.includes(t.symbol)) return false;
    // 成交量过滤
    const vol = parseFloat(t.quoteVolume);
    if (vol < minVolume) return false;
    return true;
  });

  // 3. 转换为 RankedPair
  const pairs: RankedPair[] = filtered.map((t) => {
    const lastPrice = parseFloat(t.lastPrice);
    const highPrice = parseFloat(t.highPrice);
    const lowPrice = parseFloat(t.lowPrice);
    const quoteVolume = parseFloat(t.quoteVolume);
    const priceChangePercent = parseFloat(t.priceChangePercent);

    // 波动率：(high - low) / close（若 close=0 则为 0）
    const volatility = lastPrice > 0 ? (highPrice - lowPrice) / lastPrice : 0;

    // 评分：根据 sortBy 选择
    let score: number;
    if (sortBy === "volume") {
      score = quoteVolume;
    } else if (sortBy === "volatility") {
      score = volatility;
    } else {
      // momentum：绝对价格变化百分比
      score = Math.abs(priceChangePercent);
    }

    return {
      symbol: t.symbol,
      volume24hUsd: quoteVolume,
      priceChangePercent,
      volatility,
      score,
    };
  });

  // 4. 降序排列
  pairs.sort((a, b) => b.score - a.score);

  // 5. 处理 whitelist：强制包含（从原始 tickers 中补入，若未在 filtered 中出现）
  const whitelistPairs: RankedPair[] = [];
  const whitelistSet = new Set(whitelist);
  const filteredSymbols = new Set(pairs.map((p) => p.symbol));

  for (const sym of whitelist) {
    if (filteredSymbols.has(sym)) continue; // 已在 filtered 中，后面会加
    // 在原始 tickers 中查找
    const t = tickers.find((tk) => tk.symbol === sym);
    if (!t) continue;
    const lastPrice = parseFloat(t.lastPrice);
    const highPrice = parseFloat(t.highPrice);
    const lowPrice = parseFloat(t.lowPrice);
    whitelistPairs.push({
      symbol: sym,
      volume24hUsd: parseFloat(t.quoteVolume),
      priceChangePercent: parseFloat(t.priceChangePercent),
      volatility: lastPrice > 0 ? (highPrice - lowPrice) / lastPrice : 0,
      score: 0, // whitelist 不参与排名
    });
  }

  // 6. 组合结果：whitelist 优先，然后按排名填满 maxPairs
  const result: RankedPair[] = [...whitelistPairs];

  for (const p of pairs) {
    if (result.length >= maxPairs) break;
    // whitelist 中已加入（若来自 filtered），避免重复
    if (whitelistSet.has(p.symbol) && result.find((r) => r.symbol === p.symbol)) continue;
    if (result.find((r) => r.symbol === p.symbol)) continue;
    result.push(p);
  }

  return result;
}

/**
 * 与当前配置对比，输出新增/移除/不变的币种。
 */
export function diffPairlist(
  current: string[],
  next: string[]
): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const currentSet = new Set(current);
  const nextSet = new Set(next);

  return {
    added: next.filter((s) => !currentSet.has(s)),
    removed: current.filter((s) => !nextSet.has(s)),
    unchanged: current.filter((s) => nextSet.has(s)),
  };
}

/**
 * 格式化动态币种列表报告（人类可读的文本）。
 */
export function formatPairlistReport(
  pairs: RankedPair[],
  diff?: ReturnType<typeof diffPairlist>
): string {
  const lines: string[] = ["📊 Dynamic Pairlist Report", ""];

  if (diff) {
    if (diff.added.length > 0) {
      lines.push(`✅ Added   (${diff.added.length}): ${diff.added.join(", ")}`);
    }
    if (diff.removed.length > 0) {
      lines.push(`❌ Removed (${diff.removed.length}): ${diff.removed.join(", ")}`);
    }
    if (diff.unchanged.length > 0) {
      lines.push(`🔄 Unchanged (${diff.unchanged.length}): ${diff.unchanged.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(`Total: ${pairs.length} pairs selected`);
  lines.push("");
  lines.push(
    `${"Symbol".padEnd(14)} ${"Volume24h(M)".padStart(12)}  ${"Change%".padStart(8)}  ${"Volatility%".padStart(11)}  Score`
  );
  lines.push("─".repeat(64));

  for (const p of pairs) {
    const vol = (p.volume24hUsd / 1_000_000).toFixed(1);
    const change = p.priceChangePercent.toFixed(2);
    const volatility = (p.volatility * 100).toFixed(2);
    const score = p.score.toFixed(0);
    lines.push(
      `${p.symbol.padEnd(14)} ${vol.padStart(12)}  ${change.padStart(8)}  ${volatility.padStart(11)}  ${score}`
    );
  }

  return lines.join("\n");
}

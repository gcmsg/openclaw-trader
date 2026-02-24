/**
 * 链上数据模块 — Phase 3
 *
 * 核心逻辑：
 *   稳定币供应量 = 链上的"弹药"储备量
 *   USDT/USDC 持续增发 → 新资金进场 → 潜在买盘
 *   USDT/USDC 持续减少 → 资金撤离 → 卖压
 *
 * 比交易所流量更可靠，因为：
 *   - 链上数据不可篡改
 *   - 覆盖所有链（ETH/Tron/BSC...），不只是一个交易所
 *   - 反映真实资金动向，非交易所内部转账
 *
 * 数据源（免费，无需 Key）：
 *   DeFiLlama Stablecoins API — 实时稳定币供应量
 *   Blockchair API            — BTC 链上网络指标
 *   Blockchain.info API       — BTC 挖矿 & 网络统计
 */

import https from "https";

// ─── HTTP 工具 ─────────────────────────────────────────

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "User-Agent": "openclaw-trader/1.0", "Accept": "application/json" },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: string) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`JSON error from ${parsed.hostname}: ${data.slice(0, 80)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
    req.end();
  });
}

// ─── 类型定义 ──────────────────────────────────────────

export interface StablecoinFlow {
  symbol: string;
  name: string;
  circulatingB: number;     // 当前流通量（$B）
  change1dM: number;        // 1 日变化（$M，正=增发，负=销毁）
  change7dB: number;        // 7 日变化（$B）
  change30dB: number;       // 30 日变化（$B）
  trend: "expanding" | "contracting" | "stable";
  trendLabel: string;
}

export interface BtcNetworkMetrics {
  transactions24h: number;    // 24h 链上交易数
  volumeB: number;            // 24h 链上转账量（$B）
  mempoolTxs: number;         // 当前内存池待确认数
  mempoolSizeMB: number;      // 内存池大小（MB）
  difficulty: number;         // 当前挖矿难度
  networkActivity: "high" | "normal" | "low";
  networkLabel: string;
}

export interface OnChainContext {
  stablecoins: StablecoinFlow[];
  totalStablecoin1dChangeM: number;    // USDT+USDC 合计 1 日变化（$M）
  totalStablecoin7dChangeB: number;    // USDT+USDC 合计 7 日变化（$B）
  totalStablecoin30dChangeB: number;   // 30 日变化（$B）
  stablecoinSignal: "accumulation" | "distribution" | "neutral";
  btcNetwork: BtcNetworkMetrics | null;
  summary: string;
  fetchedAt: number;
}

// ─── DeFiLlama 稳定币 API ─────────────────────────────

interface LlamaStablecoin {
  symbol: string;
  name: string;
  circulating: { peggedUSD: number };
  circulatingPrevDay?: { peggedUSD: number };
  circulatingPrevWeek?: { peggedUSD: number };
  circulatingPrevMonth?: { peggedUSD: number };
}

interface LlamaResponse {
  peggedAssets: LlamaStablecoin[];
}

const TRACKED_STABLECOINS = ["USDT", "USDC"]; // 关注最大的两个

export async function getStablecoinFlows(): Promise<StablecoinFlow[]> {
  const data = await fetchJson<LlamaResponse>(
    "https://stablecoins.llama.fi/stablecoins?includePrices=true"
  );

  const results: StablecoinFlow[] = [];

  for (const symbol of TRACKED_STABLECOINS) {
    const asset = data.peggedAssets.find((a) => a.symbol === symbol);
    if (!asset) continue;

    const now = asset.circulating.peggedUSD;
    const prevDay = asset.circulatingPrevDay?.peggedUSD ?? now;
    const prevWeek = asset.circulatingPrevWeek?.peggedUSD ?? now;
    const prevMonth = asset.circulatingPrevMonth?.peggedUSD ?? now;

    const change1d = now - prevDay;         // 绝对值，单位 $
    const change7d = now - prevWeek;
    const change30d = now - prevMonth;

    // 趋势判断：7 日变化 > 1B 且方向一致
    let trend: StablecoinFlow["trend"];
    if (change7d > 1e9) trend = "expanding";
    else if (change7d < -1e9) trend = "contracting";
    else trend = "stable";

    const sign = (n: number) => n >= 0 ? "+" : "";
    const trendEmoji = trend === "expanding" ? "📈" : trend === "contracting" ? "📉" : "➡️";
    const trendLabel = `${trendEmoji} 7d: ${sign(change7d / 1e9)}${(change7d / 1e9).toFixed(2)}B | 1d: ${sign(change1d / 1e6)}${(change1d / 1e6).toFixed(0)}M`;

    results.push({
      symbol,
      name: asset.name,
      circulatingB: now / 1e9,
      change1dM: change1d / 1e6,
      change7dB: change7d / 1e9,
      change30dB: change30d / 1e9,
      trend,
      trendLabel,
    });
  }

  return results;
}

// ─── Blockchair：BTC 链上指标 ─────────────────────────

interface BlockchairStats {
  data: {
    transactions_24h: number;
    volume_24h: number;          // satoshi
    mempool_transactions: number;
    mempool_size: number;        // bytes
    difficulty: number;
    hashrate_24h: string;
    estimated_transaction_volume_usd?: number;
  };
}

interface BlockchainInfoStats {
  trade_volume_usd: number;
  estimated_transaction_volume_usd: number;
  n_tx: number;
  market_price_usd: number;
}

export async function getBtcNetworkMetrics(): Promise<BtcNetworkMetrics | null> {
  try {
    const [blockchair, bcInfo] = await Promise.allSettled([
      fetchJson<BlockchairStats>("https://api.blockchair.com/bitcoin/stats"),
      fetchJson<BlockchainInfoStats>("https://api.blockchain.info/stats"),
    ]);

    const stats = blockchair.status === "fulfilled" ? blockchair.value.data : null;
    const bcStats = bcInfo.status === "fulfilled" ? bcInfo.value : null;

    if (!stats) return null;

    // 链上成交量（美元估算）
    const volumeUSD = bcStats?.estimated_transaction_volume_usd
      ?? (stats.volume_24h / 1e8 * (bcStats?.market_price_usd ?? 63000));

    const transactions24h = stats.transactions_24h;
    const mempoolTxs = stats.mempool_transactions;
    const mempoolSizeMB = stats.mempool_size / 1e6;
    const volumeB = volumeUSD / 1e9;

    // 网络活跃度判断（基于 mempool 大小）
    let networkActivity: BtcNetworkMetrics["networkActivity"];
    let networkLabel: string;

    if (mempoolTxs > 100000 || mempoolSizeMB > 200) {
      networkActivity = "high";
      networkLabel = `🔥 网络拥堵（mempool ${mempoolTxs.toLocaleString()} 笔，${mempoolSizeMB.toFixed(0)}MB）`;
    } else if (mempoolTxs < 5000) {
      networkActivity = "low";
      networkLabel = `❄️ 网络冷清（mempool ${mempoolTxs.toLocaleString()} 笔）`;
    } else {
      networkActivity = "normal";
      networkLabel = `✅ 网络正常（mempool ${mempoolTxs.toLocaleString()} 笔）`;
    }

    return {
      transactions24h,
      volumeB,
      mempoolTxs,
      mempoolSizeMB,
      difficulty: stats.difficulty,
      networkActivity,
      networkLabel,
    };
  } catch {
    return null;
  }
}

// ─── 综合分析 ─────────────────────────────────────────

export async function getOnChainContext(): Promise<OnChainContext> {
  const [stablecoins, btcNetwork] = await Promise.allSettled([
    getStablecoinFlows(),
    getBtcNetworkMetrics(),
  ]);

  const sc = stablecoins.status === "fulfilled" ? stablecoins.value : [];
  const btc = btcNetwork.status === "fulfilled" ? btcNetwork.value : null;

  // 合计稳定币变化
  const total1dM = sc.reduce((s, c) => s + c.change1dM, 0);
  const total7dB = sc.reduce((s, c) => s + c.change7dB, 0);
  const total30dB = sc.reduce((s, c) => s + c.change30dB, 0);

  // 资金流向信号（稳定币 = 候场资金）
  let stablecoinSignal: OnChainContext["stablecoinSignal"];
  let signalDesc: string;

  if (total7dB > 2) {
    stablecoinSignal = "accumulation";
    signalDesc = `稳定币 7 日增发 +${total7dB.toFixed(1)}B，新资金持续流入，中长线看涨`;
  } else if (total7dB > 0.5) {
    stablecoinSignal = "accumulation";
    signalDesc = `稳定币 7 日小幅增发 +${total7dB.toFixed(1)}B，温和积累`;
  } else if (total7dB < -2) {
    stablecoinSignal = "distribution";
    signalDesc = `稳定币 7 日净销毁 ${total7dB.toFixed(1)}B，资金撤离加密市场，中长线看跌`;
  } else if (total7dB < -0.5) {
    stablecoinSignal = "distribution";
    signalDesc = `稳定币 7 日小幅减少 ${total7dB.toFixed(1)}B，资金轻微撤离`;
  } else {
    stablecoinSignal = "neutral";
    signalDesc = `稳定币供应 7 日变化 ${total7dB >= 0 ? "+" : ""}${total7dB.toFixed(2)}B，基本持平`;
  }

  // BTC 网络补充
  const btcDesc = btc ? `BTC 链上 24h 转账量 $${btc.volumeB.toFixed(1)}B，${btc.networkLabel}` : "";

  const summary = `${signalDesc}${btcDesc ? "。" + btcDesc : ""}`;

  return {
    stablecoins: sc,
    totalStablecoin1dChangeM: total1dM,
    totalStablecoin7dChangeB: total7dB,
    totalStablecoin30dChangeB: total30dB,
    stablecoinSignal,
    btcNetwork: btc,
    summary,
    fetchedAt: Date.now(),
  };
}

// ─── 格式化报告 ───────────────────────────────────────

export function formatOnChainReport(ctx: OnChainContext): string {
  const lines: string[] = ["🔗 **链上数据**\n"];
  const sign = (n: number) => n >= 0 ? "+" : "";

  // 稳定币
  const signalEmoji = ctx.stablecoinSignal === "accumulation" ? "🟢"
    : ctx.stablecoinSignal === "distribution" ? "🔴" : "⚪";

  lines.push("**稳定币供应**（弹药储备）");
  for (const sc of ctx.stablecoins) {
    lines.push(`  ${sc.symbol} $${sc.circulatingB.toFixed(1)}B  ${sc.trendLabel}`);
  }

  // 合计
  const total7 = ctx.totalStablecoin7dChangeB;
  const total30 = ctx.totalStablecoin30dChangeB;
  lines.push(`合计: 7d ${sign(total7)}${total7.toFixed(2)}B | 30d ${sign(total30)}${total30.toFixed(1)}B`);
  lines.push(`${signalEmoji} ${ctx.summary.split("。")[0]}`);

  // BTC 网络
  if (ctx.btcNetwork) {
    const n = ctx.btcNetwork;
    lines.push(`\n**BTC 网络活跃度**`);
    lines.push(`  24h 交易: ${n.transactions24h.toLocaleString()} 笔 | 链上量 $${n.volumeB.toFixed(1)}B`);
    lines.push(`  ${n.networkLabel}`);
  }

  return lines.join("\n");
}

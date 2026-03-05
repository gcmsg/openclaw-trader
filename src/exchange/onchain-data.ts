/**
 * On-Chain Data Module — Phase 3
 *
 * Core logic:
 *   Stablecoin supply = on-chain "ammunition" reserves
 *   USDT/USDC sustained minting -> new capital inflow -> potential buy pressure
 *   USDT/USDC sustained burning -> capital outflow -> sell pressure
 *
 * More reliable than exchange flows because:
 *   - On-chain data is immutable
 *   - Covers all chains (ETH/Tron/BSC...), not just one exchange
 *   - Reflects real capital movements, not internal exchange transfers
 *
 * Data sources (free, no Key required):
 *   DeFiLlama Stablecoins API — Real-time stablecoin supply
 *   Blockchair API            — BTC on-chain network metrics
 *   Blockchain.info API       — BTC mining & network statistics
 */

import https from "https";

// ─── HTTP Utility ─────────────────────────────────────────

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

// ─── Type Definitions ──────────────────────────────────────────

export interface StablecoinFlow {
  symbol: string;
  name: string;
  circulatingB: number;     // Current circulating supply ($B)
  change1dM: number;        // 1-day change ($M, positive=minting, negative=burning)
  change7dB: number;        // 7-day change ($B)
  change30dB: number;       // 30-day change ($B)
  trend: "expanding" | "contracting" | "stable";
  trendLabel: string;
}

export interface BtcNetworkMetrics {
  transactions24h: number;    // 24h on-chain transaction count
  volumeB: number;            // 24h on-chain transfer volume ($B)
  mempoolTxs: number;         // Current mempool pending count
  mempoolSizeMB: number;      // Mempool size (MB)
  difficulty: number;         // Current mining difficulty
  networkActivity: "high" | "normal" | "low";
  networkLabel: string;
}

export interface OnChainContext {
  stablecoins: StablecoinFlow[];
  totalStablecoin1dChangeM: number;    // USDT+USDC combined 1-day change ($M)
  totalStablecoin7dChangeB: number;    // USDT+USDC combined 7-day change ($B)
  totalStablecoin30dChangeB: number;   // 30-day change ($B)
  stablecoinSignal: "accumulation" | "distribution" | "neutral";
  btcNetwork: BtcNetworkMetrics | null;
  summary: string;
  fetchedAt: number;
}

// ─── DeFiLlama Stablecoin API ─────────────────────────────

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

const TRACKED_STABLECOINS = ["USDT", "USDC"]; // Track the two largest

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

    const change1d = now - prevDay;         // Absolute value, in $
    const change7d = now - prevWeek;
    const change30d = now - prevMonth;

    // Trend determination: 7-day change > 1B with consistent direction
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

// ─── Blockchair: BTC On-Chain Metrics ─────────────────────────

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

    // On-chain volume (USD estimate)
    const volumeUSD = bcStats?.estimated_transaction_volume_usd
      ?? (stats.volume_24h / 1e8 * (bcStats?.market_price_usd ?? 63000));

    const transactions24h = stats.transactions_24h;
    const mempoolTxs = stats.mempool_transactions;
    const mempoolSizeMB = stats.mempool_size / 1e6;
    const volumeB = volumeUSD / 1e9;

    // Network activity assessment (based on mempool size)
    let networkActivity: BtcNetworkMetrics["networkActivity"];
    let networkLabel: string;

    if (mempoolTxs > 100000 || mempoolSizeMB > 200) {
      networkActivity = "high";
      networkLabel = `🔥 Network congested (mempool ${mempoolTxs.toLocaleString()} txs, ${mempoolSizeMB.toFixed(0)}MB)`;
    } else if (mempoolTxs < 5000) {
      networkActivity = "low";
      networkLabel = `❄️ Network quiet (mempool ${mempoolTxs.toLocaleString()} txs)`;
    } else {
      networkActivity = "normal";
      networkLabel = `✅ Network normal (mempool ${mempoolTxs.toLocaleString()} txs)`;
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

// ─── Combined Analysis ─────────────────────────────────────────

export async function getOnChainContext(): Promise<OnChainContext> {
  const [stablecoins, btcNetwork] = await Promise.allSettled([
    getStablecoinFlows(),
    getBtcNetworkMetrics(),
  ]);

  const sc = stablecoins.status === "fulfilled" ? stablecoins.value : [];
  const btc = btcNetwork.status === "fulfilled" ? btcNetwork.value : null;

  // Total stablecoin changes
  const total1dM = sc.reduce((s, c) => s + c.change1dM, 0);
  const total7dB = sc.reduce((s, c) => s + c.change7dB, 0);
  const total30dB = sc.reduce((s, c) => s + c.change30dB, 0);

  // Capital flow signal (stablecoins = sidelined capital)
  let stablecoinSignal: OnChainContext["stablecoinSignal"];
  let signalDesc: string;

  if (total7dB > 2) {
    stablecoinSignal = "accumulation";
    signalDesc = `Stablecoin 7d minting +${total7dB.toFixed(1)}B, sustained capital inflow, mid-long term bullish`;
  } else if (total7dB > 0.5) {
    stablecoinSignal = "accumulation";
    signalDesc = `Stablecoin 7d slight minting +${total7dB.toFixed(1)}B, moderate accumulation`;
  } else if (total7dB < -2) {
    stablecoinSignal = "distribution";
    signalDesc = `Stablecoin 7d net burn ${total7dB.toFixed(1)}B, capital leaving crypto market, mid-long term bearish`;
  } else if (total7dB < -0.5) {
    stablecoinSignal = "distribution";
    signalDesc = `Stablecoin 7d slight decrease ${total7dB.toFixed(1)}B, minor capital outflow`;
  } else {
    stablecoinSignal = "neutral";
    signalDesc = `Stablecoin supply 7d change ${total7dB >= 0 ? "+" : ""}${total7dB.toFixed(2)}B, roughly flat`;
  }

  // BTC network supplement
  const btcDesc = btc ? `BTC on-chain 24h transfer volume $${btc.volumeB.toFixed(1)}B, ${btc.networkLabel}` : "";

  const summary = `${signalDesc}${btcDesc ? ". " + btcDesc : ""}`;

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

// ─── Format Report ───────────────────────────────────────

export function formatOnChainReport(ctx: OnChainContext): string {
  const lines: string[] = ["🔗 **On-Chain Data**\n"];
  const sign = (n: number) => n >= 0 ? "+" : "";

  // Stablecoins
  const signalEmoji = ctx.stablecoinSignal === "accumulation" ? "🟢"
    : ctx.stablecoinSignal === "distribution" ? "🔴" : "⚪";

  lines.push("**Stablecoin Supply** (Ammunition Reserves)");
  for (const sc of ctx.stablecoins) {
    lines.push(`  ${sc.symbol} $${sc.circulatingB.toFixed(1)}B  ${sc.trendLabel}`);
  }

  // Total
  const total7 = ctx.totalStablecoin7dChangeB;
  const total30 = ctx.totalStablecoin30dChangeB;
  lines.push(`Total: 7d ${sign(total7)}${total7.toFixed(2)}B | 30d ${sign(total30)}${total30.toFixed(1)}B`);
  lines.push(`${signalEmoji} ${ctx.summary.split(".")[0]}`);

  // BTC Network
  if (ctx.btcNetwork) {
    const n = ctx.btcNetwork;
    lines.push(`\n**BTC Network Activity**`);
    lines.push(`  24h Txs: ${n.transactions24h.toLocaleString()} | On-chain Volume $${n.volumeB.toFixed(1)}B`);
    lines.push(`  ${n.networkLabel}`);
  }

  return lines.join("\n");
}

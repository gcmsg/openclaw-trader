/**
 * Live / Testnet Live Monitoring Script
 *
 * Function: Connects to Binance real API (testnet or production),
 * uses the unified signal engine for actual order placement.
 *
 * Uses exactly the same signal pipeline as monitor.ts (cron):
 *   processSignal() → regime awareness → correlation filter → R:R → protection
 *   → MTF trend filter → emergency halt → event calendar → sentiment gate → Kelly sizing
 *
 * Usage:
 *   npm run live          # Testnet mode (loads testnet scenario from paper.yaml)
 *   npm run live -- --scenario testnet-default
 */

import fs from "fs";
import path from "path";
import { getKlines } from "../exchange/binance.js";
import { checkMtfFilter } from "../strategy/mtf-filter.js";
import { loadRecentTrades } from "../strategy/recent-trades.js";
import { processSignal } from "../strategy/signal-engine.js";
import { loadStrategyConfig, loadPaperConfig, buildPaperRuntime } from "../config/loader.js";
import { createLiveExecutor, LiveExecutor } from "../live/executor.js";
import { reconcilePositions, formatReconcileReport } from "../live/reconcile.js";
import { loadNewsReport, evaluateSentimentGate } from "../news/sentiment-gate.js";
import { readSentimentCache } from "../news/sentiment-cache.js";
import { notifySignal, notifyError } from "../notify/openclaw.js";
import { loadAccount, saveAccount } from "../paper/account.js";
import type { PaperAccount } from "../paper/account.js";
import {
  calcCorrelationAdjustedSize,
  calcPortfolioExposure,
  formatPortfolioExposure,
} from "../strategy/portfolio-risk.js";
import type { PositionWeight } from "../strategy/portfolio-risk.js";
import { logSignal, closeSignal } from "../strategy/signal-history.js";
import { readEmergencyHalt } from "../news/emergency-monitor.js";
import { checkEventRisk, loadCalendar } from "../strategy/events-calendar.js";
import { CvdManager, readCvdCache } from "../exchange/order-flow.js";
import { fetchFundingRatePct } from "../strategy/funding-rate-signal.js";
import { getBtcDominanceTrend } from "../strategy/btc-dominance.js";
import { calcKellyRatio } from "../strategy/kelly.js";
import { getOnChainContext } from "../exchange/onchain-data.js";
import { DataProvider } from "../exchange/data-provider.js";
import {
  isKillSwitchActive,
  activateKillSwitch,
  checkBtcCrash,
} from "../health/kill-switch.js";
import type { RuntimeConfig, Kline, Indicators } from "../types.js";
import { createLogger } from "../logger.js";
import { ping } from "../health/heartbeat.js";

const POLL_INTERVAL_MS = 60 * 1000; // 1-minute polling
const BTC_CRASH_THRESHOLD_PCT = 8;  // BTC 1-hour drop trigger threshold (default 8%)
const MAX_BTC_PRICE_BUFFER = 60;    // Keep last 60 price points (~1 hour, 1 per minute)
const PAIRLIST_MAX_AGE_MS = 25 * 60 * 60 * 1000; // pairlist file older than 25h considered stale
const PAIRLIST_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../logs/current-pairlist.json"
);

/**
 * Load symbol list from dynamic pairlist file (P6.2).
 * Returns null if file doesn't exist or is stale (>25h), causing caller to fall back to static list from config.
 * @param heldSymbols Currently held symbols, force-kept (must not lose position monitoring due to pairlist)
 */
function loadPairlistSymbols(heldSymbols: string[]): string[] | null {
  try {
    const raw = fs.readFileSync(PAIRLIST_PATH, "utf-8");
    const data = JSON.parse(raw) as { symbols: string[]; updatedAt: number };
    if (Date.now() - data.updatedAt > PAIRLIST_MAX_AGE_MS) return null; // stale
    // Merge held symbols (ensure open position symbols are always monitored, even if dropped from pairlist)
    const merged = [...new Set([...data.symbols, ...heldSymbols])];
    return merged;
  } catch {
    return null; // Silently fall back when file doesn't exist or parse fails
  }
}

/**
 * Convert paper account positions to PositionWeight[] (for portfolio-risk usage)
 * @param account   Current account snapshot
 * @param priceMap  symbol → latest price (falls back to entry price if not found)
 */
function buildPositionWeights(
  account: PaperAccount,
  priceMap: Record<string, number>,
): PositionWeight[] {
  const entries = Object.entries(account.positions);
  if (entries.length === 0) return [];
  const notionals = entries.map(([sym, pos]) => pos.quantity * (priceMap[sym] ?? pos.entryPrice));
  const totalEquity = account.usdt + notionals.reduce((s, v) => s + v, 0);
  if (totalEquity <= 0) return [];
  return entries.map(([sym, pos], i) => ({
    symbol: sym,
    side: pos.side ?? "long",
    notionalUsdt: notionals[i] ?? 0,
    weight: (notionals[i] ?? 0) / totalEquity,
  }));
}

// ── Recent BTC price buffer (for crash detection) ──
const btcPriceBuffer: number[] = [];
/** Total loss alert cooldown (scenarioId → last notification timestamp), notify only once within 30 minutes */
const _totalLossNotifyAt = new Map<string, number>();
const TOTAL_LOSS_NOTIFY_COOLDOWN_MS = 30 * 60_000;

// ── Graceful shutdown flag (wrapped in object to avoid no-unnecessary-condition false positive) ──
const _state = { shuttingDown: false };

// ── Duplicate filtered signal dedup (same symbol+signal only logs once within 5 minutes) ────────────
const _filteredCooldown = new Map<string, number>(); // "${symbol}:${signalType}" → lastLogMs
const FILTERED_LOG_COOLDOWN_MS = 5 * 60 * 1000;

/** Returns true = should log (first time or cooldown expired), updates timestamp */
function shouldLogFiltered(symbol: string, signalType: string): boolean {
  const key = `${symbol}:${signalType}`;
  const last = _filteredCooldown.get(key) ?? 0;
  if (Date.now() - last < FILTERED_LOG_COOLDOWN_MS) return false;
  _filteredCooldown.set(key, Date.now());
  return true;
}

/** When signal becomes NONE or passes filter, clear the cooldown state for that symbol */
function clearFilteredCooldown(symbol: string): void {
  for (const key of _filteredCooldown.keys()) {
    if (key.startsWith(`${symbol}:`)) _filteredCooldown.delete(key);
  }
}

// ── P6.2 On-chain stablecoin flow cache (refresh hourly, write to file for monitor.ts to read) ──
const ONCHAIN_CACHE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../logs/onchain-cache.json"
);
const STABLECOIN_REFRESH_MS = 60 * 60 * 1000; // Refresh every 60 minutes

let _stablecoinSignal: "accumulation" | "distribution" | "neutral" | undefined;
let _stablecoinSignalFetchedAt = 0;

function readOnchainCache(): "accumulation" | "distribution" | "neutral" | undefined {
  try {
    const raw = fs.readFileSync(ONCHAIN_CACHE_PATH, "utf-8");
    const d = JSON.parse(raw) as { stablecoinSignal: string; fetchedAt: number };
    if (Date.now() - d.fetchedAt > STABLECOIN_REFRESH_MS * 2) return undefined; // Over 2h considered stale
    return d.stablecoinSignal as "accumulation" | "distribution" | "neutral";
  } catch { return undefined; }
}

async function refreshStablecoinSignal(): Promise<void> {
  if (Date.now() - _stablecoinSignalFetchedAt < STABLECOIN_REFRESH_MS) return;
  try {
    const ctx = await getOnChainContext();
    _stablecoinSignal = ctx.stablecoinSignal;
    _stablecoinSignalFetchedAt = Date.now();
    // Write to file for monitor.ts (cron process) to read
    fs.writeFileSync(ONCHAIN_CACHE_PATH, JSON.stringify({
      stablecoinSignal: _stablecoinSignal,
      fetchedAt: _stablecoinSignalFetchedAt,
    }));
    log.info(`🔗 On-chain stablecoin signal refreshed: ${_stablecoinSignal}`);
  } catch {
    // On network failure, read last value from file
    if (!_stablecoinSignal) _stablecoinSignal = readOnchainCache();
  }
}

const log = createLogger("live-monitor");

// ── Timeframe → cache TTL (staleSec) ──────────────────────────────────
// staleSec = candle duration - 90s, ensures refresh within 60s after new candle forms
const TF_STALE_MAP: Record<string, number> = {
  "1m":  30,     // 1-min candle → 30s cache
  "5m":  210,    // 5m → 3.5min
  "15m": 810,    // 15m → 13.5min
  "1h":  3510,   // 1h → 58.5min
  "4h":  14310,  // 4h → 3h 58.5min
  "1d":  86310,  // 1d → 23h 59.5min
};
function tfStaleSec(tf: string): number {
  return TF_STALE_MAP[tf] ?? 3510; // Unknown TF falls back to 1h
}

// ─────────────────────────────────────────────────────
// Single round signal detection + execution (all symbols for one scenario)
// ─────────────────────────────────────────────────────

async function processSymbol(
  symbol: string,
  cfg: RuntimeConfig,
  provider: DataProvider,
): Promise<void> {
  const label = cfg.exchange.testnet ? "[TESTNET]" : "[LIVE]";

  // ── Fetch candlesticks ─────────────────────────────────────
  const macdCfg = cfg.strategy.macd;
  const macdMinBars = macdCfg.enabled ? macdCfg.slow + macdCfg.signal + 1 : 0;
  const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

  let klines = provider.get(symbol, cfg.timeframe);
  if (!klines || klines.length < limit) {
    klines = await getKlines(symbol, cfg.timeframe, limit + 1);
    if (klines.length < limit) {
      log.info(`${label} ${symbol}: Insufficient candlesticks (${klines.length}/${limit}), skipping`);
      return;
    }
  }

  // ── Build external context (identical to monitor.ts) ─────────
  let externalCvd: number | undefined;
  let externalFundingRate: number | undefined;
  let externalBtcDom: number | undefined;
  let externalBtcDomChange: number | undefined;

  // Funding rate
  try {
    const frPct = await fetchFundingRatePct(symbol);
    if (frPct !== undefined) externalFundingRate = frPct;
  } catch { /* silently skip on failure */ }

  // BTC dominance
  try {
    const domTrend = getBtcDominanceTrend();
    if (!isNaN(domTrend.latest)) {
      externalBtcDom = domTrend.latest;
      externalBtcDomChange = domTrend.change;
    }
  } catch { /* silently skip on failure */ }

  // CVD
  try {
    const realCvd = readCvdCache(symbol) as { cvd?: number; updatedAt?: number } | undefined;
    const maxAgeMs = 5 * 60_000;
    if (realCvd?.cvd !== undefined && realCvd.updatedAt !== undefined &&
        Date.now() - realCvd.updatedAt < maxAgeMs) {
      externalCvd = realCvd.cvd;
    }
  } catch { /* silently skip on failure */ }

  // Current position direction + correlation candlesticks
  const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  // side is optional (old data compatibility), defaults to "long" when position exists but side is undefined, prevents treating as "no position"
  const _pos = currentAccount.positions[symbol];
  const currentPosSide: "long" | "short" | undefined = _pos ? (_pos.side ?? "long") : undefined;
  const heldKlinesMap: Record<string, Kline[]> = {};
  if (cfg.risk.correlation_filter?.enabled) {
    const heldSymbols = Object.keys(currentAccount.positions).filter((s) => s !== symbol);
    const corrLookback = cfg.risk.correlation_filter.lookback;
    await Promise.all(
      heldSymbols.map(async (sym) => {
        try {
          const cached = provider.get(sym, cfg.timeframe);
          heldKlinesMap[sym] = cached ?? await getKlines(sym, cfg.timeframe, corrLookback + 1);
        } catch { /* skip on fetch failure */ }
      })
    );
  }

  // ── Unified signal engine (identical to monitor.ts) ──────────
  const externalCtx = {
    ...(externalCvd !== undefined ? { cvd: externalCvd } : {}),
    ...(externalFundingRate !== undefined ? { fundingRate: externalFundingRate } : {}),
    ...(externalBtcDom !== undefined ? { btcDominance: externalBtcDom } : {}),
    ...(externalBtcDomChange !== undefined ? { btcDomChange: externalBtcDomChange } : {}),
    ...(currentPosSide !== undefined ? { currentPosSide } : {}),
    ...(Object.keys(heldKlinesMap).length > 0 ? { heldKlinesMap } : {}),
    ...(_stablecoinSignal !== undefined ? { stablecoinSignal: _stablecoinSignal } : {}),
  };
  const recentTrades = loadRecentTrades();
  const engineResult = processSignal(symbol, klines, cfg, externalCtx, recentTrades);

  if (!engineResult.indicators) {
    log.info(`${label} ${symbol}: Indicator calculation failed, skipping`);
    return;
  }

  const { indicators, signal, effectiveRisk, effectivePositionRatio, rejected, rejectionReason, regimeLabel } = engineResult;

  // ── Deduplicate rejected signals: don't log the same filter reason within 5 minutes ──
  if (rejected && !shouldLogFiltered(symbol, signal.type)) return;

  log.info(
    `${label} ${symbol}: RSI=${indicators.rsi.toFixed(1)} ` +
    `EMA${cfg.strategy.ma.short}=$${indicators.maShort.toFixed(2)} ` +
    `EMA${cfg.strategy.ma.long}=$${indicators.maLong.toFixed(2)} ` +
    `ATR=${indicators.atr?.toFixed(2) ?? "N/A"} ` +
    `→ ${signal.type.toUpperCase()}` +
    (regimeLabel ? ` [${regimeLabel}]` : "")
  );

  if (rejected) {
    log.info(`${label} ${symbol}: 🚫 ${rejectionReason ?? "filtered"}`);
    return;
  }

  if (signal.type === "none") {
    clearFilteredCooldown(symbol); // Signal disappeared → reset, log normally next time it appears
    return;
  }

  // ── Additional filters for entry signals (buy/short) ─────────────
  if (signal.type === "buy" || signal.type === "short") {
    // Emergency halt
    const emergency = readEmergencyHalt();
    if (emergency.halt) {
      log.warn(`${label} ${symbol}: ⛔ Emergency halt — ${emergency.reason ?? "breaking high-risk news"}`);
      return;
    }

    // P6.5 Event calendar risk control
    try {
      const eventRisk = checkEventRisk(loadCalendar());
      if (eventRisk.phase === "during") {
        log.info(`${label} ${symbol}: ⏸ Event window (${eventRisk.eventName}), pausing new entries`);
        return;
      }
      if ((eventRisk.phase === "pre" || eventRisk.phase === "post") && eventRisk.positionRatioMultiplier < 1.0) {
        log.warn(`${label} ${symbol}: ⚠️ Event risk period (${eventRisk.eventName}), position ×${eventRisk.positionRatioMultiplier}`);
      }
    } catch { /* silently skip on calendar load failure */ }

    // MTF trend filter — using shared function (A-001 fix)
    const mtfCheck = await checkMtfFilter(symbol, signal.type, cfg, provider);
    if (mtfCheck.trendBull !== null) {
      log.info(`${label} ${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfCheck.trendBull ? "Bullish✅" : "Bearish🚫"}`);
    }
    if (mtfCheck.filtered) {
      log.info(`${label} ${symbol}: 🚫 ${mtfCheck.reason}`);
      return;
    }

    // Sentiment gate
    const newsReport = loadNewsReport();
    const baseForGate = effectivePositionRatio ?? effectiveRisk.position_ratio;
    const sentimentCache = readSentimentCache();
    const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
    log.info(`${label} ${symbol}: Sentiment gate → ${gate.action} (${gate.reason})`);
    if (gate.action === "skip") return;

    // Kelly dynamic position sizing
    let effectiveRatio = "positionRatio" in gate ? gate.positionRatio : baseForGate;
    if (cfg.risk.position_sizing === "kelly") {
      try {
        const histPath = path.resolve(
          path.dirname(new URL(import.meta.url).pathname),
          "../../logs/signal-history.jsonl"
        );
        if (fs.existsSync(histPath)) {
          const lines = fs.readFileSync(histPath, "utf-8").split("\n").filter(Boolean);
          const closed = lines
            .map((l) => { try { return JSON.parse(l) as { status: string; pnlPercent?: number }; } catch { return null; } })
            .filter((r): r is { status: string; pnlPercent: number } => r?.status === "closed" && r.pnlPercent !== undefined);
          const kellyResult = calcKellyRatio(closed, {
            ...(cfg.risk.kelly_lookback !== undefined ? { lookback: cfg.risk.kelly_lookback } : {}),
            ...(cfg.risk.kelly_half !== undefined ? { half: cfg.risk.kelly_half } : {}),
            ...(cfg.risk.kelly_min_ratio !== undefined ? { minRatio: cfg.risk.kelly_min_ratio } : {}),
            ...(cfg.risk.kelly_max_ratio !== undefined ? { maxRatio: cfg.risk.kelly_max_ratio } : {}),
            fallback: cfg.risk.position_ratio,
          });
          log.info(`${label} ${symbol}: 🎯 Kelly → ${kellyResult.reason}`);
          effectiveRatio = kellyResult.ratio;
        }
      } catch { /* Kelly calculation failure does not affect main flow */ }
    }

    // ── Portfolio Risk: correlation heat continuous position reduction (P7.1) ────────────────────
    // After Kelly, before entry, further adjust position ratio using portfolio correlation heat
    // Complements binary correlation filter in signal-engine: signal-engine rejects strong correlation,
    // this reduces positions continuously for moderate correlation (higher heat = smaller position)
    try {
      const priceMap: Record<string, number> = { [symbol]: indicators.price };
      for (const [sym, klns] of Object.entries(heldKlinesMap)) {
        const last = klns.at(-1);
        if (last) priceMap[sym] = last.close;
      }
      const posWeights = buildPositionWeights(currentAccount, priceMap)
        .filter((pw) => pw.symbol !== symbol); // Exclude self
      if (posWeights.length > 0) {
        const klinesBySymbol: Record<string, Kline[]> = { [symbol]: klines, ...heldKlinesMap };
        const portfolioHeat = calcCorrelationAdjustedSize(
          symbol,
          signal.type === "buy" ? "long" : "short",
          effectiveRatio,
          posWeights,
          klinesBySymbol,
        );
        log.info(
          `${label} ${symbol}: 📊 Portfolio heat ${(portfolioHeat.heat * 100).toFixed(0)}% → ${portfolioHeat.decision} (${portfolioHeat.reason})`
        );
        if (portfolioHeat.decision === "blocked") {
          log.info(`${label} ${symbol}: 🚫 Portfolio heat too high, entry rejected`);
          return;
        }
        effectiveRatio = portfolioHeat.adjustedPositionRatio;
      }
    } catch { /* portfolio heat calculation failure does not block main flow */ }

    // ── Build final config → execute ──────────────────────────
    const adjustedCfg = { ...cfg, risk: { ...effectiveRisk, position_ratio: effectiveRatio } };
    const liveExecutor = createLiveExecutor(adjustedCfg);

    if (cfg.notify.on_signal) notifySignal(signal);

    if (signal.type === "buy") {
      const result = await liveExecutor.handleBuy(signal);
      if (result.skipped) {
        log.info(`${label} ${symbol}: Skipped — ${result.skipped}`);
      } else if (result.trade) {
        log.info(`${label} ${symbol}: Buy successful @${result.trade.price.toFixed(4)} (position ${(effectiveRatio * 100).toFixed(0)}%), orderId=${result.orderId ?? "N/A"}`);
        recordSignalHistory(symbol, "buy", result.trade.price, indicators, signal, cfg);
      }
    } else if (signal.type === "short") {
      const result = await liveExecutor.handleShort(signal);
      if (result.skipped) {
        log.info(`${label} ${symbol}: Short skipped — ${result.skipped}`);
      } else if (result.trade) {
        log.info(`${label} ${symbol}: Short opened @${result.trade.price.toFixed(4)} (position ${(effectiveRatio * 100).toFixed(0)}%), orderId=${result.orderId ?? "N/A"}`);
        recordSignalHistory(symbol, "short", result.trade.price, indicators, signal, cfg);
      }
    }
  } else if (signal.type === "sell") {
    // Close long
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const sigHistId = account.positions[symbol]?.signalHistoryId;
    if (account.positions[symbol]) {
      const liveExecutor = createLiveExecutor(cfg);
      const result = await liveExecutor.handleSell(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log.info(`${label} ${symbol}: Sell successful, orderId=${result.orderId ?? "N/A"}`);
        if (sigHistId) {
          try { closeSignal(sigHistId, result.trade.price, "signal", result.trade.pnl); } catch { /* skip */ }
        }
      }
    }
  } else if (signal.type === "cover") {
    // Close short
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const sigHistId = account.positions[symbol]?.signalHistoryId;
    if (account.positions[symbol]) {
      const liveExecutor = createLiveExecutor(cfg);
      const result = await liveExecutor.handleCover(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log.info(`${label} ${symbol}: Cover successful, orderId=${result.orderId ?? "N/A"}`);
        if (sigHistId) {
          try { closeSignal(sigHistId, result.trade.price, "signal", result.trade.pnl); } catch { /* skip */ }
        }
      }
    }
  }
}

/** Record signal history and write back to paper account */
function recordSignalHistory(
  symbol: string,
  type: "buy" | "short",
  entryPrice: number,
  indicators: Indicators,
  signal: { reason: string[] },
  cfg: RuntimeConfig,
): void {
  try {
    const sigId = logSignal({
      symbol,
      type,
      entryPrice,
      conditions: {
        maShort: indicators.maShort,
        maLong: indicators.maLong,
        rsi: indicators.rsi,
        ...(indicators.atr !== undefined && { atr: indicators.atr }),
        triggeredRules: signal.reason,
      },
      scenarioId: cfg.paper.scenarioId,
      source: "live",
    });
    const acc = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    if (acc.positions[symbol]) {
      acc.positions[symbol].signalHistoryId = sigId;
      saveAccount(acc, cfg.paper.scenarioId);
    }
  } catch { /* does not affect main flow */ }
}

// ─────────────────────────────────────────────────────
// Stop Loss / Take Profit Polling
// ─────────────────────────────────────────────────────

async function checkExits(cfg: RuntimeConfig, executor?: LiveExecutor): Promise<void> {
  const execInstance = executor ?? createLiveExecutor(cfg);
  const label = cfg.exchange.testnet ? "[TESTNET]" : "[LIVE]";

  // Get current prices
  const prices: Record<string, number> = {};
  for (const symbol of cfg.symbols) {
    try {
      const kl = await getKlines(symbol, "1m", 2);
      if (kl.length > 0) prices[symbol] = kl[kl.length - 1]?.close ?? 0;
    } catch (_e: unknown) { /* ignore price fetch failure for individual symbol */ }
  }

  // Snapshot current account (to read signalHistoryId afterwards, positions still exist at this point)
  const accountSnapshot = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  const exits = await execInstance.checkExitConditions(prices);

  // G3: Check timed-out orders each round (orphan entry orders cancelled, orphan exit orders cancelled and re-triggered next round)
  // Must reload account after checkExitConditions to avoid overwriting closed position state with stale snapshot
  const freshAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  await execInstance.checkOrderTimeouts(freshAccount);
  for (const e of exits) {
    log.info(`${label} ${e.symbol}: Exit triggered — ${e.reason} (${e.pnlPercent.toFixed(2)}%)`);
    // Close signal history record (read signalHistoryId from accountSnapshot, position snapshot before closing)
    const sigHistId = accountSnapshot.positions[e.symbol]?.signalHistoryId;
    if (sigHistId) {
      try {
        const exitReason = e.reason.includes("stop_loss") || e.reason.includes("Stop loss") ? "stop_loss"
          : e.reason.includes("take_profit") || e.reason.includes("Take profit") ? "take_profit"
          : e.reason.includes("trailing") || e.reason.includes("Trailing") ? "trailing_stop"
          : e.reason.includes("time") || e.reason.includes("Time") ? "time_stop"
          : "signal";
        closeSignal(sigHistId, e.trade.price, exitReason, e.trade.pnl);
      } catch { /* skip */ }
    }
    if (cfg.notify.on_stop_loss || cfg.notify.on_take_profit) {
      notifySignal({
        symbol: e.symbol,
        type: "sell",
        price: e.trade.price,
        indicators: { maShort: 0, maLong: 0, rsi: 0, price: e.trade.price, volume: 0, avgVolume: 0 },
        reason: [e.reason],
        timestamp: Date.now(),
      });
    }
  }
}

// ─────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load config
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();

  // CLI arguments
  const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];

  // Filter testnet / live scenarios
  const scenarios = paperCfg.scenarios.filter((s) => {
    if (!s.enabled) return false;
    if (scenarioArg) return s.id === scenarioArg;
    return s.exchange.testnet === true; // Only run testnet scenarios by default
  });

  if (scenarios.length === 0) {
    console.error("❌ No enabled testnet scenarios found.");
    console.error("   Please set testnet scenario enabled to true in paper.yaml");
    console.error("   and configure API Key in .secrets/binance-testnet.json");
    process.exit(1);
  }

  log.info(`🚀 Starting live monitor, ${scenarios.length} scenario(s)`);
  log.info(`📋 Unified signal engine: processSignal() + MTF + sentiment gate + Kelly + event calendar + correlation filter`);

  // ── State file consistency check ─────────────────────────────────────
  const logsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../logs");
  for (const scenario of scenarios) {
    const stateFile = path.join(logsDir, `paper-${scenario.id}.json`);
    const configInitial = scenario.initial_usdt;
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const stateInitial = state.initialUsdt as number | undefined;
        if (configInitial && stateInitial && Math.abs(stateInitial - configInitial) > 1) {
          log.warn(
            `⚠️  [${scenario.id}] State baseline mismatch: state.initialUsdt=${stateInitial}, ` +
            `paper.yaml initial_usdt=${configInitial}. ` +
            `P&L calculation will use state file value (${stateInitial}). ` +
            `To reset: npm run paper:reset -- --scenario ${scenario.id} --set-initial ${configInitial}`
          );
        }
      } catch { /* ignore corrupted state file, reconciliation flow below will handle it */ }
    }
  }

  // ── Real CVD — aggTrade WebSocket ────────────────────
  const cvdSymbols = scenarios[0]
    ? [...new Set(scenarios.flatMap((s) => s.symbols ?? []))]
    : [];
  const cvdManager = cvdSymbols.length > 0 ? new CvdManager(cvdSymbols, { windowMs: 3_600_000 }) : null;
  if (cvdManager) {
    cvdManager.start();
    log.info(`📊 Real CVD started, monitoring ${cvdSymbols.length} symbols`);
  }

  // Test connection
  for (const scenario of scenarios) {
    const cfg = buildPaperRuntime(base, paperCfg, scenario);
    const executor = createLiveExecutor(cfg);
    const label = cfg.exchange.testnet ? "Testnet" : "Live";
    const ok = await executor.ping();
    if (!ok) {
      console.error(`❌ ${scenario.id}: Binance ${label} API connection failed, please check credentials and network`);
      process.exit(1);
    }
    const balance = await executor.syncBalance();
    log.info(`✅ ${scenario.id} [${label}]: Connection OK, USDT balance = $${balance.toFixed(2)}`);

    // ── Start reconciliation (P3.3) ──────────────────────────────
    try {
      const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
      const exchangePositions = await executor.getExchangePositions();
      const reconcile = reconcilePositions(account, exchangePositions);
      const report = formatReconcileReport(reconcile);
      log.info(report.replace(/\*\*/g, ""));

      // Auto-clean ghost positions: local has but exchange doesn't → close record at entryPrice valuation
      const ghostSymbols = reconcile.discrepancies
        .filter((d) => d.issue === "missing_exchange")
        .map((d) => d.symbol);
      if (ghostSymbols.length > 0) {
        for (const sym of ghostSymbols) {
          const pos = account.positions[sym];
          if (!pos) continue;
          const closePrice = pos.entryPrice; // Cannot get real-time price, fallback to entry price
          const proceeds = pos.quantity * closePrice;
          const ghostTrade = {
            id: `reconcile_${Date.now()}_ghost`,
            symbol: sym,
            side: "sell" as const,
            quantity: pos.quantity,
            price: closePrice,
            usdtAmount: proceeds,
            fee: 0,
            slippage: 0,
            timestamp: Date.now(),
            reason: "[Reconciliation auto-fix] Local position not found on exchange, removed from paper state",
            pnl: 0,
            pnlPercent: 0,
          };
          account.trades.push(ghostTrade);
          account.usdt += proceeds;
          delete account.positions[sym];
          saveAccount(account, cfg.paper.scenarioId);
          log.info(`🧹 [Reconciliation fix] Ghost position ${sym} removed from paper state (returned $${proceeds.toFixed(2)})`);
        }
      }

      if (reconcile.status === "critical") {
        console.error(`\n⛔ Reconciliation found critical discrepancies, startup paused, please confirm manually before restarting!`);
        process.exit(1);
      }
    } catch (err: unknown) {
      log.warn(`⚠️ Reconciliation skipped: ${String(err)}`);
    }

    // ── F2/F5: Orphan order scan ─────────────────────────
    try {
      const cancelled = await executor.scanOpenOrders();
      if (cancelled > 0) {
        log.info(`🧹 ${scenario.id}: Cancelled ${cancelled} orphan order(s)`);
      }
    } catch (err: unknown) {
      log.warn(`⚠️ Orphan order scan skipped: ${String(err)}`);
    }
  }

  // ── SIGTERM / SIGINT graceful shutdown ───────────────────────
  const handleShutdown = (sig: string) => {
    if (_state.shuttingDown) return;
    _state.shuttingDown = true;
    log.info(`\n🛑 Received ${sig}, will exit after current round completes...`);
  };
  process.on("SIGTERM", () => { handleShutdown("SIGTERM"); });
  process.on("SIGINT", () => { handleShutdown("SIGINT"); });

  // ── Persistent DataProvider (one per scenario, reused across rounds, avoids re-fetching 4h candles every 60s) ──
  // staleSec set per timeframe, ensures data refresh within <60s after new candle forms
  const dataProviders = new Map<string, DataProvider>();
  for (const scenario of scenarios) {
    const cfg = buildPaperRuntime(base, paperCfg, scenario);
    const stale = tfStaleSec(cfg.timeframe);
    dataProviders.set(scenario.id, new DataProvider(stale));
    log.info(`📦 ${scenario.id}: DataProvider cache TTL ${stale}s (timeframe=${cfg.timeframe})`);
  }

  // ── Persistent LiveExecutor (one per scenario, reused across rounds, preserves _exitRejectionLog cooldown state) ──
  const liveExecutors = new Map<string, LiveExecutor>();
  for (const scenario of scenarios) {
    const cfg = buildPaperRuntime(base, paperCfg, scenario);
    liveExecutors.set(scenario.id, createLiveExecutor(cfg));
  }

  // Polling loop
  for (;;) {
    if (_state.shuttingDown) break;

    // Watchdog heartbeat: trigger once per round, watchdog can monitor live-monitor alive status
    ping("live_monitor")();

    // P6.7: BTC crash detection
    try {
      const btcKlines = await getKlines("BTCUSDT", "1m", 2);
      const latestBtcPrice = btcKlines[btcKlines.length - 1]?.close;
      if (latestBtcPrice && latestBtcPrice > 0) {
        btcPriceBuffer.push(latestBtcPrice);
        if (btcPriceBuffer.length > MAX_BTC_PRICE_BUFFER) {
          btcPriceBuffer.shift();
        }
        if (!isKillSwitchActive() && btcPriceBuffer.length >= 10) {
          const { crash, dropPct } = checkBtcCrash(btcPriceBuffer, BTC_CRASH_THRESHOLD_PCT);
          if (crash) {
            const reason = `BTC recent drop ${dropPct.toFixed(2)}% exceeds threshold ${BTC_CRASH_THRESHOLD_PCT}%`;
            log.warn(`⛔ Auto-triggered Kill Switch: ${reason}`);
            activateKillSwitch(reason);
            notifyError("KILL_SWITCH", new Error(`⛔ Kill Switch auto-activated: ${reason}`));
          }
        }
      }
    } catch {
      // BTC price fetch failure does not affect main flow
    }

    // P6.2 On-chain stablecoin signal refresh (hourly, silently skip on failure)
    await refreshStablecoinSignal().catch(() => {});

    for (const scenario of scenarios) {
      if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition

      // P6.7: Kill Switch check
      if (isKillSwitchActive()) {
        log.warn(`⛔ Kill Switch activated, skipping scenario ${scenario.id}`);
        continue;
      }

      const cfg = buildPaperRuntime(base, paperCfg, scenario);

      // ── P6.2 Dynamic pairlist: override static symbols from config if valid ──
      const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
      const heldSymbols = Object.keys(account.positions);
      const pairlistSymbols = loadPairlistSymbols(heldSymbols);
      if (pairlistSymbols) cfg.symbols = pairlistSymbols;

      // ── DataProvider: reuse persistent instance, only re-fetch after staleSec expires ──
      const macdMinBars = cfg.strategy.macd.enabled
        ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
        : 0;
      const klineLimit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 11;
      const provider = dataProviders.get(scenario.id) ?? new DataProvider(tfStaleSec(cfg.timeframe));
      await provider.refresh(cfg.symbols, cfg.timeframe, klineLimit);
      // MTF pre-fetch
      if (cfg.trend_timeframe && cfg.trend_timeframe !== cfg.timeframe) {
        const trendLimit = cfg.strategy.ma.long + 10;
        await provider.refresh(cfg.symbols, cfg.trend_timeframe, trendLimit);
      }

      // ── Total loss protection (max_total_loss_percent) ──
      // daily_loss_limit is already checked in handleBuy/handleShort; but total loss is not checked, adding it here
      let totalLossBreached = false;
      if ((cfg.risk.max_total_loss_percent ?? 0) > 0) {
        const priceMap: Record<string, number> = {};
        for (const sym of cfg.symbols) {
          const kl = provider.get(sym, cfg.timeframe);
          const last = kl?.at(-1);
          if (last) priceMap[sym] = last.close;
        }
        const posWeightsForLoss = buildPositionWeights(account, priceMap);
        const currentEquity = account.usdt + posWeightsForLoss.reduce((s, pw) => s + pw.notionalUsdt, 0);
        const lossPct = ((account.initialUsdt - currentEquity) / account.initialUsdt) * 100;
        if (lossPct >= cfg.risk.max_total_loss_percent) {
          totalLossBreached = true;
          log.warn(
            `⛔ [${scenario.id}] Total loss ${lossPct.toFixed(2)}% exceeds limit ${cfg.risk.max_total_loss_percent}%, pausing new entries (exits still executed)`
          );
          // 30-minute cooldown, avoid notifying every round
          const lastNotify = _totalLossNotifyAt.get(scenario.id) ?? 0;
          if (Date.now() - lastNotify >= TOTAL_LOSS_NOTIFY_COOLDOWN_MS) {
            notifyError(scenario.id, new Error(
              `⛔ Total loss ${lossPct.toFixed(2)}% exceeds ${cfg.risk.max_total_loss_percent}% limit, new entries auto-paused`
            ));
            _totalLossNotifyAt.set(scenario.id, Date.now());
          }
        }
      }

      try {
        // Check stop loss/take profit first (pass persistent executor, preserving _exitRejectionLog cross-round cooldown state)
        await checkExits(cfg, liveExecutors.get(scenario.id));

        // P7.1 Portfolio exposure summary log (output when positions exist, aids risk monitoring)
        try {
          const accForExp = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
          if (Object.keys(accForExp.positions).length > 0) {
            const priceMap: Record<string, number> = {};
            for (const sym of cfg.symbols) {
              const kl = provider.get(sym, cfg.timeframe);
              const last = kl?.at(-1);
              if (last) priceMap[sym] = last.close;
            }
            const posWeights = buildPositionWeights(accForExp, priceMap);
            const totalEquity = accForExp.usdt + posWeights.reduce((s, pw) => s + pw.notionalUsdt, 0);
            const klinesBySymbol: Record<string, Kline[]> = {};
            for (const sym of cfg.symbols) {
              const kl = provider.get(sym, cfg.timeframe);
              if (kl) klinesBySymbol[sym] = kl;
            }
            const exposure = calcPortfolioExposure(posWeights, totalEquity, klinesBySymbol);
            log.info(`[${scenario.id}] ${formatPortfolioExposure(exposure).replace(/\*\*/g, "")}`);
          }
        } catch { /* exposure summary failure does not affect main flow */ }

        // Then detect buy/sell signals (skip entries when total loss exceeded)
        if (totalLossBreached) continue;
        for (const symbol of cfg.symbols) {
          if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
          await processSymbol(symbol, cfg, provider).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`❌ ${scenario.id} ${symbol}: ${msg}`);
            if (cfg.notify.on_error) notifyError(symbol, new Error(msg));
          });
          // Brief wait between symbols to avoid Binance rate limiting
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`❌ Scenario ${scenario.id} runtime error: ${msg}`);
      }
    }

    if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    log.info(`⏰ Waiting ${POLL_INTERVAL_MS / 1000}s before next round...`);
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  cvdManager?.stop();
  log.info("✅ Live monitor safely exited.");
  process.exit(0);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Fatal:", msg);
  process.exit(1);
});

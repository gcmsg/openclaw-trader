/**
 * openclaw-trader main monitoring script
 * Triggered every minute by cron
 * In paper mode, runs all enabled scenarios in parallel, each with an independent account
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "./logger.js";
import { getKlines } from "./exchange/binance.js";
import { DataProvider } from "./exchange/data-provider.js";

import { notifySignal, notifyError, notifyPaperTrade, notifyStopLoss } from "./notify/openclaw.js";
import {
  handleSignal,
  checkExitConditions,
  checkMaxDrawdown,
  checkDailyLossLimit,
  checkDcaTranches,
  formatSummaryMessage,
} from "./paper/engine.js";
import { loadNewsReport, evaluateSentimentGate } from "./news/sentiment-gate.js";
import { checkMtfFilter } from "./strategy/mtf-filter.js";
import { loadRecentTrades } from "./strategy/recent-trades.js";
import { readSentimentCache } from "./news/sentiment-cache.js";
import { processSignal } from "./strategy/signal-engine.js";
import { fetchFundingRatePct } from "./strategy/funding-rate-signal.js";
import { getBtcDominanceTrend } from "./strategy/btc-dominance.js";
import { readEmergencyHalt } from "./news/emergency-monitor.js";
import { checkEventRisk, loadCalendar } from "./strategy/events-calendar.js";
import { readCvdCache } from "./exchange/order-flow.js";
import { calcKellyRatio } from "./strategy/kelly.js";
import { loadAccount } from "./paper/account.js";
import type { PaperAccount } from "./paper/account.js";
import {
  calcCorrelationAdjustedSize,
  calcPortfolioExposure,
  formatPortfolioExposure,
} from "./strategy/portfolio-risk.js";
import type { PositionWeight } from "./strategy/portfolio-risk.js";
import { ping } from "./health/heartbeat.js";
import { isKillSwitchActive } from "./health/kill-switch.js";
import { loadRuntimeConfigs } from "./config/loader.js";
import type { RuntimeConfig, Signal, Indicators, Kline } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("monitor", path.resolve(__dirname, "../logs/monitor.log"));
// Per-scenario pause state: logs/state-{scenarioId}.json
function getStatePath(scenarioId: string): string {
  return path.resolve(__dirname, `../logs/state-${scenarioId}.json`);
}

// ─────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────

interface MonitorState {
  lastSignals: Record<string, { type: string; timestamp: number }>;
  lastReportAt: number;
  paused: boolean;
}

function loadState(scenarioId: string): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(scenarioId), "utf-8")) as MonitorState;
  } catch (_e: unknown) {
    // First creation: set lastReportAt to current time to avoid triggering empty report on first run
    return { lastSignals: {}, lastReportAt: Date.now(), paused: false };
  }
}

function saveState(scenarioId: string, state: MonitorState): void {
  fs.mkdirSync(path.dirname(getStatePath(scenarioId)), { recursive: true });
  fs.writeFileSync(getStatePath(scenarioId), JSON.stringify(state, null, 2));
}

function shouldNotify(state: MonitorState, signal: Signal, minIntervalMinutes: number): boolean {
  const last = state.lastSignals[signal.symbol];
  if (last?.type !== signal.type) return true;
  return (Date.now() - last.timestamp) / 60000 >= minIntervalMinutes;
}

// ─────────────────────────────────────────────────────
// Scan a single symbol (within a scenario)
// ─────────────────────────────────────────────────────

async function scanSymbol(
  symbol: string,
  cfg: RuntimeConfig,
  state: MonitorState,
  currentPrices: Record<string, number>,
  scenarioPrefix: string,
  provider: DataProvider
): Promise<void> {
  try {
    // Calculate required kline count: max of MA, RSI, MACD, plus 10 bars buffer
    const macdMinBars = cfg.strategy.macd.enabled
      ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
      : 0;
    const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

    // Prefer DataProvider cache (reduce duplicate API requests)
    let klines = provider.get(symbol, cfg.timeframe);
    if (!klines || klines.length < limit) {
      // Cache miss (first time or expired), fall back to direct fetch
      klines = await getKlines(symbol, cfg.timeframe, limit + 1);
      if (klines.length < limit) return;
    }

    // ── Multi-timeframe trend filter (MTF) — using shared function (A-001 fix) ──
    const mtfCheck = await checkMtfFilter(symbol, "buy", cfg, provider);
    const mtfTrendBull = mtfCheck.trendBull;
    if (mtfCheck.trendBull !== null) {
      log.info(`${scenarioPrefix}${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfCheck.trendBull ? "Bullish✅" : "Bearish🚫"}`);
    }

    // ── Build external context (CVD / funding rate / BTC dominance / position side / correlation klines) ──
    let externalCvd: number | undefined;
    let externalFundingRate: number | undefined;
    let externalBtcDom: number | undefined;
    let externalBtcDomChange: number | undefined;

    // Funding rate (futures/perpetual, with 10min cache, silently skip on failure)
    try {
      const frPct = await fetchFundingRatePct(symbol);
      if (frPct !== undefined) externalFundingRate = frPct;
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Funding rate fetch failed: ${e instanceof Error ? e.message : String(e)}`); }

    // BTC dominance trend (read history file, non-blocking)
    try {
      const domTrend = getBtcDominanceTrend();
      if (!isNaN(domTrend.latest)) {
        externalBtcDom = domTrend.latest;
        externalBtcDomChange = domTrend.change;
      }
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ BTC dominance fetch failed: ${e instanceof Error ? e.message : String(e)}`); }

    // Real CVD (if CvdManager is running and has written to cache, prefer real data)
    try {
      const realCvd = readCvdCache(symbol) as { cvd?: number; updatedAt?: number } | undefined;
      const maxAgeMs = 5 * 60_000;
      if (realCvd?.cvd !== undefined && realCvd.updatedAt !== undefined &&
          Date.now() - realCvd.updatedAt < maxAgeMs) {
        externalCvd = realCvd.cvd;
      }
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ CVD cache read failed: ${e instanceof Error ? e.message : String(e)}`); }

    // Current position side + held position klines (for correlation check inside processSignal)
    const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    // side is optional for legacy data compatibility: default to "long" when position exists but side is undefined
    const _monPos = currentAccount.positions[symbol];
    const currentPosSide: "long" | "short" | undefined = _monPos ? (_monPos.side ?? "long") : undefined;
    const heldKlinesMap: Record<string, Kline[]> = {};
    if (cfg.risk.correlation_filter?.enabled) {
      const heldSymbols = Object.keys(currentAccount.positions).filter((s) => s !== symbol);
      const corrLookback = cfg.risk.correlation_filter.lookback;
      await Promise.all(
        heldSymbols.map(async (sym) => {
          try {
            // Prefer DataProvider cache
            const cached = provider.get(sym, cfg.timeframe);
            heldKlinesMap[sym] = cached ?? await getKlines(sym, cfg.timeframe, corrLookback + 1);
          } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Correlation kline(${sym}) fetch failed: ${e instanceof Error ? e.message : String(e)}`); }
        })
      );
    }

    // ── Unified signal engine (F3) ────────────────────────────────
    const onchainSignal = readOnchainSignal();
    const externalCtx = {
      ...(externalCvd !== undefined ? { cvd: externalCvd } : {}),
      ...(externalFundingRate !== undefined ? { fundingRate: externalFundingRate } : {}),
      ...(externalBtcDom !== undefined ? { btcDominance: externalBtcDom } : {}),
      ...(externalBtcDomChange !== undefined ? { btcDomChange: externalBtcDomChange } : {}),
      ...(currentPosSide !== undefined ? { currentPosSide } : {}),
      ...(Object.keys(heldKlinesMap).length > 0 ? { heldKlinesMap } : {}),
      ...(onchainSignal !== undefined ? { stablecoinSignal: onchainSignal } : {}),
    };
    const recentTrades = loadRecentTrades();
    const engineResult = processSignal(symbol, klines, cfg, externalCtx, recentTrades);

    if (!engineResult.indicators) return;

    const { indicators, signal, effectiveRisk, effectivePositionRatio, rejected, rejectionReason, regimeLabel } = engineResult;
    const regimeEffectiveRisk = effectiveRisk;

    currentPrices[symbol] = indicators.price;

    const trend = indicators.maShort > indicators.maLong ? "📈 Bullish" : "📉 Bearish";
    const macdInfo = indicators.macd
      ? ` MACD=${indicators.macd.macd.toFixed(2)}/${indicators.macd.signal.toFixed(2)}`
      : "";
    const volRatio =
      indicators.avgVolume > 0 ? (indicators.volume / indicators.avgVolume).toFixed(2) : "?";

    log.info(
      `${scenarioPrefix}${symbol}: Price=${indicators.price.toFixed(4)}, ` +
        `MA_Short=${indicators.maShort.toFixed(4)}, MA_Long=${indicators.maLong.toFixed(4)}, ` +
        `RSI=${indicators.rsi.toFixed(1)},${macdInfo} Volume=${volRatio}x, ${trend}, Signal=${signal.type}` +
        (regimeLabel ? ` [${regimeLabel}]` : "")
    );

    if (rejected) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 ${rejectionReason ?? "filtered"}`);
      return;
    }

    if (signal.type === "none") return;

    // 🐛 Fix: Notification cooldown takes effect before MTF/sentiment filters, preventing filtered signals from bypassing min_interval_minutes
    // If last signal type is the same and cooldown hasn't expired, skip (don't update lastSignals, wait for cooldown to expire)
    if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;
    // Record signal timestamp (consumes a cooldown window regardless of subsequent MTF/sentiment filtering)
    state.lastSignals[signal.symbol] = { type: signal.type, timestamp: Date.now() };

    // portfolioRatioOverride: from engine (position ratio after correlation/regime adjustment)
    const portfolioRatioOverride: number | undefined = effectivePositionRatio;

    // Breaking news emergency halt (entry signals only; stop-loss/take-profit exits unaffected)
    if (signal.type === "buy" || signal.type === "short") {
      const emergencyState = readEmergencyHalt();
      if (emergencyState.halt) {
        log.warn(`${scenarioPrefix}${symbol}: ⛔ Emergency halt: ${emergencyState.reason ?? "Breaking high-risk news"}`);
        return;
      }
    }

    // P6.5 Macro event calendar risk control (entry signals only)
    if (signal.type === "buy" || signal.type === "short") {
      try {
        const eventRisk = checkEventRisk(loadCalendar());
        if (eventRisk.phase === "during") {
          log.info(`${scenarioPrefix}${symbol}: ⏸ Event window active (${eventRisk.eventName}), pausing entries`);
          return;
        }
        // pre / post phase: log only, sentiment gate will further adjust on top of this
        if ((eventRisk.phase === "pre" || eventRisk.phase === "post") && eventRisk.positionRatioMultiplier < 1.0) {
          const baseRatio = portfolioRatioOverride ?? regimeEffectiveRisk.position_ratio;
          const approxRatio = baseRatio * eventRisk.positionRatioMultiplier;
          log.warn(`${scenarioPrefix}${symbol}: ⚠️ Event risk period (${eventRisk.eventName}), suggested position ≈ ${(approxRatio * 100).toFixed(0)}% (×${eventRisk.positionRatioMultiplier})`);
        }
      } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Event calendar load failed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // MTF filter: buy signal but higher timeframe is bearish -> skip
    if (signal.type === "buy" && mtfTrendBull === false) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 MTF trend filter: ${cfg.trend_timeframe} bearish, ignoring 1h buy signal`);
      return;
    }
    // MTF filter: short signal but higher timeframe is bullish -> skip
    if (signal.type === "short" && mtfTrendBull === true) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 MTF trend filter: ${cfg.trend_timeframe} bullish, ignoring 1h short signal`);
      return;
    }

    // Sentiment gate
    const newsReport = loadNewsReport();
    // Sentiment gate uses "combined adjusted position ratio" as baseline (double stacked reduction)
    const baseForGate = portfolioRatioOverride ?? regimeEffectiveRisk.position_ratio;
    const sentimentCache = readSentimentCache();  // Read LLM sentiment cache from disk
    const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
    log.info(`${scenarioPrefix}${symbol}: Sentiment gate -> ${gate.action} (${gate.reason})`);
    if (gate.action === "skip") return;

    if (cfg.mode === "paper") {
      let effectiveRatio = "positionRatio" in gate ? gate.positionRatio : baseForGate;

      // Kelly dynamic position sizing (only effective for entry signals)
      if (
        cfg.risk.position_sizing === "kelly" &&
        (signal.type === "buy" || signal.type === "short")
      ) {
        try {
          const histPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../logs/signal-history.jsonl");
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
            log.info(`${scenarioPrefix}${symbol}: 🎯 Kelly → ${kellyResult.reason}`);
            effectiveRatio = kellyResult.ratio;
          }
        } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Kelly calculation failed: ${e instanceof Error ? e.message : String(e)}`); }
      }

      // P7.1 Portfolio Risk: continuous correlation heat position reduction (entry signals only)
      // Complements the binary filter in signal-engine: continuously reduce position for moderate correlations
      if (signal.type === "buy" || signal.type === "short") {
        try {
          const priceMap: Record<string, number> = { [symbol]: indicators.price };
          for (const [sym, klns] of Object.entries(heldKlinesMap)) {
            const last = klns.at(-1);
            if (last) priceMap[sym] = last.close;
          }
          const posWeights = buildPositionWeights(currentAccount, priceMap)
            .filter((pw) => pw.symbol !== symbol);
          if (posWeights.length > 0) {
            const klinesBySymbol: Record<string, Kline[]> = { [symbol]: klines, ...heldKlinesMap };
            const portfolioHeat = calcCorrelationAdjustedSize(
              symbol,
              signal.type === "buy" ? "long" : "short",
              effectiveRatio,
              posWeights,
              klinesBySymbol,
            );
            log.info(`${scenarioPrefix}${symbol}: 📊 Portfolio heat ${(portfolioHeat.heat * 100).toFixed(0)}% -> ${portfolioHeat.decision} (${portfolioHeat.reason})`);
            if (portfolioHeat.decision === "blocked") return;
            effectiveRatio = portfolioHeat.adjustedPositionRatio;
          }
        } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Portfolio heat calculation failed: ${e instanceof Error ? e.message : String(e)}`); }
      }

      // P5.2: Merge regime parameter overrides (TP/SL/ROI Table etc.) + position ratio adjustment
      const adjustedCfg = { ...cfg, risk: { ...regimeEffectiveRisk, position_ratio: effectiveRatio } };
      const result = handleSignal(signal, adjustedCfg);

      if (result.skipped) {
        log.info(`${scenarioPrefix}${symbol}: ⏭️ Skipped — ${result.skipped}`);
      }
      if (result.trade) {
        const action = result.trade.side === "buy" ? "Buy(OpenLong)" : result.trade.side === "short" ? "OpenShort" : result.trade.side === "cover" ? "CoverShort" : "Sell(CloseLong)";
        log.info(
          `${scenarioPrefix}${symbol}: 📝 Paper ${action} @${result.trade.price.toFixed(4)} (position ${(effectiveRatio * 100).toFixed(0)}%)`
        );
        notifyPaperTrade(result.trade, result.account);
      }
      if (gate.action === "warn") {
        notifyError(symbol, new Error(`⚠️ Sentiment warning: ${gate.reason}`));
      }
    } else if (cfg.mode === "notify_only" && cfg.notify.on_signal) {
      notifySignal(signal);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${scenarioPrefix}${symbol}: Error - ${error.message}`);
    if (cfg.notify.on_error) notifyError(symbol, error);
  }
}

// ─────────────────────────────────────────────────────
// Portfolio Risk helpers (P7.1)
// ─────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────
// Run a single scenario
// ─────────────────────────────────────────────────────

// P6.2 Dynamic pairlist: read logs/current-pairlist.json, override static symbols from config if valid
const PAIRLIST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../logs/current-pairlist.json");
const PAIRLIST_MAX_AGE_MS = 25 * 60 * 60 * 1000;

// P6.2 On-chain stablecoin flow cache (written by live-monitor, read-only in monitor.ts)
const ONCHAIN_CACHE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../logs/onchain-cache.json");
function readOnchainSignal(): "accumulation" | "distribution" | "neutral" | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(ONCHAIN_CACHE_PATH, "utf-8")) as { stablecoinSignal: string; fetchedAt: number };
    if (Date.now() - d.fetchedAt > 2 * 60 * 60 * 1000) return undefined;
    return d.stablecoinSignal as "accumulation" | "distribution" | "neutral";
  } catch { return undefined; }
}

function loadPairlistSymbols(heldSymbols: string[]): string[] | null {
  try {
    const raw = fs.readFileSync(PAIRLIST_PATH, "utf-8");
    const data = JSON.parse(raw) as { symbols: string[]; updatedAt: number };
    if (Date.now() - data.updatedAt > PAIRLIST_MAX_AGE_MS) return null;
    return [...new Set([...data.symbols, ...heldSymbols])];
  } catch {
    return null;
  }
}

async function runScenario(cfg: RuntimeConfig): Promise<void> {
  const sid = cfg.paper.scenarioId;
  const marketLabel = `[${cfg.exchange.market.toUpperCase()}${cfg.exchange.leverage?.enabled ? ` ${cfg.exchange.leverage.default}x` : ""}]`;
  const prefix = `${marketLabel} `;
  const state = loadState(sid);

  // P6.2 pairlist override
  const heldSymbols = Object.keys(loadAccount(cfg.paper.initial_usdt, sid).positions);
  const pairlistSymbols = loadPairlistSymbols(heldSymbols);
  if (pairlistSymbols) cfg.symbols = pairlistSymbols;

  // When paused / Kill Switch active, still run stop-loss/take-profit checks to avoid unmanaged positions
  // Only skip "new signal scan" part; exit conditions must continue executing
  if (state.paused || isKillSwitchActive()) {
    if (state.paused) log.warn(`${prefix}⚠️ Strategy paused (max loss limit triggered)`);
    if (isKillSwitchActive()) log.warn(`${prefix}⛔ Kill Switch active, skipping scan`);

    // Fetch real-time prices for held symbols separately, run stop-loss/take-profit
    if (heldSymbols.length > 0) {
      const pausedPrices: Record<string, number> = {};
      await Promise.all(heldSymbols.map(async (sym) => {
        try {
          const klines = await getKlines(sym, cfg.timeframe, 3);
          if (klines.length > 0) pausedPrices[sym] = klines[klines.length - 1]!.close;
        } catch { /* Price fetch failed, skip this symbol */ }
      }));
      if (Object.keys(pausedPrices).length > 0) {
        const exits = checkExitConditions(pausedPrices, cfg);
        for (const { symbol, trade, reason, pnlPercent } of exits) {
          const label = reason === "take_profit" ? "Take-Profit" : reason === "trailing_stop" ? "Trailing-Stop" : "Stop-Loss";
          log.info(`${prefix}${symbol}: [Paused] ${label} triggered @ $${trade.price.toFixed(4)} (${pnlPercent.toFixed(2)}%)`);
        }
      }
    }
    return;
  }

  const currentPrices: Record<string, number> = {};

  // ── DataProvider: pre-fetch all symbol klines to reduce duplicate API requests ──
  const macdMinBars = cfg.strategy.macd.enabled
    ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
    : 0;
  const klineLimit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 11;
  const provider = new DataProvider(30);
  await provider.refresh(cfg.symbols, cfg.timeframe, klineLimit);
  // MTF pre-fetch (if trend_timeframe is configured)
  if (cfg.trend_timeframe && cfg.trend_timeframe !== cfg.timeframe) {
    const trendLimit = cfg.strategy.ma.long + 10;
    await provider.refresh(cfg.symbols, cfg.trend_timeframe, trendLimit);
  }

  // Concurrent scan (batch size 3)
  const BATCH = 3;
  for (let i = 0; i < cfg.symbols.length; i += BATCH) {
    const batch = cfg.symbols.slice(i, i + BATCH);
    await Promise.all(batch.map((sym) => scanSymbol(sym, cfg, state, currentPrices, prefix, provider)));
  }

  // Stop-loss / take-profit / trailing-stop check
  if (Object.keys(currentPrices).length > 0) {
    const exits = checkExitConditions(currentPrices, cfg);
    for (const { symbol, trade, reason, pnlPercent } of exits) {
      const emoji = reason === "take_profit" ? "🎯" : "🚨";
      const label =
        reason === "take_profit" ? "Take-Profit" :
        reason === "trailing_stop" ? "Trailing-Stop" :
        reason === "time_stop" ? "Time-Stop" : "Stop-Loss";
      log.info(`${prefix}${symbol}: ${emoji} ${label} triggered (${pnlPercent.toFixed(2)}%)`);
      if (reason !== "take_profit") {
        // stop_loss / trailing_stop / time_stop all send stop-loss notification
        notifyStopLoss(symbol, trade.price / (1 + pnlPercent / 100), trade.price, pnlPercent / 100);
      } else if (cfg.notify.on_take_profit) {
        // Take-profit notification reuses notifySignal; indicators are only for message formatting, filled with placeholder data
        const placeholderIndicators: Indicators = {
          maShort: trade.price,
          maLong: trade.price,
          rsi: 50,
          price: trade.price,
          volume: 0,
          avgVolume: 0,
        };
        notifySignal({
          symbol,
          type: "sell",
          price: trade.price,
          indicators: placeholderIndicators,
          reason: [`Take-Profit: +${pnlPercent.toFixed(2)}%`],
          timestamp: Date.now(),
        });
      }
    }

    // ── DCA tranche check ─────────────────────────────────────
    if (cfg.risk.dca?.enabled) {
      const dcaResults = checkDcaTranches(currentPrices, cfg);
      for (const { symbol, trade, tranche, totalTranches } of dcaResults) {
        log.info(`${prefix}${symbol}: 💰 DCA tranche ${tranche}/${totalTranches} @${trade.price.toFixed(4)} (${trade.usdtAmount.toFixed(2)} USDT)`);
        notifyPaperTrade(trade, loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId));
      }
    }

    if (checkDailyLossLimit(currentPrices, cfg)) {
      log.warn(`${prefix}⚠️ Daily loss reached ${cfg.risk.daily_loss_limit_percent}%, pausing entries for today`);
    }

    if (checkMaxDrawdown(currentPrices, cfg)) {
      log.error(`${prefix}🚨 Total loss exceeded limit, scenario paused!`);
      state.paused = true;
      notifyError(
        `${marketLabel} RiskControl`,
        new Error(
          `Total loss exceeded ${cfg.risk.max_total_loss_percent}% limit, ${marketLabel} paper trading auto-paused`
        )
      );
    }

    // Periodic account report
    const intervalMs = cfg.paper.report_interval_hours * 3600000;
    if (intervalMs > 0 && Date.now() - state.lastReportAt >= intervalMs) {
      log.info(`${prefix}📊 Sending periodic account report`);
      const msg = formatSummaryMessage(currentPrices, cfg);
      const { spawnSync } = await import("child_process");
      const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
      const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
      const args = ["system", "event", "--mode", "now"];
      if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
      args.push("--text", msg);
      spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
      state.lastReportAt = Date.now();
    }
  }

  // P7.1 Portfolio exposure summary log (output when positions exist, aids risk monitoring)
  try {
    const accForExp = loadAccount(cfg.paper.initial_usdt, sid);
    if (Object.keys(accForExp.positions).length > 0) {
      const priceMap: Record<string, number> = { ...currentPrices };
      const posWeights = buildPositionWeights(accForExp, priceMap);
      const totalEquity = accForExp.usdt + posWeights.reduce((s, pw) => s + pw.notionalUsdt, 0);
      const klinesBySymbol: Record<string, Kline[]> = {};
      for (const sym of cfg.symbols) {
        const kl = provider.get(sym, cfg.timeframe);
        if (kl) klinesBySymbol[sym] = kl;
      }
      const exposure = calcPortfolioExposure(posWeights, totalEquity, klinesBySymbol);
      log.info(`[${sid}] ${formatPortfolioExposure(exposure).replace(/\*\*/g, "")}`);
    }
  } catch { /* exposure summary failure doesn't affect main flow */ }

  saveState(sid, state);
}

// ─────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("─── Monitor scan started ───");
  if (!process.env["OPENCLAW_GATEWAY_TOKEN"]) {
    log.warn("⚠️ OPENCLAW_GATEWAY_TOKEN env not set, notifications will be unavailable");
  }
  const done = ping("price_monitor");

  const runtimes = loadRuntimeConfigs();
  const firstRuntime = runtimes[0];
  if (!firstRuntime) { log.warn("No available strategy config"); return; }
  if (!firstRuntime.strategy.enabled) {
    log.info("Strategy disabled");
    done();
    return;
  }

  const mode = firstRuntime.mode;
  const scenarioNames = runtimes.map((r) => r.paper.scenarioId).join(", ");
  log.info(`Mode: ${mode} | Scenarios: ${scenarioNames} | Default symbols: ${firstRuntime.symbols.join(", ")}`);

  // Skip testnet scenarios (handled exclusively by live-monitor.ts, avoids paper account file conflicts)
  const paperOnly = runtimes.filter((cfg) => !cfg.exchange.testnet);
  const skipped = runtimes.filter((cfg) => cfg.exchange.testnet).map((c) => c.paper.scenarioId);
  if (skipped.length > 0) {
    log.info(`⏭ Skipping testnet scenarios (managed by live-monitor.ts): ${skipped.join(", ")}`);
  }
  // All paper scenarios run in parallel
  await Promise.all(paperOnly.map((cfg) => runScenario(cfg)));

  done();
  log.info("─── Monitor scan complete ───\n");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

/**
 * WebSocket Real-time Kline Monitor (Long-running Process)
 *
 * Compared to monitor.ts (cron polling):
 * - Latency: 60s → <1s
 * - Only runs strategy on kline close (avoids decisions based on incomplete candles)
 * - Stop-loss/take-profit: polls price every 60s (independent of kline close)
 *
 * Start: npm run ws-monitor
 * Stop: Ctrl+C or SIGTERM
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getKlines } from "../exchange/binance.js";
import { BinanceWsManager } from "../exchange/ws.js";
import { calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import { notifySignal, notifyError, notifyPaperTrade, notifyStopLoss } from "../notify/openclaw.js";
import {
  handleSignal,
  checkExitConditions,
  checkMaxDrawdown,
  checkDailyLossLimit,
  formatSummaryMessage,
} from "../paper/engine.js";
import { loadNewsReport, evaluateSentimentGate } from "../news/sentiment-gate.js";
import { checkCorrelation } from "../strategy/correlation.js";
import { loadAccount } from "../paper/account.js";
import { ping } from "../health/heartbeat.js";
import { loadRuntimeConfigs } from "../config/loader.js";
import { createLogger } from "../logger.js";
import type { RuntimeConfig, Signal, Indicators, Kline } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("ws-monitor", path.resolve(__dirname, "../../logs/ws-monitor.log"));

function getStatePath(scenarioId: string): string {
  return path.resolve(__dirname, `../logs/state-${scenarioId}.json`);
}

interface MonitorState {
  lastSignals: Record<string, { type: string; timestamp: number }>;
  lastReportAt: number;
  paused: boolean;
}

function loadState(scenarioId: string): MonitorState {
  try {
    return JSON.parse(
      fs.readFileSync(getStatePath(scenarioId), "utf-8")
    ) as MonitorState;
  } catch {
    return { lastSignals: {}, lastReportAt: Date.now(), paused: false };
  }
}

function saveState(scenarioId: string, state: MonitorState): void {
  fs.mkdirSync(path.dirname(getStatePath(scenarioId)), { recursive: true });
  fs.writeFileSync(getStatePath(scenarioId), JSON.stringify(state, null, 2));
}

function shouldNotify(
  state: MonitorState,
  signal: Signal,
  minIntervalMinutes: number
): boolean {
  const last = state.lastSignals[signal.symbol];
  if (last?.type !== signal.type) return true;
  return (Date.now() - last.timestamp) / 60000 >= minIntervalMinutes;
}

// ─────────────────────────────────────────────────────
// Kline Rolling Buffer
// ─────────────────────────────────────────────────────

/** Each symbol maintains a rolling kline window for real-time indicator calculation */
type KlineBuffer = Map<string, Kline[]>;

/** Preload historical klines (REST) to prepare for subsequent WebSocket updates */
async function preloadKlines(
  symbols: string[],
  interval: string,
  limit: number
): Promise<KlineBuffer> {
  const buffer: KlineBuffer = new Map();
  const BATCH = 3;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (symbol) => {
        try {
          const klines = await getKlines(symbol, interval, limit);
          buffer.set(symbol, klines);
          log.info(`Preloaded ${symbol} klines: ${klines.length} bars`);
        } catch (err: unknown) {
          log.error(`Failed to preload ${symbol}: ${String(err)}`);
        }
      })
    );
  }
  return buffer;
}

/** Append a new closed kline to the buffer, maintaining a fixed length */
function appendKline(buffer: KlineBuffer, symbol: string, kline: Kline, maxLen: number): void {
  const existing = buffer.get(symbol) ?? [];
  // If the last bar has the same openTime, replace (update); otherwise append
  if (existing.length > 0 && existing[existing.length - 1]?.openTime === kline.openTime) {
    existing[existing.length - 1] = kline;
  } else {
    existing.push(kline);
    if (existing.length > maxLen) existing.shift();
  }
  buffer.set(symbol, existing);
}

// ─────────────────────────────────────────────────────
// Strategy Scan (single symbol + single scenario)
// ─────────────────────────────────────────────────────

async function runStrategy(
  symbol: string,
  klines: Kline[],
  cfg: RuntimeConfig,
  state: MonitorState,
  currentPrices: Record<string, number>,
  buffer: KlineBuffer
): Promise<void> {
  const indicators = calculateIndicators(
    klines,
    cfg.strategy.ma.short,
    cfg.strategy.ma.long,
    cfg.strategy.rsi.period,
    cfg.strategy.macd
  );
  if (!indicators) return;

  currentPrices[symbol] = indicators.price;

  // MTF trend filter (if trend_timeframe is configured)
  let mtfTrendBull: boolean | null = null;
  if (cfg.trend_timeframe && cfg.trend_timeframe !== cfg.timeframe) {
    try {
      const trendLimit = cfg.strategy.ma.long + 10;
      const trendKlines = await getKlines(symbol, cfg.trend_timeframe, trendLimit);
      const trendInd = calculateIndicators(
        trendKlines,
        cfg.strategy.ma.short,
        cfg.strategy.ma.long,
        cfg.strategy.rsi.period,
        cfg.strategy.macd
      );
      if (trendInd) {
        mtfTrendBull = trendInd.maShort > trendInd.maLong;
        log.info(
          `[${cfg.paper.scenarioId}] ${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfTrendBull ? "Bullish✅" : "Bearish🚫"}`
        );
      }
    } catch {
      log.warn(`[${cfg.paper.scenarioId}] ${symbol}: MTF fetch failed, skipping trend filter`);
    }
  }

  const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  // side is optional for backward compatibility: default to "long" when position exists but side is undefined
  const _wsPos = currentAccount.positions[symbol];
  const currentPosSide: "long" | "short" | undefined = _wsPos ? (_wsPos.side ?? "long") : undefined;
  const signal = detectSignal(symbol, indicators, cfg, currentPosSide);

  // MTF filter
  if (signal.type === "buy" && mtfTrendBull === false) {
    log.info(
      `[${cfg.paper.scenarioId}] ${symbol}: 🚫 MTF filtered (${cfg.trend_timeframe} bearish), ignoring buy`
    );
    return;
  }
  if (signal.type === "short" && mtfTrendBull === true) {
    log.info(
      `[${cfg.paper.scenarioId}] ${symbol}: 🚫 MTF filtered (${cfg.trend_timeframe} bullish), ignoring short`
    );
    return;
  }

  const trend = indicators.maShort > indicators.maLong ? "Bullish" : "Bearish";
  log.info(
    `[${cfg.paper.scenarioId}] ${symbol}: price=${indicators.price.toFixed(4)}, ` +
      `RSI=${indicators.rsi.toFixed(1)}, ${trend}, signal=${signal.type}`
  );

  if (signal.type === "none") return;

  // ── Correlation filter (buy signals only) ──────────────────────────
  if (signal.type === "buy" && cfg.risk.correlation_filter?.enabled) {
    const corrCfg = cfg.risk.correlation_filter;
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const heldSymbols = Object.keys(account.positions);
    if (heldSymbols.length > 0) {
      const heldKlines = new Map<string, Kline[]>();
      await Promise.all(
        heldSymbols.map(async (sym) => {
          try {
            // Prefer existing buffer to avoid extra REST requests
            const cached = buffer.get(sym);
            if (cached && cached.length >= corrCfg.lookback) {
              heldKlines.set(sym, cached.slice(-corrCfg.lookback - 1));
            } else {
              const k = await getKlines(sym, cfg.timeframe, corrCfg.lookback + 1);
              heldKlines.set(sym, k);
            }
          } catch {
            // Fetch failure does not block buy
          }
        })
      );
      const corrResult = checkCorrelation(symbol, klines, heldKlines, corrCfg.threshold);
      if (corrResult.correlated) {
        log.info(`[${cfg.paper.scenarioId}] ${symbol}: 🔗 Correlation filter → ${corrResult.reason}`);
        return;
      }
    }
  }

  // Sentiment gate
  const newsReport = loadNewsReport();
  const gate = evaluateSentimentGate(signal, newsReport, cfg.risk.position_ratio);
  log.info(`[${cfg.paper.scenarioId}] ${symbol}: Sentiment gate → ${gate.action} (${gate.reason})`);
  if (gate.action === "skip") return;

  if (cfg.mode === "paper") {
    if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;

    const effectiveRatio =
      "positionRatio" in gate ? gate.positionRatio : cfg.risk.position_ratio;
    const adjustedCfg = { ...cfg, risk: { ...cfg.risk, position_ratio: effectiveRatio } };
    const result = handleSignal(signal, adjustedCfg);

    if (result.skipped) {
      log.info(`[${cfg.paper.scenarioId}] ${symbol}: ⏭️ Skipped — ${result.skipped}`);
    }
    if (result.trade) {
      const action = result.trade.side === "buy" ? "Buy (open long)" : result.trade.side === "short" ? "Open short" : result.trade.side === "cover" ? "Cover short" : "Sell (close long)";
      log.info(
        `[${cfg.paper.scenarioId}] ${symbol}: 📝 Paper ${action} @${result.trade.price.toFixed(4)}`
      );
      notifyPaperTrade(result.trade, result.account);
    }
    if (gate.action === "warn") {
      notifyError(symbol, new Error(`⚠️ Sentiment warning: ${gate.reason}`));
    }
    state.lastSignals[signal.symbol] = { type: signal.type, timestamp: Date.now() };
  } else if (cfg.mode === "notify_only" && cfg.notify.on_signal) {
    if (shouldNotify(state, signal, cfg.notify.min_interval_minutes)) {
      notifySignal(signal);
      state.lastSignals[signal.symbol] = { type: signal.type, timestamp: Date.now() };
    }
  }
}

// ─────────────────────────────────────────────────────
// Stop-loss/Take-profit Polling (every minute, independent of kline close)
// ─────────────────────────────────────────────────────

async function checkExits(
  cfg: RuntimeConfig,
  currentPrices: Record<string, number>
): Promise<void> {
  if (Object.keys(currentPrices).length === 0) return;
  const sid = cfg.paper.scenarioId;
  const state = loadState(sid);

  // Note: state.paused only blocks new entry signals, not exit checks
  // After total loss circuit break, stop-loss/take-profit must still execute to avoid stuck positions
  // (New entry blocking is at line 397: if (state.paused) continue)

  const exits = checkExitConditions(currentPrices, cfg);
  for (const { symbol, trade, reason, pnlPercent } of exits) {
    const emoji = reason === "take_profit" ? "🎯" : "🚨";
    const label =
      reason === "take_profit" ? "Take profit" :
      reason === "trailing_stop" ? "Trailing stop" :
      reason === "time_stop" ? "Time stop" : "Stop loss";
    log.info(`[${sid}] ${symbol}: ${emoji} ${label} triggered (${pnlPercent.toFixed(2)}%)`);
    if (reason !== "take_profit") {
      // stop_loss / trailing_stop / time_stop all send stop-loss notification
      notifyStopLoss(symbol, trade.price / (1 + pnlPercent / 100), trade.price, pnlPercent / 100);
    } else if (cfg.notify.on_take_profit) {
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
        reason: [`Take profit: +${pnlPercent.toFixed(2)}%`],
        timestamp: Date.now(),
      });
    }
  }

  if (checkDailyLossLimit(currentPrices, cfg)) {
    log.warn(`[${sid}] ⚠️ Daily loss reached ${cfg.risk.daily_loss_limit_percent}%, pausing new entries for today`);
  }

  if (checkMaxDrawdown(currentPrices, cfg)) {
    log.error(`[${sid}] 🚨 Total loss exceeded limit, scenario paused!`);
    state.paused = true;
    saveState(sid, state);
    notifyError(
      `[${sid}]`,
      new Error(`Total loss exceeded ${cfg.risk.max_total_loss_percent}%, paper trading paused`)
    );
  }

  // Periodic account report
  const intervalMs = cfg.paper.report_interval_hours * 3600000;
  if (intervalMs > 0 && Date.now() - state.lastReportAt >= intervalMs) {
    log.info(`[${sid}] 📊 Sending periodic account report`);
    const msg = formatSummaryMessage(currentPrices, cfg);
    const { spawnSync } = await import("child_process");
    const OPENCLAW_BIN = process.env["OPENCLAW_BIN"] ?? "openclaw";
    const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";
    const args = ["system", "event", "--mode", "now"];
    if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
    args.push("--text", msg);
    spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
    state.lastReportAt = Date.now();
    saveState(sid, state);
  }
}

// ─────────────────────────────────────────────────────
// Main Entry
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("─── WebSocket Monitor Started ───");

  const runtimes = loadRuntimeConfigs();
  const firstRuntime = runtimes[0];
  if (!firstRuntime) { log.error("No available strategy config"); return; }
  if (!firstRuntime.strategy.enabled) {
    log.info("Strategy is disabled, exiting");
    return;
  }

  // Union (deduplicated) of all scenario symbols + same timeframe
  const allSymbols = [...new Set(runtimes.flatMap((r) => r.symbols))];
  const timeframe = firstRuntime.timeframe;

  // Calculate the maximum number of klines needed
  const maxLimit = Math.max(
    ...runtimes.map((r) => {
      const macdMin = r.strategy.macd.enabled ? r.strategy.macd.slow + r.strategy.macd.signal + 1 : 0;
      return Math.max(r.strategy.ma.long, r.strategy.rsi.period, macdMin) + 20;
    })
  );

  log.info(`Scenarios: ${runtimes.map((r) => r.paper.scenarioId).join(", ")}`);
  log.info(`Watching symbols: ${allSymbols.join(", ")} | Timeframe: ${timeframe} | Buffer: ${maxLimit} bars`);

  // Preload historical klines (REST)
  const buffer = await preloadKlines(allSymbols, timeframe, maxLimit);

  // Current price summary (for stop-loss/take-profit polling)
  const currentPrices: Record<string, number> = {};
  for (const [symbol, klines] of buffer) {
    if (klines.length > 0) {
      currentPrices[symbol] = klines[klines.length - 1]?.close ?? 0;
    }
  }

  // ── WebSocket Connection ──────────────────────────────────
  const wsManager = new BinanceWsManager(allSymbols, timeframe, (msg: string) => log.info(msg));

  wsManager.subscribe(async ({ symbol, kline, isClosed }) => {
    // Update price regardless of close (faster stop-loss response)
    currentPrices[symbol] = kline.close;

    if (!isClosed) return; // Only run strategy on kline close

    log.info(`Kline closed: ${symbol} close=${kline.close.toFixed(4)}`);
    appendKline(buffer, symbol, kline, maxLimit);

    const klines = buffer.get(symbol);
    if (!klines || klines.length < maxLimit / 2) return;

    // Run strategy for all scenarios
    for (const cfg of runtimes) {
      if (!cfg.symbols.includes(symbol)) continue;
      const state = loadState(cfg.paper.scenarioId);
      if (state.paused) continue;
      try {
        await runStrategy(symbol, klines, cfg, state, currentPrices, buffer);
        saveState(cfg.paper.scenarioId, state);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(`[${cfg.paper.scenarioId}] ${symbol}: Strategy error - ${error.message}`);
        if (cfg.notify.on_error) notifyError(symbol, error);
      }
    }
  });

  wsManager.start();

  // ── Stop-loss/Take-profit Polling (every 60s) ────────────────────────────
  const EXIT_POLL_MS = 60 * 1000;
  setInterval(() => {
    void ping("ws_monitor");
    for (const cfg of runtimes) {
      void checkExits(cfg, { ...currentPrices });
    }
  }, EXIT_POLL_MS);

  // ── Graceful Shutdown ─────────────────────────────────────────
  function shutdown(signal: string): void {
    log.info(`Received ${signal}, shutting down...`);
    wsManager.stop();
    process.exit(0);
  }

  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });

  log.info(`✅ WebSocket monitor running, waiting for kline close events...`);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

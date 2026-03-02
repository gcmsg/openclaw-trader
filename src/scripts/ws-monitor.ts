/**
 * WebSocket 实时 K 线监控（长驻进程）
 *
 * 与 monitor.ts（cron 轮询）相比：
 * - 延迟：60s → <1s
 * - 只在 K 线收盘时运行策略（避免基于未完结 K 线决策）
 * - 止损/止盈：每 60s 轮询一次价格（不依赖 K 线关闭）
 *
 * 启动：npm run ws-monitor
 * 停止：Ctrl+C 或 SIGTERM
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
// K 线滚动缓冲区
// ─────────────────────────────────────────────────────

/** 每个 symbol 维护一个滚动 K 线窗口，用于实时计算指标 */
type KlineBuffer = Map<string, Kline[]>;

/** 预加载历史 K 线（REST），为后续 WebSocket 推送做准备 */
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
          log.info(`预加载 ${symbol} K 线 ${klines.length} 根`);
        } catch (err: unknown) {
          log.error(`预加载 ${symbol} 失败: ${String(err)}`);
        }
      })
    );
  }
  return buffer;
}

/** 将新收盘 K 线追加到缓冲区，维持固定长度 */
function appendKline(buffer: KlineBuffer, symbol: string, kline: Kline, maxLen: number): void {
  const existing = buffer.get(symbol) ?? [];
  // 若最后一根 openTime 相同则替换（更新），否则追加
  if (existing.length > 0 && existing[existing.length - 1]?.openTime === kline.openTime) {
    existing[existing.length - 1] = kline;
  } else {
    existing.push(kline);
    if (existing.length > maxLen) existing.shift();
  }
  buffer.set(symbol, existing);
}

// ─────────────────────────────────────────────────────
// 策略扫描（单 symbol + 单场景）
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

  // MTF 趋势过滤（如果配置了 trend_timeframe）
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
          `[${cfg.paper.scenarioId}] ${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfTrendBull ? "多头✅" : "空头🚫"}`
        );
      }
    } catch {
      log.warn(`[${cfg.paper.scenarioId}] ${symbol}: MTF 获取失败，跳过趋势过滤`);
    }
  }

  const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  // side 可选字段兼容旧数据：有持仓但 side 未定义时默认 "long"
  const _wsPos = currentAccount.positions[symbol];
  const currentPosSide: "long" | "short" | undefined = _wsPos ? (_wsPos.side ?? "long") : undefined;
  const signal = detectSignal(symbol, indicators, cfg, currentPosSide);

  // MTF 过滤
  if (signal.type === "buy" && mtfTrendBull === false) {
    log.info(
      `[${cfg.paper.scenarioId}] ${symbol}: 🚫 MTF 过滤（${cfg.trend_timeframe} 空头），忽略买入`
    );
    return;
  }
  if (signal.type === "short" && mtfTrendBull === true) {
    log.info(
      `[${cfg.paper.scenarioId}] ${symbol}: 🚫 MTF 过滤（${cfg.trend_timeframe} 多头），忽略开空`
    );
    return;
  }

  const trend = indicators.maShort > indicators.maLong ? "多头" : "空头";
  log.info(
    `[${cfg.paper.scenarioId}] ${symbol}: 价格=${indicators.price.toFixed(4)}, ` +
      `RSI=${indicators.rsi.toFixed(1)}, ${trend}, 信号=${signal.type}`
  );

  if (signal.type === "none") return;

  // ── 相关性过滤（仅对买入信号）──────────────────────────
  if (signal.type === "buy" && cfg.risk.correlation_filter?.enabled) {
    const corrCfg = cfg.risk.correlation_filter;
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const heldSymbols = Object.keys(account.positions);
    if (heldSymbols.length > 0) {
      const heldKlines = new Map<string, Kline[]>();
      await Promise.all(
        heldSymbols.map(async (sym) => {
          try {
            // 优先用已有缓冲区，避免额外 REST 请求
            const cached = buffer.get(sym);
            if (cached && cached.length >= corrCfg.lookback) {
              heldKlines.set(sym, cached.slice(-corrCfg.lookback - 1));
            } else {
              const k = await getKlines(sym, cfg.timeframe, corrCfg.lookback + 1);
              heldKlines.set(sym, k);
            }
          } catch {
            // 获取失败不阻断买入
          }
        })
      );
      const corrResult = checkCorrelation(symbol, klines, heldKlines, corrCfg.threshold);
      if (corrResult.correlated) {
        log.info(`[${cfg.paper.scenarioId}] ${symbol}: 🔗 相关性过滤 → ${corrResult.reason}`);
        return;
      }
    }
  }

  // 情绪门控
  const newsReport = loadNewsReport();
  const gate = evaluateSentimentGate(signal, newsReport, cfg.risk.position_ratio);
  log.info(`[${cfg.paper.scenarioId}] ${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);
  if (gate.action === "skip") return;

  if (cfg.mode === "paper") {
    if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;

    const effectiveRatio =
      "positionRatio" in gate ? gate.positionRatio : cfg.risk.position_ratio;
    const adjustedCfg = { ...cfg, risk: { ...cfg.risk, position_ratio: effectiveRatio } };
    const result = handleSignal(signal, adjustedCfg);

    if (result.skipped) {
      log.info(`[${cfg.paper.scenarioId}] ${symbol}: ⏭️ 跳过 — ${result.skipped}`);
    }
    if (result.trade) {
      const action = result.trade.side === "buy" ? "买入(开多)" : result.trade.side === "short" ? "开空" : result.trade.side === "cover" ? "平空" : "卖出(平多)";
      log.info(
        `[${cfg.paper.scenarioId}] ${symbol}: 📝 模拟${action} @${result.trade.price.toFixed(4)}`
      );
      notifyPaperTrade(result.trade, result.account);
    }
    if (gate.action === "warn") {
      notifyError(symbol, new Error(`⚠️ 情绪警告：${gate.reason}`));
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
// 止损/止盈轮询（每分钟，独立于 K 线收盘）
// ─────────────────────────────────────────────────────

async function checkExits(
  cfg: RuntimeConfig,
  currentPrices: Record<string, number>
): Promise<void> {
  if (Object.keys(currentPrices).length === 0) return;
  const sid = cfg.paper.scenarioId;
  const state = loadState(sid);

  if (state.paused) return;

  const exits = checkExitConditions(currentPrices, cfg);
  for (const { symbol, trade, reason, pnlPercent } of exits) {
    const emoji = reason === "take_profit" ? "🎯" : "🚨";
    const label =
      reason === "take_profit" ? "止盈" :
      reason === "trailing_stop" ? "追踪止损" :
      reason === "time_stop" ? "时间止损" : "止损";
    log.info(`[${sid}] ${symbol}: ${emoji} ${label}触发（${pnlPercent.toFixed(2)}%）`);
    if (reason !== "take_profit") {
      // stop_loss / trailing_stop / time_stop 均发送止损通知
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
        reason: [`止盈: +${pnlPercent.toFixed(2)}%`],
        timestamp: Date.now(),
      });
    }
  }

  if (checkDailyLossLimit(currentPrices, cfg)) {
    log.warn(`[${sid}] ⚠️ 今日亏损达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`);
  }

  if (checkMaxDrawdown(currentPrices, cfg)) {
    log.error(`[${sid}] 🚨 总亏损超限，场景已暂停！`);
    state.paused = true;
    saveState(sid, state);
    notifyError(
      `[${sid}]`,
      new Error(`总亏损超过 ${cfg.risk.max_total_loss_percent}%，模拟盘已暂停`)
    );
  }

  // 定期账户汇报
  const intervalMs = cfg.paper.report_interval_hours * 3600000;
  if (intervalMs > 0 && Date.now() - state.lastReportAt >= intervalMs) {
    log.info(`[${sid}] 📊 发送定期账户汇报`);
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
// 主入口
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("─── WebSocket 监控启动 ───");

  const runtimes = loadRuntimeConfigs();
  const firstRuntime = runtimes[0];
  if (!firstRuntime) { log.error("无可用策略配置"); return; }
  if (!firstRuntime.strategy.enabled) {
    log.info("策略已禁用，退出");
    return;
  }

  // 所有场景取并集（去重）的 symbols + 相同 timeframe
  const allSymbols = [...new Set(runtimes.flatMap((r) => r.symbols))];
  const timeframe = firstRuntime.timeframe;

  // 计算最大需要的 K 线数量
  const maxLimit = Math.max(
    ...runtimes.map((r) => {
      const macdMin = r.strategy.macd.enabled ? r.strategy.macd.slow + r.strategy.macd.signal + 1 : 0;
      return Math.max(r.strategy.ma.long, r.strategy.rsi.period, macdMin) + 20;
    })
  );

  log.info(`场景: ${runtimes.map((r) => r.paper.scenarioId).join(", ")}`);
  log.info(`监听 symbol: ${allSymbols.join(", ")} | 时间框架: ${timeframe} | 缓冲 ${maxLimit} 根`);

  // 预加载历史 K 线（REST）
  const buffer = await preloadKlines(allSymbols, timeframe, maxLimit);

  // 当前价格汇总（止损/止盈轮询用）
  const currentPrices: Record<string, number> = {};
  for (const [symbol, klines] of buffer) {
    if (klines.length > 0) {
      currentPrices[symbol] = klines[klines.length - 1]?.close ?? 0;
    }
  }

  // ── WebSocket 连接 ──────────────────────────────────
  const wsManager = new BinanceWsManager(allSymbols, timeframe, (msg: string) => log.info(msg));

  wsManager.subscribe(async ({ symbol, kline, isClosed }) => {
    // 无论是否收盘都更新价格（止损响应更快）
    currentPrices[symbol] = kline.close;

    if (!isClosed) return; // 只在 K 线收盘时运行策略

    log.info(`K 线收盘: ${symbol} close=${kline.close.toFixed(4)}`);
    appendKline(buffer, symbol, kline, maxLimit);

    const klines = buffer.get(symbol);
    if (!klines || klines.length < maxLimit / 2) return;

    // 对所有场景运行策略
    for (const cfg of runtimes) {
      if (!cfg.symbols.includes(symbol)) continue;
      const state = loadState(cfg.paper.scenarioId);
      if (state.paused) continue;
      try {
        await runStrategy(symbol, klines, cfg, state, currentPrices, buffer);
        saveState(cfg.paper.scenarioId, state);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(`[${cfg.paper.scenarioId}] ${symbol}: 策略错误 - ${error.message}`);
        if (cfg.notify.on_error) notifyError(symbol, error);
      }
    }
  });

  wsManager.start();

  // ── 止损/止盈轮询（每 60s）────────────────────────────
  const EXIT_POLL_MS = 60 * 1000;
  setInterval(() => {
    void ping("ws_monitor");
    for (const cfg of runtimes) {
      void checkExits(cfg, { ...currentPrices });
    }
  }, EXIT_POLL_MS);

  // ── 优雅退出 ─────────────────────────────────────────
  function shutdown(signal: string): void {
    log.info(`收到 ${signal}，正在关闭...`);
    wsManager.stop();
    process.exit(0);
  }

  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });

  log.info(`✅ WebSocket 监控运行中，等待 K 线收盘事件...`);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

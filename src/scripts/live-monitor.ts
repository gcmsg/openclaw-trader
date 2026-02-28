/**
 * Live / Testnet 实盘监控脚本
 *
 * 功能：连接 Binance 真实 API（testnet 或 production），
 * 使用统一信号引擎进行实际下单。
 *
 * 与 monitor.ts（cron）使用完全相同的信号管线：
 *   processSignal() → regime 感知 → 相关性过滤 → R:R → protection
 *   → MTF 趋势过滤 → 紧急暂停 → 事件日历 → 情绪门控 → Kelly 仓位
 *
 * 使用方式：
 *   npm run live          # Testnet 模式（从 paper.yaml 加载 testnet 场景）
 *   npm run live -- --scenario testnet-default
 */

import fs from "fs";
import path from "path";
import { getKlines } from "../exchange/binance.js";
import { checkMtfFilter } from "../strategy/mtf-filter.js";
import { loadRecentTrades } from "../strategy/recent-trades.js";
import { processSignal } from "../strategy/signal-engine.js";
import { loadStrategyConfig, loadPaperConfig, buildPaperRuntime } from "../config/loader.js";
import { createLiveExecutor } from "../live/executor.js";
import { reconcilePositions, formatReconcileReport } from "../live/reconcile.js";
import { loadNewsReport, evaluateSentimentGate } from "../news/sentiment-gate.js";
import { readSentimentCache } from "../news/sentiment-cache.js";
import { notifySignal, notifyError } from "../notify/openclaw.js";
import { loadAccount, saveAccount } from "../paper/account.js";
import { logSignal, closeSignal } from "../strategy/signal-history.js";
import { readEmergencyHalt } from "../news/emergency-monitor.js";
import { checkEventRisk, loadCalendar } from "../strategy/events-calendar.js";
import { CvdManager, readCvdCache } from "../exchange/order-flow.js";
import { fetchFundingRatePct } from "../strategy/funding-rate-signal.js";
import { getBtcDominanceTrend } from "../strategy/btc-dominance.js";
import { calcKellyRatio } from "../strategy/kelly.js";
import { DataProvider } from "../exchange/data-provider.js";
import {
  isKillSwitchActive,
  activateKillSwitch,
  checkBtcCrash,
} from "../health/kill-switch.js";
import type { RuntimeConfig, Kline, Indicators } from "../types.js";
import { createLogger } from "../logger.js";

const POLL_INTERVAL_MS = 60 * 1000; // 1 分钟轮询
const BTC_CRASH_THRESHOLD_PCT = 8;  // BTC 1小时跌幅触发阈值（默认 8%）
const MAX_BTC_PRICE_BUFFER = 60;    // 保留最近 60 个价格点（约 1 小时，1分钟一个）

// ── 最近 BTC 价格缓冲（用于崩盘检测）──
const btcPriceBuffer: number[] = [];

// ── 优雅退出标志（用对象包裹，避免 no-unnecessary-condition 误报）──
const _state = { shuttingDown: false };

const log = createLogger("live-monitor");

// ─────────────────────────────────────────────────────
// 单轮信号检测 + 执行（一个场景所有 symbol）
// ─────────────────────────────────────────────────────

async function processSymbol(
  symbol: string,
  cfg: RuntimeConfig,
  provider: DataProvider,
): Promise<void> {
  const label = cfg.exchange.testnet ? "[TESTNET]" : "[LIVE]";

  // ── 拉取 K 线 ─────────────────────────────────────
  const macdCfg = cfg.strategy.macd;
  const macdMinBars = macdCfg.enabled ? macdCfg.slow + macdCfg.signal + 1 : 0;
  const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

  let klines = provider.get(symbol, cfg.timeframe);
  if (!klines || klines.length < limit) {
    klines = await getKlines(symbol, cfg.timeframe, limit + 1);
    if (klines.length < limit) {
      log.info(`${label} ${symbol}: K 线数量不足（${klines.length}/${limit}），跳过`);
      return;
    }
  }

  // ── 构建外部上下文（与 monitor.ts 完全一致）─────────
  let externalCvd: number | undefined;
  let externalFundingRate: number | undefined;
  let externalBtcDom: number | undefined;
  let externalBtcDomChange: number | undefined;

  // 资金费率
  try {
    const frPct = await fetchFundingRatePct(symbol);
    if (frPct !== undefined) externalFundingRate = frPct;
  } catch { /* 失败静默跳过 */ }

  // BTC 主导率
  try {
    const domTrend = getBtcDominanceTrend();
    if (!isNaN(domTrend.latest)) {
      externalBtcDom = domTrend.latest;
      externalBtcDomChange = domTrend.change;
    }
  } catch { /* 失败静默跳过 */ }

  // CVD
  try {
    const realCvd = readCvdCache(symbol) as { cvd?: number; updatedAt?: number } | undefined;
    const maxAgeMs = 5 * 60_000;
    if (realCvd?.cvd !== undefined && realCvd.updatedAt !== undefined &&
        Date.now() - realCvd.updatedAt < maxAgeMs) {
      externalCvd = realCvd.cvd;
    }
  } catch { /* 失败静默跳过 */ }

  // 当前持仓方向 + 相关性 K 线
  const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  const currentPosSide = currentAccount.positions[symbol]?.side;
  const heldKlinesMap: Record<string, Kline[]> = {};
  if (cfg.risk.correlation_filter?.enabled) {
    const heldSymbols = Object.keys(currentAccount.positions).filter((s) => s !== symbol);
    const corrLookback = cfg.risk.correlation_filter.lookback;
    await Promise.all(
      heldSymbols.map(async (sym) => {
        try {
          const cached = provider.get(sym, cfg.timeframe);
          heldKlinesMap[sym] = cached ?? await getKlines(sym, cfg.timeframe, corrLookback + 1);
        } catch { /* 获取失败跳过 */ }
      })
    );
  }

  // ── 统一信号引擎（与 monitor.ts 完全一致）──────────
  const externalCtx = {
    ...(externalCvd !== undefined ? { cvd: externalCvd } : {}),
    ...(externalFundingRate !== undefined ? { fundingRate: externalFundingRate } : {}),
    ...(externalBtcDom !== undefined ? { btcDominance: externalBtcDom } : {}),
    ...(externalBtcDomChange !== undefined ? { btcDomChange: externalBtcDomChange } : {}),
    ...(currentPosSide !== undefined ? { currentPosSide } : {}),
    ...(Object.keys(heldKlinesMap).length > 0 ? { heldKlinesMap } : {}),
  };
  const recentTrades = loadRecentTrades();
  const engineResult = processSignal(symbol, klines, cfg, externalCtx, recentTrades);

  if (!engineResult.indicators) {
    log.info(`${label} ${symbol}: 指标计算失败，跳过`);
    return;
  }

  const { indicators, signal, effectiveRisk, effectivePositionRatio, rejected, rejectionReason, regimeLabel } = engineResult;

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

  if (signal.type === "none") return;

  // ── 以下为开仓信号额外过滤（买入/开空）─────────────
  if (signal.type === "buy" || signal.type === "short") {
    // 紧急暂停
    const emergency = readEmergencyHalt();
    if (emergency.halt) {
      log.warn(`${label} ${symbol}: ⛔ 紧急暂停 — ${emergency.reason ?? "突发高危新闻"}`);
      return;
    }

    // P6.5 事件日历风险控制
    try {
      const eventRisk = checkEventRisk(loadCalendar());
      if (eventRisk.phase === "during") {
        log.info(`${label} ${symbol}: ⏸ 事件窗口期（${eventRisk.eventName}），暂停开仓`);
        return;
      }
      if ((eventRisk.phase === "pre" || eventRisk.phase === "post") && eventRisk.positionRatioMultiplier < 1.0) {
        log.warn(`${label} ${symbol}: ⚠️ 事件风险期（${eventRisk.eventName}），仓位 ×${eventRisk.positionRatioMultiplier}`);
      }
    } catch { /* 日历加载失败静默跳过 */ }

    // MTF 趋势过滤 — 使用共享函数（A-001 fix）
    const mtfCheck = await checkMtfFilter(symbol, signal.type, cfg, provider);
    if (mtfCheck.trendBull !== null) {
      log.info(`${label} ${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfCheck.trendBull ? "多头✅" : "空头🚫"}`);
    }
    if (mtfCheck.filtered) {
      log.info(`${label} ${symbol}: 🚫 ${mtfCheck.reason}`);
      return;
    }

    // 情绪门控
    const newsReport = loadNewsReport();
    const baseForGate = effectivePositionRatio ?? effectiveRisk.position_ratio;
    const sentimentCache = readSentimentCache();
    const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
    log.info(`${label} ${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);
    if (gate.action === "skip") return;

    // Kelly 动态仓位
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
      } catch { /* Kelly 计算失败不影响主流程 */ }
    }

    // ── 构建最终配置 → 执行 ──────────────────────────
    const adjustedCfg = { ...cfg, risk: { ...effectiveRisk, position_ratio: effectiveRatio } };
    const liveExecutor = createLiveExecutor(adjustedCfg);

    if (cfg.notify.on_signal) notifySignal(signal);

    if (signal.type === "buy") {
      const result = await liveExecutor.handleBuy(signal);
      if (result.skipped) {
        log.info(`${label} ${symbol}: 跳过 — ${result.skipped}`);
      } else if (result.trade) {
        log.info(`${label} ${symbol}: 买入成功 @${result.trade.price.toFixed(4)}（仓位 ${(effectiveRatio * 100).toFixed(0)}%），orderId=${result.orderId ?? "N/A"}`);
        recordSignalHistory(symbol, "buy", result.trade.price, indicators, signal, cfg);
      }
    } else if (signal.type === "short") {
      const result = await liveExecutor.handleShort(signal);
      if (result.skipped) {
        log.info(`${label} ${symbol}: 跳过开空 — ${result.skipped}`);
      } else if (result.trade) {
        log.info(`${label} ${symbol}: 开空成功 @${result.trade.price.toFixed(4)}（仓位 ${(effectiveRatio * 100).toFixed(0)}%），orderId=${result.orderId ?? "N/A"}`);
        recordSignalHistory(symbol, "short", result.trade.price, indicators, signal, cfg);
      }
    }
  } else if (signal.type === "sell") {
    // 平多
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const sigHistId = account.positions[symbol]?.signalHistoryId;
    if (account.positions[symbol]) {
      const liveExecutor = createLiveExecutor(cfg);
      const result = await liveExecutor.handleSell(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log.info(`${label} ${symbol}: 卖出成功，orderId=${result.orderId ?? "N/A"}`);
        if (sigHistId) {
          try { closeSignal(sigHistId, result.trade.price, "signal", result.trade.pnl); } catch { /* skip */ }
        }
      }
    }
  } else if (signal.type === "cover") {
    // 平空
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const sigHistId = account.positions[symbol]?.signalHistoryId;
    if (account.positions[symbol]) {
      const liveExecutor = createLiveExecutor(cfg);
      const result = await liveExecutor.handleCover(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log.info(`${label} ${symbol}: 平空成功，orderId=${result.orderId ?? "N/A"}`);
        if (sigHistId) {
          try { closeSignal(sigHistId, result.trade.price, "signal", result.trade.pnl); } catch { /* skip */ }
        }
      }
    }
  }
}

/** 记录信号历史并写回 paper 账户 */
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
  } catch { /* 不影响主流程 */ }
}

// ─────────────────────────────────────────────────────
// 止损/止盈轮询
// ─────────────────────────────────────────────────────

async function checkExits(cfg: RuntimeConfig): Promise<void> {
  const executor = createLiveExecutor(cfg);
  const label = cfg.exchange.testnet ? "[TESTNET]" : "[LIVE]";

  // 获取当前价格
  const prices: Record<string, number> = {};
  for (const symbol of cfg.symbols) {
    try {
      const kl = await getKlines(symbol, "1m", 2);
      if (kl.length > 0) prices[symbol] = kl[kl.length - 1]?.close ?? 0;
    } catch (_e: unknown) { /* 忽略单个 symbol 的价格获取失败 */ }
  }

  const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  const exits = await executor.checkExitConditions(prices);

  // G3: 每轮检查超时订单（孤儿入场单取消，孤儿出场单取消后下轮重触发）
  await executor.checkOrderTimeouts(account);
  for (const e of exits) {
    log.info(`${label} ${e.symbol}: 触发出场 — ${e.reason} (${e.pnlPercent.toFixed(2)}%)`);
    // 关闭信号历史记录
    const sigHistId = account.positions[e.symbol]?.signalHistoryId;
    if (sigHistId) {
      try {
        const exitReason = e.reason.includes("止损") ? "stop_loss"
          : e.reason.includes("止盈") || e.reason.includes("take_profit") ? "take_profit"
          : e.reason.includes("trailing") || e.reason.includes("追踪") ? "trailing_stop"
          : e.reason.includes("time") || e.reason.includes("时间") ? "time_stop"
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
// 主循环
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 加载配置
  const base = loadStrategyConfig();
  const paperCfg = loadPaperConfig();

  // 命令行参数
  const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];

  // 筛选 testnet / live 场景
  const scenarios = paperCfg.scenarios.filter((s) => {
    if (!s.enabled) return false;
    if (scenarioArg) return s.id === scenarioArg;
    return s.exchange.testnet === true; // 默认只运行 testnet 场景
  });

  if (scenarios.length === 0) {
    console.error("❌ 没有找到启用的 testnet 场景。");
    console.error("   请在 paper.yaml 中将 testnet 场景的 enabled 设为 true");
    console.error("   并在 .secrets/binance-testnet.json 中配置 API Key");
    process.exit(1);
  }

  log.info(`🚀 启动实盘监控，共 ${scenarios.length} 个场景`);
  log.info(`📋 统一信号引擎：processSignal() + MTF + 情绪门控 + Kelly + 事件日历 + 相关性过滤`);

  // ── 真实 CVD — aggTrade WebSocket ────────────────────
  const cvdSymbols = scenarios[0]
    ? [...new Set(scenarios.flatMap((s) => s.symbols ?? []))]
    : [];
  const cvdManager = cvdSymbols.length > 0 ? new CvdManager(cvdSymbols, { windowMs: 3_600_000 }) : null;
  if (cvdManager) {
    cvdManager.start();
    log.info(`📊 真实 CVD 已启动，监控 ${cvdSymbols.length} 个 symbol`);
  }

  // 测试连接
  for (const scenario of scenarios) {
    const cfg = buildPaperRuntime(base, paperCfg, scenario);
    const executor = createLiveExecutor(cfg);
    const label = cfg.exchange.testnet ? "Testnet" : "Live";
    const ok = await executor.ping();
    if (!ok) {
      console.error(`❌ ${scenario.id}: Binance ${label} API 连接失败，请检查凭证和网络`);
      process.exit(1);
    }
    const balance = await executor.syncBalance();
    log.info(`✅ ${scenario.id} [${label}]: 连接正常，USDT 余额 = $${balance.toFixed(2)}`);

    // ── 启动对账（P3.3）──────────────────────────────
    try {
      const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
      const exchangePositions = await executor.getExchangePositions();
      const reconcile = reconcilePositions(account, exchangePositions);
      const report = formatReconcileReport(reconcile);
      log.info(report.replace(/\*\*/g, ""));
      if (reconcile.status === "critical") {
        console.error(`\n⛔ 对账发现严重差异，暂停启动，请人工确认后重启！`);
        process.exit(1);
      }
    } catch (err: unknown) {
      log.warn(`⚠️ 对账跳过：${String(err)}`);
    }

    // ── F2/F5: 孤儿订单扫描 ─────────────────────────
    try {
      const cancelled = await executor.scanOpenOrders();
      if (cancelled > 0) {
        log.info(`🧹 ${scenario.id}: 已取消 ${cancelled} 个孤儿挂单`);
      }
    } catch (err: unknown) {
      log.warn(`⚠️ 孤儿订单扫描跳过：${String(err)}`);
    }
  }

  // ── SIGTERM / SIGINT 优雅退出 ───────────────────────
  const handleShutdown = (sig: string) => {
    if (_state.shuttingDown) return;
    _state.shuttingDown = true;
    log.info(`\n🛑 收到 ${sig}，完成当前轮次后退出...`);
  };
  process.on("SIGTERM", () => { handleShutdown("SIGTERM"); });
  process.on("SIGINT", () => { handleShutdown("SIGINT"); });

  // 轮询循环
  for (;;) {
    if (_state.shuttingDown) break;

    // P6.7: BTC 崩盘检测
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
            const reason = `BTC 近期跌幅 ${dropPct.toFixed(2)}% 超过阈值 ${BTC_CRASH_THRESHOLD_PCT}%`;
            log.warn(`⛔ 自动触发 Kill Switch: ${reason}`);
            activateKillSwitch(reason);
            notifyError("KILL_SWITCH", new Error(`⛔ Kill Switch 自动激活: ${reason}`));
          }
        }
      }
    } catch {
      // BTC 价格获取失败不影响主流程
    }

    for (const scenario of scenarios) {
      if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition

      // P6.7: Kill Switch 检查
      if (isKillSwitchActive()) {
        log.warn(`⛔ Kill Switch 激活，跳过场景 ${scenario.id}`);
        continue;
      }

      const cfg = buildPaperRuntime(base, paperCfg, scenario);

      // ── DataProvider：预拉所有 symbol K 线，减少重复 API 请求 ──
      const macdMinBars = cfg.strategy.macd.enabled
        ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
        : 0;
      const klineLimit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 11;
      const provider = new DataProvider(30);
      await provider.refresh(cfg.symbols, cfg.timeframe, klineLimit);
      // MTF 预拉
      if (cfg.trend_timeframe && cfg.trend_timeframe !== cfg.timeframe) {
        const trendLimit = cfg.strategy.ma.long + 10;
        await provider.refresh(cfg.symbols, cfg.trend_timeframe, trendLimit);
      }

      try {
        // 先检查止损/止盈
        await checkExits(cfg);

        // 再检测买卖信号
        for (const symbol of cfg.symbols) {
          if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
          await processSymbol(symbol, cfg, provider).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`❌ ${scenario.id} ${symbol}: ${msg}`);
            if (cfg.notify.on_error) notifyError(symbol, new Error(msg));
          });
          // 每个 symbol 间短暂等待，避免触发 Binance 限频
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`❌ 场景 ${scenario.id} 运行异常: ${msg}`);
      }
    }

    if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    log.info(`⏰ 等待 ${POLL_INTERVAL_MS / 1000}s 后下一轮...`);
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  cvdManager?.stop();
  log.info("✅ Live monitor 已安全退出。");
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

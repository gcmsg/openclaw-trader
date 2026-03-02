/**
 * openclaw-trader 主监控脚本
 * 每分钟由 cron 触发
 * paper 模式下并行运行所有启用的场景，每个场景独立账户
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
// 每个场景独立暂停状态：logs/state-{scenarioId}.json
function getStatePath(scenarioId: string): string {
  return path.resolve(__dirname, `../logs/state-${scenarioId}.json`);
}

// ─────────────────────────────────────────────────────
// 工具
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
    // 首次创建：lastReportAt 设为当前时间，避免首次运行立即触发空报告
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
// 扫描单个 symbol（在某个场景下）
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
    // 计算所需 K 线数量：取 MA、RSI、MACD 三者的最大值，多留 10 根余量
    const macdMinBars = cfg.strategy.macd.enabled
      ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
      : 0;
    const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;

    // 优先从 DataProvider 缓存取（减少重复 API 请求）
    let klines = provider.get(symbol, cfg.timeframe);
    if (!klines || klines.length < limit) {
      // 缓存未命中（首次或过期），回退到直接拉取
      klines = await getKlines(symbol, cfg.timeframe, limit + 1);
      if (klines.length < limit) return;
    }

    // ── 多时间框架趋势过滤（MTF）— 使用共享函数（A-001 fix）──
    const mtfCheck = await checkMtfFilter(symbol, "buy", cfg, provider);
    const mtfTrendBull = mtfCheck.trendBull;
    if (mtfCheck.trendBull !== null) {
      log.info(`${scenarioPrefix}${symbol}: MTF(${cfg.trend_timeframe}) → ${mtfCheck.trendBull ? "多头✅" : "空头🚫"}`);
    }

    // ── 构建外部上下文（CVD / 资金费率 / BTC 主导率 / 持仓方向 / 相关性 K 线）──
    let externalCvd: number | undefined;
    let externalFundingRate: number | undefined;
    let externalBtcDom: number | undefined;
    let externalBtcDomChange: number | undefined;

    // 资金费率（期货/永续合约，带10分钟缓存，失败静默跳过）
    try {
      const frPct = await fetchFundingRatePct(symbol);
      if (frPct !== undefined) externalFundingRate = frPct;
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ 资金费率获取失败: ${e instanceof Error ? e.message : String(e)}`); }

    // BTC 主导率趋势（读历史文件，非阻塞）
    try {
      const domTrend = getBtcDominanceTrend();
      if (!isNaN(domTrend.latest)) {
        externalBtcDom = domTrend.latest;
        externalBtcDomChange = domTrend.change;
      }
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ BTC 主导率获取失败: ${e instanceof Error ? e.message : String(e)}`); }

    // 真实 CVD（若 CvdManager 已运行并写入缓存，优先用真实数据）
    try {
      const realCvd = readCvdCache(symbol) as { cvd?: number; updatedAt?: number } | undefined;
      const maxAgeMs = 5 * 60_000;
      if (realCvd?.cvd !== undefined && realCvd.updatedAt !== undefined &&
          Date.now() - realCvd.updatedAt < maxAgeMs) {
        externalCvd = realCvd.cvd;
      }
    } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ CVD 缓存读取失败: ${e instanceof Error ? e.message : String(e)}`); }

    // 当前持仓方向 + 持仓 K 线（用于 processSignal 内部的相关性检查）
    const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    // side 可选字段兼容旧数据：有持仓但 side 未定义时默认 "long"
    const _monPos = currentAccount.positions[symbol];
    const currentPosSide: "long" | "short" | undefined = _monPos ? (_monPos.side ?? "long") : undefined;
    const heldKlinesMap: Record<string, Kline[]> = {};
    if (cfg.risk.correlation_filter?.enabled) {
      const heldSymbols = Object.keys(currentAccount.positions).filter((s) => s !== symbol);
      const corrLookback = cfg.risk.correlation_filter.lookback;
      await Promise.all(
        heldSymbols.map(async (sym) => {
          try {
            // 优先从 DataProvider 取缓存
            const cached = provider.get(sym, cfg.timeframe);
            heldKlinesMap[sym] = cached ?? await getKlines(sym, cfg.timeframe, corrLookback + 1);
          } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ 相关性K线(${sym})获取失败: ${e instanceof Error ? e.message : String(e)}`); }
        })
      );
    }

    // ── 统一信号引擎（F3）────────────────────────────────
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

    const trend = indicators.maShort > indicators.maLong ? "📈 多头" : "📉 空头";
    const macdInfo = indicators.macd
      ? ` MACD=${indicators.macd.macd.toFixed(2)}/${indicators.macd.signal.toFixed(2)}`
      : "";
    const volRatio =
      indicators.avgVolume > 0 ? (indicators.volume / indicators.avgVolume).toFixed(2) : "?";

    log.info(
      `${scenarioPrefix}${symbol}: 价格=${indicators.price.toFixed(4)}, ` +
        `MA短=${indicators.maShort.toFixed(4)}, MA长=${indicators.maLong.toFixed(4)}, ` +
        `RSI=${indicators.rsi.toFixed(1)},${macdInfo} 成交量=${volRatio}x, ${trend}, 信号=${signal.type}` +
        (regimeLabel ? ` [${regimeLabel}]` : "")
    );

    if (rejected) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 ${rejectionReason ?? "filtered"}`);
      return;
    }

    if (signal.type === "none") return;

    // 🐛 Fix: 通知冷却在 MTF/情绪过滤之前生效，防止被过滤的信号绕过 min_interval_minutes
    // 若上次信号类型相同且未超过冷却时间，直接跳过（不更新 lastSignals，等冷却到期再统一处理）
    if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;
    // 记录信号时间戳（无论后续是否被 MTF/情绪过滤，均消耗一次冷却窗口）
    state.lastSignals[signal.symbol] = { type: signal.type, timestamp: Date.now() };

    // portfolioRatioOverride：来自引擎（相关性/regime 调整后的仓位比例）
    const portfolioRatioOverride: number | undefined = effectivePositionRatio;

    // 突发新闻紧急暂停（仅限开仓信号；止损/止盈平仓不受影响）
    if (signal.type === "buy" || signal.type === "short") {
      const emergencyState = readEmergencyHalt();
      if (emergencyState.halt) {
        log.warn(`${scenarioPrefix}${symbol}: ⛔ 紧急暂停：${emergencyState.reason ?? "突发高危新闻"}`);
        return;
      }
    }

    // P6.5 宏观事件日历风险控制（仅限开仓信号）
    if (signal.type === "buy" || signal.type === "short") {
      try {
        const eventRisk = checkEventRisk(loadCalendar());
        if (eventRisk.phase === "during") {
          log.info(`${scenarioPrefix}${symbol}: ⏸ 事件窗口期（${eventRisk.eventName}），暂停开仓`);
          return;
        }
        // pre / post 阶段：仅日志提示，sentiment gate 会在此基础上进一步调整
        if ((eventRisk.phase === "pre" || eventRisk.phase === "post") && eventRisk.positionRatioMultiplier < 1.0) {
          const baseRatio = portfolioRatioOverride ?? regimeEffectiveRisk.position_ratio;
          const approxRatio = baseRatio * eventRisk.positionRatioMultiplier;
          log.warn(`${scenarioPrefix}${symbol}: ⚠️ 事件风险期（${eventRisk.eventName}），建议仓位 ≈ ${(approxRatio * 100).toFixed(0)}%（×${eventRisk.positionRatioMultiplier}）`);
        }
      } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ 事件日历加载失败: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // MTF 过滤：买入信号且大趋势为空头 → 跳过
    if (signal.type === "buy" && mtfTrendBull === false) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 MTF 趋势过滤：${cfg.trend_timeframe} 空头，忽略 1h 买入信号`);
      return;
    }
    // MTF 过滤：开空信号且大趋势为多头 → 跳过
    if (signal.type === "short" && mtfTrendBull === true) {
      log.info(`${scenarioPrefix}${symbol}: 🚫 MTF 趋势过滤：${cfg.trend_timeframe} 多头，忽略 1h 开空信号`);
      return;
    }

    // 情绪门控
    const newsReport = loadNewsReport();
    // 情绪门控以「组合调整后的仓位比例」为基准（双重叠加缩减）
    const baseForGate = portfolioRatioOverride ?? regimeEffectiveRisk.position_ratio;
    const sentimentCache = readSentimentCache();  // 从磁盘读取 LLM 情绪缓存
    const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
    log.info(`${scenarioPrefix}${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);
    if (gate.action === "skip") return;

    if (cfg.mode === "paper") {
      let effectiveRatio = "positionRatio" in gate ? gate.positionRatio : baseForGate;

      // Kelly 动态仓位（仅开仓信号有效）
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
        } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ Kelly 计算失败: ${e instanceof Error ? e.message : String(e)}`); }
      }

      // P7.1 Portfolio Risk：相关性热度连续缩仓（仅开仓信号）
      // 与 signal-engine 内的二值过滤互补：中等相关时按热度连续缩减仓位
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
            log.info(`${scenarioPrefix}${symbol}: 📊 组合热度 ${(portfolioHeat.heat * 100).toFixed(0)}% → ${portfolioHeat.decision}（${portfolioHeat.reason}）`);
            if (portfolioHeat.decision === "blocked") return;
            effectiveRatio = portfolioHeat.adjustedPositionRatio;
          }
        } catch (e: unknown) { log.warn(`${scenarioPrefix}${symbol}: ⚠️ 组合热度计算失败: ${e instanceof Error ? e.message : String(e)}`); }
      }

      // P5.2: 合并 regime 参数覆盖（止盈/止损/ROI Table 等）+ 仓位比例调整
      const adjustedCfg = { ...cfg, risk: { ...regimeEffectiveRisk, position_ratio: effectiveRatio } };
      const result = handleSignal(signal, adjustedCfg);

      if (result.skipped) {
        log.info(`${scenarioPrefix}${symbol}: ⏭️ 跳过 — ${result.skipped}`);
      }
      if (result.trade) {
        const action = result.trade.side === "buy" ? "买入(开多)" : result.trade.side === "short" ? "开空" : result.trade.side === "cover" ? "平空" : "卖出(平多)";
        log.info(
          `${scenarioPrefix}${symbol}: 📝 模拟${action} @${result.trade.price.toFixed(4)}（仓位 ${(effectiveRatio * 100).toFixed(0)}%）`
        );
        notifyPaperTrade(result.trade, result.account);
      }
      if (gate.action === "warn") {
        notifyError(symbol, new Error(`⚠️ 情绪警告：${gate.reason}`));
      }
    } else if (cfg.mode === "notify_only" && cfg.notify.on_signal) {
      notifySignal(signal);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${scenarioPrefix}${symbol}: 错误 - ${error.message}`);
    if (cfg.notify.on_error) notifyError(symbol, error);
  }
}

// ─────────────────────────────────────────────────────
// Portfolio Risk 辅助（P7.1）
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
// 单个场景完整运行
// ─────────────────────────────────────────────────────

// P6.2 动态 pairlist：读取 logs/current-pairlist.json，若有效则覆盖配置里的静态 symbols
const PAIRLIST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../logs/current-pairlist.json");
const PAIRLIST_MAX_AGE_MS = 25 * 60 * 60 * 1000;

// P6.2 链上稳定币流量缓存（由 live-monitor 写入，monitor.ts 只读）
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

  // P6.2 pairlist 覆盖
  const heldSymbols = Object.keys(loadAccount(cfg.paper.initial_usdt, sid).positions);
  const pairlistSymbols = loadPairlistSymbols(heldSymbols);
  if (pairlistSymbols) cfg.symbols = pairlistSymbols;

  if (state.paused) {
    log.warn(`${prefix}⚠️ 策略已暂停（触发最大亏损上限）`);
    return;
  }

  // P6.7: Kill Switch 熔断检查
  if (isKillSwitchActive()) {
    log.warn(`${prefix}⛔ Kill Switch 激活，跳过扫描`);
    return;
  }

  const currentPrices: Record<string, number> = {};

  // ── DataProvider：预拉所有 symbol 的 K 线，减少重复 API 请求 ──
  const macdMinBars = cfg.strategy.macd.enabled
    ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
    : 0;
  const klineLimit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 11;
  const provider = new DataProvider(30);
  await provider.refresh(cfg.symbols, cfg.timeframe, klineLimit);
  // MTF 预拉（如果配置了 trend_timeframe）
  if (cfg.trend_timeframe && cfg.trend_timeframe !== cfg.timeframe) {
    const trendLimit = cfg.strategy.ma.long + 10;
    await provider.refresh(cfg.symbols, cfg.trend_timeframe, trendLimit);
  }

  // 并发扫描（批次 3）
  const BATCH = 3;
  for (let i = 0; i < cfg.symbols.length; i += BATCH) {
    const batch = cfg.symbols.slice(i, i + BATCH);
    await Promise.all(batch.map((sym) => scanSymbol(sym, cfg, state, currentPrices, prefix, provider)));
  }

  // 止损/止盈/追踪止损检查
  if (Object.keys(currentPrices).length > 0) {
    const exits = checkExitConditions(currentPrices, cfg);
    for (const { symbol, trade, reason, pnlPercent } of exits) {
      const emoji = reason === "take_profit" ? "🎯" : "🚨";
      const label =
        reason === "take_profit" ? "止盈" :
        reason === "trailing_stop" ? "追踪止损" :
        reason === "time_stop" ? "时间止损" : "止损";
      log.info(`${prefix}${symbol}: ${emoji} ${label}触发（${pnlPercent.toFixed(2)}%）`);
      if (reason !== "take_profit") {
        // stop_loss / trailing_stop / time_stop 均发送止损通知
        notifyStopLoss(symbol, trade.price / (1 + pnlPercent / 100), trade.price, pnlPercent / 100);
      } else if (cfg.notify.on_take_profit) {
        // 止盈通知复用 notifySignal，indicators 仅用于消息格式化，填充占位数据
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

    // ── DCA 追加检查 ─────────────────────────────────────
    if (cfg.risk.dca?.enabled) {
      const dcaResults = checkDcaTranches(currentPrices, cfg);
      for (const { symbol, trade, tranche, totalTranches } of dcaResults) {
        log.info(`${prefix}${symbol}: 💰 DCA 第 ${tranche}/${totalTranches} 批 @${trade.price.toFixed(4)} (${trade.usdtAmount.toFixed(2)} USDT)`);
        notifyPaperTrade(trade, loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId));
      }
    }

    if (checkDailyLossLimit(currentPrices, cfg)) {
      log.warn(`${prefix}⚠️ 今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`);
    }

    if (checkMaxDrawdown(currentPrices, cfg)) {
      log.error(`${prefix}🚨 总亏损超过上限，场景已暂停！`);
      state.paused = true;
      notifyError(
        `${marketLabel} 风控`,
        new Error(
          `总亏损超过 ${cfg.risk.max_total_loss_percent}% 上限，${marketLabel} 模拟盘已自动暂停`
        )
      );
    }

    // 定期账户汇报
    const intervalMs = cfg.paper.report_interval_hours * 3600000;
    if (intervalMs > 0 && Date.now() - state.lastReportAt >= intervalMs) {
      log.info(`${prefix}📊 发送定期账户汇报`);
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

  // P7.1 组合暴露度摘要日志（有持仓时输出，辅助风险监控）
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
  } catch { /* exposure summary 失败不影响主流程 */ }

  saveState(sid, state);
}

// ─────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("─── 监控扫描开始 ───");
  if (!process.env["OPENCLAW_GATEWAY_TOKEN"]) {
    log.warn("⚠️ 环境变量 OPENCLAW_GATEWAY_TOKEN 未设置，通知功能将不可用");
  }
  const done = ping("price_monitor");

  const runtimes = loadRuntimeConfigs();
  const firstRuntime = runtimes[0];
  if (!firstRuntime) { log.warn("无可用策略配置"); return; }
  if (!firstRuntime.strategy.enabled) {
    log.info("策略已禁用");
    done();
    return;
  }

  const mode = firstRuntime.mode;
  const scenarioNames = runtimes.map((r) => r.paper.scenarioId).join(", ");
  log.info(`模式: ${mode} | 场景: ${scenarioNames} | 默认币种: ${firstRuntime.symbols.join(", ")}`);

  // 跳过 testnet 场景（由 live-monitor.ts 专属处理，避免 paper 账户文件冲突）
  const paperOnly = runtimes.filter((cfg) => !cfg.exchange.testnet);
  const skipped = runtimes.filter((cfg) => cfg.exchange.testnet).map((c) => c.paper.scenarioId);
  if (skipped.length > 0) {
    log.info(`⏭ 跳过 testnet 场景（由 live-monitor.ts 管理）：${skipped.join(", ")}`);
  }
  // 所有 paper 场景并行运行
  await Promise.all(paperOnly.map((cfg) => runScenario(cfg)));

  done();
  log.info("─── 监控扫描完成 ───\n");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

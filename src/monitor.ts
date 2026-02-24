/**
 * openclaw-trader 主监控脚本
 * 每分钟由 cron 触发
 * paper 模式下并行运行所有启用的场景，每个场景独立账户
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getKlines } from "./exchange/binance.js";
import { calculateIndicators } from "./strategy/indicators.js";
import { detectSignal } from "./strategy/signals.js";
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
import { readSentimentCache } from "./news/sentiment-cache.js";
import { checkCorrelation } from "./strategy/correlation.js";
import { calcCorrelationAdjustedSize } from "./strategy/portfolio-risk.js";
import { loadAccount, calcTotalEquity } from "./paper/account.js";
import { ping } from "./health/heartbeat.js";
import { loadRuntimeConfigs } from "./config/loader.js";
import type { RuntimeConfig, Signal, Indicators, Kline } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "../logs/monitor.log");
// 每个场景独立暂停状态：logs/state-{scenarioId}.json
function getStatePath(scenarioId: string): string {
  return path.resolve(__dirname, `../logs/state-${scenarioId}.json`);
}

// ─────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

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
  scenarioPrefix: string
): Promise<void> {
  try {
    // 计算所需 K 线数量：取 MA、RSI、MACD 三者的最大值，多留 10 根余量
    const macdMinBars = cfg.strategy.macd.enabled
      ? cfg.strategy.macd.slow + cfg.strategy.macd.signal + 1
      : 0;
    const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;
    const klines = await getKlines(symbol, cfg.timeframe, limit + 1);
    if (klines.length < limit) return;

    const indicators = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd
    );
    if (!indicators) return;

    currentPrices[symbol] = indicators.price;

    // ── 多时间框架趋势过滤（MTF）──────────────────────────
    // 如果配置了 trend_timeframe，拉取更高级别 K 线判断大趋势方向
    // 买入信号只在大趋势为多头时执行；卖出/止损不受限制
    let mtfTrendBull: boolean | null = null; // null = 未启用
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
          log(
            `${scenarioPrefix}${symbol}: MTF(${cfg.trend_timeframe}) MA短=${trendInd.maShort.toFixed(4)} MA长=${trendInd.maLong.toFixed(4)} → ${mtfTrendBull ? "多头✅" : "空头🚫"}`
          );
        }
      } catch (err: unknown) {
        log(`${scenarioPrefix}${symbol}: MTF 获取失败，跳过趋势过滤 — ${String(err)}`);
      }
    }

    // 获取当前持仓方向，让 detectSignal 使用正确优先级
    const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const currentPosSide = currentAccount.positions[symbol]?.side;
    const signal = detectSignal(symbol, indicators, cfg, currentPosSide);

    // MTF 过滤：买入信号且大趋势为空头 → 跳过
    if (signal.type === "buy" && mtfTrendBull === false) {
      log(`${scenarioPrefix}${symbol}: 🚫 MTF 趋势过滤：${cfg.trend_timeframe} 空头，忽略 1h 买入信号`);
      return;
    }
    // MTF 过滤：开空信号且大趋势为多头 → 跳过
    if (signal.type === "short" && mtfTrendBull === true) {
      log(`${scenarioPrefix}${symbol}: 🚫 MTF 趋势过滤：${cfg.trend_timeframe} 多头，忽略 1h 开空信号`);
      return;
    }

    const trend = indicators.maShort > indicators.maLong ? "📈 多头" : "📉 空头";
    const macdInfo = indicators.macd
      ? ` MACD=${indicators.macd.macd.toFixed(2)}/${indicators.macd.signal.toFixed(2)}`
      : "";
    const volRatio =
      indicators.avgVolume > 0 ? (indicators.volume / indicators.avgVolume).toFixed(2) : "?";

    log(
      `${scenarioPrefix}${symbol}: 价格=${indicators.price.toFixed(4)}, ` +
        `MA短=${indicators.maShort.toFixed(4)}, MA长=${indicators.maLong.toFixed(4)}, ` +
        `RSI=${indicators.rsi.toFixed(1)},${macdInfo} 成交量=${volRatio}x, ${trend}, 信号=${signal.type}`
    );

    if (signal.type === "none") return;

    // portfolioRatioOverride：相关性调整后的仓位比例（覆盖 cfg.risk.position_ratio）
    let portfolioRatioOverride: number | undefined;

    // ── 相关性过滤 + 组合暴露度调整（仅对开仓信号）────────────
    if ((signal.type === "buy" || signal.type === "short") && cfg.risk.correlation_filter?.enabled) {
      const corrCfg = cfg.risk.correlation_filter;
      const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
      const heldSymbols = Object.keys(account.positions);
      if (heldSymbols.length > 0) {
        // 拉取所有已持仓 K 线（用于相关性 + 暴露度计算）
        const heldKlinesMap = new Map<string, Kline[]>();
        await Promise.all(
          heldSymbols.map(async (sym) => {
            try {
              const k = await getKlines(sym, cfg.timeframe, corrCfg.lookback + 1);
              heldKlinesMap.set(sym, k);
            } catch { /* 获取失败跳过 */ }
          })
        );

        // ── 旧二值检查（保留兼容）───────────────────────
        const heldKlinesObj = Object.fromEntries(heldKlinesMap);
        const corrResult = checkCorrelation(symbol, klines, heldKlinesMap, corrCfg.threshold);

        // ── 新：相关性加权仓位调整 ────────────────────────
        const totalEquity = calcTotalEquity(account, Object.fromEntries(
          [...heldKlinesMap.entries()].map(([s, k]) => [s, k[k.length - 1]?.close ?? 0])
        ));
        const positionWeights = Object.entries(account.positions).map(([sym, pos]) => {
          const lastClose = heldKlinesMap.get(sym)?.at(-1)?.close ?? pos.entryPrice;
          const notional = pos.quantity * lastClose;
          return {
            symbol: sym,
            side: (pos.side ?? "long") as "long" | "short",
            notionalUsdt: notional,
            weight: totalEquity > 0 ? notional / totalEquity : 0,
          };
        });

        const portfolioHeat = calcCorrelationAdjustedSize(
          symbol,
          signal.type === "short" ? "short" : "long",
          cfg.risk.position_ratio,
          positionWeights,
          { ...heldKlinesObj, [symbol]: klines },
          corrCfg.lookback,
          0.9  // 热度上限 90%（高于此则拒绝）
        );

        if (portfolioHeat.decision === "blocked") {
          log(`${scenarioPrefix}${symbol}: 🔗 组合热度过高 → ${portfolioHeat.reason}`);
          return;
        }

        if (portfolioHeat.decision === "reduced") {
          log(`${scenarioPrefix}${symbol}: 📉 组合暴露度调整 → ${portfolioHeat.reason}`);
          // portfolioRatioOverride 在后续情绪门控和 handleSignal 时替代 cfg.risk.position_ratio
          portfolioRatioOverride = portfolioHeat.adjustedPositionRatio;
        } else if (corrResult.maxCorrelation > 0) {
          log(`${scenarioPrefix}${symbol}: 相关性 ${corrResult.correlatedWith}=${corrResult.maxCorrelation.toFixed(3)}，热度 ${(portfolioHeat.heat * 100).toFixed(0)}%，正常开仓`);
        }
      }
    }

    // 情绪门控
    const newsReport = loadNewsReport();
    // 情绪门控以「组合调整后的仓位比例」为基准（双重叠加缩减）
    const baseForGate = portfolioRatioOverride ?? cfg.risk.position_ratio;
    const sentimentCache = readSentimentCache();  // 从磁盘读取 LLM 情绪缓存
    const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
    log(`${scenarioPrefix}${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);
    if (gate.action === "skip") return;

    if (cfg.mode === "paper") {
      if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;

      const effectiveRatio = "positionRatio" in gate ? gate.positionRatio : baseForGate;
      const adjustedCfg = { ...cfg, risk: { ...cfg.risk, position_ratio: effectiveRatio } };
      const result = handleSignal(signal, adjustedCfg);

      if (result.skipped) {
        log(`${scenarioPrefix}${symbol}: ⏭️ 跳过 — ${result.skipped}`);
      }
      if (result.trade) {
        const action = result.trade.side === "buy" ? "买入" : "卖出";
        log(
          `${scenarioPrefix}${symbol}: 📝 模拟${action} @${result.trade.price.toFixed(4)}（仓位 ${(effectiveRatio * 100).toFixed(0)}%）`
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
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log(`${scenarioPrefix}${symbol}: 错误 - ${error.message}`);
    if (cfg.notify.on_error) notifyError(symbol, error);
  }
}

// ─────────────────────────────────────────────────────
// 单个场景完整运行
// ─────────────────────────────────────────────────────

async function runScenario(cfg: RuntimeConfig): Promise<void> {
  const sid = cfg.paper.scenarioId;
  const marketLabel = `[${cfg.exchange.market.toUpperCase()}${cfg.exchange.leverage?.enabled ? ` ${cfg.exchange.leverage.default}x` : ""}]`;
  const prefix = `${marketLabel} `;
  const state = loadState(sid);

  if (state.paused) {
    log(`${prefix}⚠️ 策略已暂停（触发最大亏损上限）`);
    return;
  }

  const currentPrices: Record<string, number> = {};

  // 并发扫描（批次 3）
  const BATCH = 3;
  for (let i = 0; i < cfg.symbols.length; i += BATCH) {
    const batch = cfg.symbols.slice(i, i + BATCH);
    await Promise.all(batch.map((sym) => scanSymbol(sym, cfg, state, currentPrices, prefix)));
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
      log(`${prefix}${symbol}: ${emoji} ${label}触发（${pnlPercent.toFixed(2)}%）`);
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
        log(`${prefix}${symbol}: 💰 DCA 第 ${tranche}/${totalTranches} 批 @${trade.price.toFixed(4)} (${trade.usdtAmount.toFixed(2)} USDT)`);
        notifyPaperTrade(trade, loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId));
      }
    }

    if (checkDailyLossLimit(currentPrices, cfg)) {
      log(`${prefix}⚠️ 今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`);
    }

    if (checkMaxDrawdown(currentPrices, cfg)) {
      log(`${prefix}🚨 总亏损超过上限，场景已暂停！`);
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
      log(`${prefix}📊 发送定期账户汇报`);
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

  saveState(sid, state);
}

// ─────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("─── 监控扫描开始 ───");
  const done = ping("price_monitor");

  const runtimes = loadRuntimeConfigs();
  // loadRuntimeConfigs 在无 enabled 场景时会 throw，此处 runtimes[0] 必存在
  const firstRuntime = runtimes[0]!;
  if (!firstRuntime.strategy.enabled) {
    log("策略已禁用");
    done();
    return;
  }

  const mode = firstRuntime.mode;
  const scenarioNames = runtimes.map((r) => r.paper.scenarioId).join(", ");
  log(`模式: ${mode} | 场景: ${scenarioNames} | 默认币种: ${firstRuntime.symbols.join(", ")}`);

  // 所有场景并行运行
  await Promise.all(runtimes.map((cfg) => runScenario(cfg)));

  done();
  log("─── 监控扫描完成 ───\n");
}

main().catch((err: unknown) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});

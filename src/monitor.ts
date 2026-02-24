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
  formatSummaryMessage,
} from "./paper/engine.js";
import { loadNewsReport, evaluateSentimentGate } from "./news/sentiment-gate.js";
import { ping } from "./health/heartbeat.js";
import { loadRuntimeConfigs } from "./config/loader.js";
import type { RuntimeConfig, Signal, Indicators } from "./types.js";

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
    const signal = detectSignal(symbol, indicators, cfg);
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

    // 情绪门控
    const newsReport = loadNewsReport();
    const gate = evaluateSentimentGate(signal, newsReport, cfg.risk.position_ratio);
    log(`${scenarioPrefix}${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);
    if (gate.action === "skip") return;

    if (cfg.mode === "paper") {
      if (!shouldNotify(state, signal, cfg.notify.min_interval_minutes)) return;

      const effectiveRatio = "positionRatio" in gate ? gate.positionRatio : cfg.risk.position_ratio;
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
        reason === "take_profit" ? "止盈" : reason === "trailing_stop" ? "追踪止损" : "止损";
      log(`${prefix}${symbol}: ${emoji} ${label}触发（${pnlPercent.toFixed(2)}%）`);
      if (reason === "stop_loss" || reason === "trailing_stop") {
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

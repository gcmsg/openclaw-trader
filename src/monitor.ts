/**
 * openclaw-trader 主监控脚本
 * 每分钟由 cron 触发，检测交易信号
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import { getKlines } from "./exchange/binance.js";
import { calculateIndicators } from "./strategy/indicators.js";
import { detectSignal } from "./strategy/signals.js";
import { notifySignal, notifyError, notifyPaperTrade, notifyStopLoss } from "./notify/openclaw.js";
import { handleSignal, checkExitConditions, checkMaxDrawdown, checkDailyLossLimit, formatSummaryMessage } from "./paper/engine.js";
import { loadNewsReport, evaluateSentimentGate } from "./news/sentiment-gate.js";
import { ping } from "./health/heartbeat.js";
import type { StrategyConfig, Signal } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../config/strategy.yaml");
const STATE_PATH = path.resolve(__dirname, "../logs/state.json");
const LOG_PATH = path.resolve(__dirname, "../logs/monitor.log");

// ─────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function loadConfig(): StrategyConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return parse(raw) as StrategyConfig;
}

interface MonitorState {
  lastSignals: Record<string, { type: string; timestamp: number }>;
  lastReportAt: number;
  paused: boolean;
}

function loadState(): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as MonitorState;
  } catch {
    return { lastSignals: {}, lastReportAt: 0, paused: false };
  }
}

function saveState(state: MonitorState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function shouldNotify(
  state: MonitorState,
  signal: Signal,
  minIntervalMinutes: number
): boolean {
  const key = signal.symbol;
  const last = state.lastSignals[key];
  if (!last) return true;
  if (last.type !== signal.type) return true;
  const elapsed = (Date.now() - last.timestamp) / 1000 / 60;
  return elapsed >= minIntervalMinutes;
}

// ─────────────────────────────────────────────────────
// 扫描单个币种
// ─────────────────────────────────────────────────────

async function scanSymbol(
  symbol: string,
  cfg: StrategyConfig,
  state: MonitorState,
  currentPrices: Record<string, number>
): Promise<void> {
  try {
    const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period) + 10;
    const klines = await getKlines(symbol, cfg.timeframe, limit + 1);

    if (klines.length < limit) {
      log(`${symbol}: K线不足（${klines.length}/${limit}）`);
      return;
    }

    const indicators = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period,
      cfg.strategy.macd
    );

    if (!indicators) {
      log(`${symbol}: 指标计算失败`);
      return;
    }

    currentPrices[symbol] = indicators.price;
    const signal = detectSignal(symbol, indicators, cfg);
    const trend = indicators.maShort > indicators.maLong ? "📈 多头" : "📉 空头";

    const macdInfo = indicators.macd
      ? ` MACD=${indicators.macd.macd.toFixed(2)}/${indicators.macd.signal.toFixed(2)}`
      : "";
    const volRatio = indicators.avgVolume > 0
      ? (indicators.volume / indicators.avgVolume).toFixed(2) : "?";
    log(
      `${symbol}: 价格=${indicators.price.toFixed(4)}, ` +
      `MA短=${indicators.maShort.toFixed(4)}, MA长=${indicators.maLong.toFixed(4)}, ` +
      `RSI=${indicators.rsi.toFixed(1)},${macdInfo} 成交量=${volRatio}x, ${trend}, 信号=${signal.type}`
    );

    if (signal.type === "none") return;

    // ── 新闻情绪门控 ──
    const newsReport = loadNewsReport();
    const gate = evaluateSentimentGate(signal, newsReport, cfg.risk.position_ratio);
    log(`${symbol}: 情绪门控 → ${gate.action}（${gate.reason}）`);

    if (gate.action === "skip") return;

    // ── 模拟盘模式 ──
    if (cfg.mode === "paper") {
      if (shouldNotify(state, signal, cfg.notify.min_interval_minutes)) {
        // 将门控结果的仓位比例传入引擎
        const effectiveRatio = "positionRatio" in gate ? gate.positionRatio : cfg.risk.position_ratio;
        const adjustedCfg = {
          ...cfg,
          risk: { ...cfg.risk, position_ratio: effectiveRatio },
        };
        const result = handleSignal(signal, adjustedCfg);
        if (result.skipped) {
          log(`${symbol}: ⏭️ 跳过 — ${result.skipped}`);
        }
        if (result.trade) {
          log(`${symbol}: 📝 模拟${result.trade.side === "buy" ? "买入" : "卖出"} @${result.trade.price.toFixed(4)}（仓位 ${(effectiveRatio * 100).toFixed(0)}%）`);
          await notifyPaperTrade(result.trade, result.account);
        }
        if (gate.action === "warn") {
          await notifyError(symbol, new Error(`⚠️ 情绪警告：${gate.reason}`)).catch(() => {});
        }
        state.lastSignals[symbol] = { type: signal.type, timestamp: Date.now() };
      }
      return;
    }

    // ── notify_only 模式 ──
    if (cfg.mode === "notify_only" && cfg.notify.on_signal) {
      if (shouldNotify(state, signal, cfg.notify.min_interval_minutes)) {
        log(`${symbol}: 🔔 发送信号通知`);
        await notifySignal(signal);
        state.lastSignals[symbol] = { type: signal.type, timestamp: Date.now() };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log(`${symbol}: 错误 - ${error.message}`);
    if (cfg.notify.on_error) {
      await notifyError(symbol, error).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────
// 主逻辑
// ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("─── 监控扫描开始 ───");
  const done = ping("price_monitor");

  const cfg = loadConfig();
  const state = loadState();

  if (!cfg.strategy.enabled) {
    log("策略已禁用");
    return;
  }

  if (state.paused) {
    log("⚠️ 策略已暂停（触发最大亏损上限）");
    return;
  }

  log(`模式: ${cfg.mode} | 币种: ${cfg.symbols.join(", ")}`);

  const currentPrices: Record<string, number> = {};

  // 并发扫描（批次控制并发）
  const BATCH = 3;
  for (let i = 0; i < cfg.symbols.length; i += BATCH) {
    const batch = cfg.symbols.slice(i, i + BATCH);
    await Promise.all(batch.map((sym) => scanSymbol(sym, cfg, state, currentPrices)));
  }

  // 止损/止盈/追踪止损检查（paper 模式）
  if (cfg.mode === "paper" && Object.keys(currentPrices).length > 0) {
    const exits = checkExitConditions(currentPrices, cfg);
    for (const { symbol, trade, reason, pnlPercent } of exits) {
      const emoji = reason === "take_profit" ? "🎯" : "🚨";
      log(`${symbol}: ${emoji} ${reason === "take_profit" ? "止盈" : reason === "trailing_stop" ? "追踪止损" : "止损"}触发（${pnlPercent.toFixed(2)}%）`);
      if (reason === "stop_loss" || reason === "trailing_stop") {
        await notifyStopLoss(symbol, trade.price / (1 + pnlPercent / 100), trade.price, pnlPercent / 100);
      } else if (cfg.notify.on_take_profit) {
        await notifySignal({ symbol, type: "sell", price: trade.price, indicators: {} as never, reason: [`止盈: +${pnlPercent.toFixed(2)}%`], timestamp: Date.now() }).catch(() => {});
      }
    }

    // 每日亏损限制检查
    if (checkDailyLossLimit(currentPrices, cfg)) {
      log(`⚠️ 今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`);
    }

    // 总亏损暂停检查
    if (checkMaxDrawdown(currentPrices, cfg)) {
      log("🚨 总亏损超过上限，策略已暂停！");
      state.paused = true;
      await notifyError("风控系统", new Error(
        `总亏损超过 ${cfg.risk.max_total_loss_percent}% 上限，模拟盘策略已自动暂停。请检查账户状态。`
      ));
    }

    // 定期汇报（根据 paper.report_interval_hours）
    const intervalMs = cfg.paper.report_interval_hours * 60 * 60 * 1000;
    if (Date.now() - state.lastReportAt >= intervalMs) {
      log("📊 发送定期账户汇报");
      const msg = formatSummaryMessage(currentPrices, cfg);
      const { spawnSync } = await import("child_process");
      const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
      const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
      try {
        const args = ["system", "event", "--mode", "now"];
        if (GATEWAY_TOKEN) args.push("--token", GATEWAY_TOKEN);
        args.push("--text", msg);
        spawnSync(OPENCLAW_BIN, args, { encoding: "utf-8", timeout: 15000 });
      } catch (e) {
        log(`汇报发送失败: ${(e as Error).message}`);
      }
      state.lastReportAt = Date.now();
    }
  }

  saveState(state);
  done();
  log("─── 监控扫描完成 ───\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

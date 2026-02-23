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
import { notifySignal, notifyError } from "./notify/openclaw.js";
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
}

function loadState(): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as MonitorState;
  } catch {
    return { lastSignals: {} };
  }
}

function saveState(state: MonitorState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** 判断是否应该发送通知（防止同一币种重复刷屏） */
function shouldNotify(
  state: MonitorState,
  signal: Signal,
  minIntervalMinutes: number
): boolean {
  const key = signal.symbol;
  const last = state.lastSignals[key];
  if (!last) return true;
  if (last.type !== signal.type) return true; // 方向变了，一定通知
  const elapsed = (Date.now() - last.timestamp) / 1000 / 60;
  return elapsed >= minIntervalMinutes;
}

// ─────────────────────────────────────────────────────
// 主逻辑
// ─────────────────────────────────────────────────────

async function scanSymbol(
  symbol: string,
  cfg: StrategyConfig,
  state: MonitorState
): Promise<void> {
  try {
    // 获取足够多的 K 线以计算指标
    const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period) + 10;
    const klines = await getKlines(symbol, cfg.timeframe, limit + 1);

    if (klines.length < limit) {
      log(`${symbol}: K线数据不足（${klines.length}/${limit}）`);
      return;
    }

    const indicators = calculateIndicators(
      klines,
      cfg.strategy.ma.short,
      cfg.strategy.ma.long,
      cfg.strategy.rsi.period
    );

    if (!indicators) {
      log(`${symbol}: 指标计算失败`);
      return;
    }

    const signal = detectSignal(symbol, indicators, cfg);
    const trend =
      indicators.maShort > indicators.maLong ? "📈 多头" : "📉 空头";

    log(
      `${symbol}: 价格=${indicators.price.toFixed(4)}, ` +
        `MA短=${indicators.maShort.toFixed(4)}, ` +
        `MA长=${indicators.maLong.toFixed(4)}, ` +
        `RSI=${indicators.rsi.toFixed(1)}, ` +
        `${trend}, 信号=${signal.type}`
    );

    if (signal.type !== "none" && cfg.notify.on_signal) {
      if (shouldNotify(state, signal, cfg.notify.min_interval_minutes)) {
        log(`${symbol}: 🚀 发送${signal.type === "buy" ? "买入" : "卖出"}信号通知`);
        await notifySignal(signal);

        // 更新状态
        state.lastSignals[signal.symbol] = {
          type: signal.type,
          timestamp: Date.now(),
        };
      } else {
        log(`${symbol}: 信号已发送过，跳过（防刷屏）`);
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

async function main(): Promise<void> {
  log("─── 监控扫描开始 ───");

  const cfg = loadConfig();
  const state = loadState();

  if (!cfg.strategy.enabled) {
    log("策略已禁用，跳过扫描");
    return;
  }

  log(`监控币种: ${cfg.symbols.join(", ")}`);
  log(`时间框架: ${cfg.timeframe} | 策略: ${cfg.strategy.name} | 模式: ${cfg.mode}`);

  // 并发扫描所有币种（带并发限制）
  const CONCURRENT = 3;
  for (let i = 0; i < cfg.symbols.length; i += CONCURRENT) {
    const batch = cfg.symbols.slice(i, i + CONCURRENT);
    await Promise.all(batch.map((symbol) => scanSymbol(symbol, cfg, state)));
  }

  saveState(state);
  log("─── 监控扫描完成 ───\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

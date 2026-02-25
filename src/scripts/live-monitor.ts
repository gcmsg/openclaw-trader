/**
 * Live / Testnet 实盘监控脚本
 *
 * 功能：连接 Binance 真实 API（testnet 或 production），
 * 使用信号检测策略进行实际下单。
 *
 * 使用方式：
 *   npm run live          # Testnet 模式（从 paper.yaml 加载 testnet 场景）
 *   npm run live -- --scenario testnet-default
 *
 * ⚠️ 注意：
 *   - Testnet：testapi.binance.vision，使用测试资金，完全安全
 *   - Live：api.binance.com，使用真实资金，务必谨慎
 *   需先在 .secrets/ 目录放置凭证文件（见 .secrets/binance-testnet.json.example）
 */

import { getKlines } from "../exchange/binance.js";
import { calculateIndicators } from "../strategy/indicators.js";
import { detectSignal } from "../strategy/signals.js";
import { loadStrategyConfig, loadPaperConfig, buildPaperRuntime } from "../config/loader.js";
import { createLiveExecutor } from "../live/executor.js";
import { reconcilePositions, formatReconcileReport } from "../live/reconcile.js";
import { loadNewsReport, evaluateSentimentGate } from "../news/sentiment-gate.js";
import { notifySignal, notifyError } from "../notify/openclaw.js";
import { loadAccount, saveAccount } from "../paper/account.js";
import { logSignal, closeSignal } from "../signals/history.js";
import { readEmergencyHalt } from "../news/emergency-monitor.js";
import { CvdManager } from "../exchange/order-flow.js";
import { classifyRegime } from "../strategy/regime.js";
import type { RuntimeConfig } from "../types.js";

const POLL_INTERVAL_MS = 60 * 1000; // 1 分钟轮询

// ── 优雅退出标志（用对象包裹，避免 no-unnecessary-condition 误报）──
const _state = { shuttingDown: false };

function log(msg: string): void {
  console.log(`[${new Date().toLocaleString("zh-CN")}] ${msg}`);
}

// ─────────────────────────────────────────────────────
// 单轮信号检测 + 执行（一个场景一个 symbol）
// ─────────────────────────────────────────────────────

async function processSymbol(symbol: string, cfg: RuntimeConfig): Promise<void> {
  const label = cfg.exchange.testnet ? "[TESTNET]" : "[LIVE]";

  // 情绪门控（用占位信号评估当前情绪）
  const newsReport = loadNewsReport();
  if (newsReport) {
    const placeholderSignal = { symbol, type: "buy" as const, price: 0, indicators: { maShort: 0, maLong: 0, rsi: 0, price: 0, volume: 0, avgVolume: 0 }, reason: [], timestamp: Date.now() };
    const gate = evaluateSentimentGate(placeholderSignal, newsReport, cfg.risk.position_ratio);
    if (gate.action === "skip") {
      log(`${label} ${symbol}: 情绪门控跳过 — ${gate.reason}`);
      return;
    }
  }

  // 拉取 K 线
  const macdCfg = cfg.strategy.macd;
  const macdMinBars = macdCfg.enabled ? macdCfg.slow + macdCfg.signal + 1 : 0;
  const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;
  const klines = await getKlines(symbol, cfg.timeframe, limit + 1);

  if (klines.length < limit) {
    log(`${label} ${symbol}: K 线数量不足（${klines.length}/${limit}），跳过`);
    return;
  }

  // 计算指标
  const indicators = calculateIndicators(
    klines,
    cfg.strategy.ma.short,
    cfg.strategy.ma.long,
    cfg.strategy.rsi.period,
    cfg.strategy.macd
  );

  if (!indicators) {
    log(`${label} ${symbol}: 指标计算失败，跳过`);
    return;
  }

  // 检测信号（传入持仓方向，避免 sell/cover 被入场信号抢占）
  const currentAccount = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
  const currentPosSide = currentAccount.positions[symbol]?.side;
  const signal = detectSignal(symbol, indicators, cfg, currentPosSide);

  log(
    `${label} ${symbol}: RSI=${indicators.rsi.toFixed(1)} ` +
    `EMA${cfg.strategy.ma.short}=$${indicators.maShort.toFixed(2)} ` +
    `EMA${cfg.strategy.ma.long}=$${indicators.maLong.toFixed(2)} ` +
    `ATR=${indicators.atr?.toFixed(2) ?? "N/A"} ` +
    `→ ${signal.type.toUpperCase()}`
  );

  // ── P5.2 Regime 感知 + 自适应参数覆盖 ──────────────────────
  let effectiveCfg = cfg;
  if (signal.type === "buy" || signal.type === "short") {
    const regime = classifyRegime(klines);
    if (regime.confidence >= 60) {
      if (regime.signalFilter === "breakout_watch") {
        log(`${label} ${symbol}: 🚫 Regime 过滤 [${regime.label}] → 跳过开仓`);
        return;
      }
      const override = cfg.regime_overrides?.[regime.signalFilter];
      if (override) {
        effectiveCfg = { ...cfg, risk: { ...cfg.risk, ...override } };
        log(`${label} ${symbol}: 🔄 Regime 参数覆盖 [${regime.label}]: ${Object.keys(override).join(", ")}`);
      } else if (regime.signalFilter === "reduced_size") {
        const reducedRatio = cfg.risk.position_ratio * 0.5;
        effectiveCfg = { ...cfg, risk: { ...cfg.risk, position_ratio: reducedRatio } };
        log(`${label} ${symbol}: ⚠️ Regime 缩减 [${regime.label}] → 仓位 ${(reducedRatio * 100).toFixed(0)}%`);
      }
    }
  }

  // 创建使用 regime 调整后参数的执行器（单次创建，所有信号分支复用）
  const liveExecutor = createLiveExecutor(effectiveCfg);

  if (signal.type === "buy") {
    // 紧急暂停检查
    const emergency = readEmergencyHalt();
    if (emergency.halt) {
      log(`${label} ${symbol}: ⛔ 紧急暂停 — ${emergency.reason ?? "突发高危新闻"}`);
      return;
    }
    if (effectiveCfg.notify.on_signal) notifySignal(signal);
    const result = await liveExecutor.handleBuy(signal);
    if (result.skipped) {
      log(`${label} ${symbol}: 跳过 — ${result.skipped}`);
    } else if (result.trade) {
      log(`${label} ${symbol}: 买入成功，orderId=${result.orderId ?? "N/A"}`);
      // 记录信号历史
      try {
        const sigId = logSignal({
          symbol,
          type: "buy",
          entryPrice: result.trade.price,
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
        // 把 signalHistoryId 写回 paper 账户持仓
        const acc = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
        if (acc.positions[symbol]) {
          acc.positions[symbol].signalHistoryId = sigId;
          saveAccount(acc, cfg.paper.scenarioId);
        }
      } catch { /* 不影响主流程 */ }
    }
  } else if (signal.type === "short") {
    // 开空（Futures / Margin 市场）
    const emergency = readEmergencyHalt();
    if (emergency.halt) {
      log(`${label} ${symbol}: ⛔ 紧急暂停 — ${emergency.reason ?? "突发高危新闻"}`);
      return;
    }
    if (effectiveCfg.notify.on_signal) notifySignal(signal);
    const result = await liveExecutor.handleShort(signal);
    if (result.skipped) {
      log(`${label} ${symbol}: 跳过开空 — ${result.skipped}`);
    } else if (result.trade) {
      log(`${label} ${symbol}: 开空成功，orderId=${result.orderId ?? "N/A"}`);
      try {
        const sigId = logSignal({
          symbol,
          type: "short",
          entryPrice: result.trade.price,
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
  } else if (signal.type === "sell") {
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    const sigHistId = account.positions[symbol]?.signalHistoryId;
    if (account.positions[symbol]) {
      const result = await liveExecutor.handleSell(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log(`${label} ${symbol}: 卖出成功，orderId=${result.orderId ?? "N/A"}`);
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
      const result = await liveExecutor.handleCover(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) {
        log(`${label} ${symbol}: 平空成功，orderId=${result.orderId ?? "N/A"}`);
        if (sigHistId) {
          try { closeSignal(sigHistId, result.trade.price, "signal", result.trade.pnl); } catch { /* skip */ }
        }
      }
    }
  }
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
  for (const e of exits) {
    log(`${label} ${e.symbol}: 触发出场 — ${e.reason} (${e.pnlPercent.toFixed(2)}%)`);
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

  log(`🚀 启动实盘监控，共 ${scenarios.length} 个场景`);

  // ── 真实 CVD — aggTrade WebSocket ────────────────────
  // 从第一个场景取 symbols；所有场景共用同一个 CVD 数据源
  const cvdSymbols = scenarios[0]
    ? [...new Set(scenarios.flatMap((s) => s.symbols ?? []))]
    : [];
  const cvdManager = cvdSymbols.length > 0 ? new CvdManager(cvdSymbols, { windowMs: 3_600_000 }) : null;
  if (cvdManager) {
    cvdManager.start();
    log(`📊 真实 CVD 已启动，监控 ${cvdSymbols.length} 个 symbol`);
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
    log(`✅ ${scenario.id} [${label}]: 连接正常，USDT 余额 = $${balance.toFixed(2)}`);

    // ── 启动对账（P3.3）──────────────────────────────
    // 比对本地 paper 账户与交易所实际持仓，差异超 5% 告警
    // Testnet/paper 模式下交易所无真实持仓，预期结果为 ok
    try {
      const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
      const exchangePositions = await executor.getExchangePositions();
      const reconcile = reconcilePositions(account, exchangePositions);
      const report = formatReconcileReport(reconcile);
      log(report.replace(/\*\*/g, "")); // 去除 markdown，在终端更易读
      if (reconcile.status === "critical") {
        console.error(`\n⛔ 对账发现严重差异，暂停启动，请人工确认后重启！`);
        process.exit(1);
      }
    } catch (err: unknown) {
      log(`⚠️ 对账跳过：${String(err)}`);
    }

    // ── F2/F5: 孤儿订单扫描（启动时清理上次进程遗留的未完成挂单）──
    try {
      const cancelled = await executor.scanOpenOrders();
      if (cancelled > 0) {
        log(`🧹 ${scenario.id}: 已取消 ${cancelled} 个孤儿挂单`);
      }
    } catch (err: unknown) {
      log(`⚠️ 孤儿订单扫描跳过：${String(err)}`);
    }
  }

  // ── SIGTERM / SIGINT 优雅退出 ───────────────────────
  const handleShutdown = (sig: string) => {
    if (_state.shuttingDown) return;
    _state.shuttingDown = true;
    log(`\n🛑 收到 ${sig}，完成当前轮次后退出...`);
  };
  process.on("SIGTERM", () => { handleShutdown("SIGTERM"); });
  process.on("SIGINT", () => { handleShutdown("SIGINT"); });

  // 轮询循环
  for (;;) {
    if (_state.shuttingDown) break;
    for (const scenario of scenarios) {
      if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      const cfg = buildPaperRuntime(base, paperCfg, scenario);

      try {
        // 先检查止损/止盈
        await checkExits(cfg);

        // 再检测买卖信号
        for (const symbol of cfg.symbols) {
          if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
          await processSymbol(symbol, cfg).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`❌ ${scenario.id} ${symbol}: ${msg}`);
            if (cfg.notify.on_error) notifyError(symbol, new Error(msg));
          });
          // 每个 symbol 间短暂等待，避免触发 Binance 限频
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`❌ 场景 ${scenario.id} 运行异常: ${msg}`);
      }
    }

    if (_state.shuttingDown) break; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    log(`⏰ 等待 ${POLL_INTERVAL_MS / 1000}s 后下一轮...`);
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  cvdManager?.stop();
  log("✅ Live monitor 已安全退出。");
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Fatal:", msg);
  process.exit(1);
});

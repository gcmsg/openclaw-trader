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
import { loadAccount } from "../paper/account.js";
import type { RuntimeConfig } from "../types.js";

const POLL_INTERVAL_MS = 60 * 1000; // 1 分钟轮询

function log(msg: string): void {
  console.log(`[${new Date().toLocaleString("zh-CN")}] ${msg}`);
}

// ─────────────────────────────────────────────────────
// 单轮信号检测 + 执行（一个场景一个 symbol）
// ─────────────────────────────────────────────────────

async function processSymbol(symbol: string, cfg: RuntimeConfig): Promise<void> {
  const executor = createLiveExecutor(cfg);
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

  if (signal.type === "buy") {
    if (cfg.notify.on_signal) notifySignal(signal);
    const result = await executor.handleBuy(signal);
    if (result.skipped) {
      log(`${label} ${symbol}: 跳过 — ${result.skipped}`);
    } else if (result.trade) {
      log(`${label} ${symbol}: 买入成功，orderId=${result.orderId ?? "N/A"}`);
    }
  } else if (signal.type === "sell") {
    const account = loadAccount(cfg.paper.initial_usdt, cfg.paper.scenarioId);
    if (account.positions[symbol]) {
      const result = await executor.handleSell(symbol, signal.price, signal.reason.join(", "));
      if (result.trade) log(`${label} ${symbol}: 卖出成功，orderId=${result.orderId ?? "N/A"}`);
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

  const exits = await executor.checkExitConditions(prices);
  for (const e of exits) {
    log(`${label} ${e.symbol}: 触发出场 — ${e.reason} (${e.pnlPercent.toFixed(2)}%)`);
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
      const reconcile = reconcilePositions(account, []); // exchangePositions = [] (API 集成待扩展)
      const report = formatReconcileReport(reconcile);
      log(report.replace(/\*\*/g, "")); // 去除 markdown，在终端更易读
      if (reconcile.status === "critical") {
        console.error(`\n⛔ 对账发现严重差异，暂停启动，请人工确认后重启！`);
        process.exit(1);
      }
    } catch (err: unknown) {
      log(`⚠️ 对账跳过：${String(err)}`);
    }
  }

  // 轮询循环
  for (;;) {
    for (const scenario of scenarios) {
      const cfg = buildPaperRuntime(base, paperCfg, scenario);

      try {
        // 先检查止损/止盈
        await checkExits(cfg);

        // 再检测买卖信号
        for (const symbol of cfg.symbols) {
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

    log(`⏰ 等待 ${POLL_INTERVAL_MS / 1000}s 后下一轮...`);
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Fatal:", msg);
  process.exit(1);
});

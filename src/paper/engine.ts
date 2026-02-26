/**
 * Paper Trading 引擎
 * 接收信号 → 执行模拟交易 → 止损/止盈/追踪止损检查
 * 每个场景使用独立的账户文件（logs/paper-{scenarioId}.json）
 */

import type { Signal, RuntimeConfig } from "../types.js";
import { calcAtrPositionSize } from "../strategy/indicators.js";
import { checkMinimalRoi } from "../strategy/roi-table.js";
import { resolveNewStopLoss } from "../strategy/break-even.js";
import { shouldConfirmExit, isExitRejectionCoolingDown } from "../strategy/confirm-exit.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import { logSignal, closeSignal } from "../signals/history.js";
import { TradeDB } from "../persistence/db.js";

// ── G5: SQLite 懒加载单例（每个 scenarioId 一个 DB）──────────
const _dbMap = new Map<string, TradeDB>();

// ── P8.2: 出场拒绝冷却记录（symbol → 上次被拒绝的时间戳）──────
const _exitRejectionLog = new Map<string, number>();

function getDb(scenarioId: string): TradeDB {
  const existing = _dbMap.get(scenarioId);
  if (existing) return existing;
  const db = new TradeDB(`logs/trades-${scenarioId}.db`);
  _dbMap.set(scenarioId, db);
  return db;
}
import {
  loadAccount,
  saveAccount,
  paperBuy,
  paperDcaAdd,
  paperSell,
  paperOpenShort,
  paperCoverShort,
  calcTotalEquity,
  getAccountSummary,
  updateTrailingStop,
  resetDailyLossIfNeeded,
  type PaperTrade,
  type PaperAccount,
  type PaperPosition,
} from "./account.js";

export interface PaperEngineResult {
  trade: PaperTrade | null;
  skipped?: string | undefined;
  stopLossTriggered: boolean;
  stopLossTrade: PaperTrade | null;
  account: PaperAccount;
}

function scenarioId(cfg: RuntimeConfig): string {
  return cfg.paper.scenarioId;
}

function paperOpts(cfg: RuntimeConfig) {
  return {
    feeRate: cfg.paper.fee_rate,
    slippagePercent: cfg.paper.slippage_percent,
    minOrderUsdt: cfg.execution.min_order_usdt,
    stopLossPercent: cfg.risk.stop_loss_percent,
    takeProfitPercent: cfg.risk.take_profit_percent,
    positionRatio: cfg.risk.position_ratio,
  };
}

/**
 * 处理信号：开仓/平仓（含仓位数量、单币占比、每日亏损检查）
 */
export function handleSignal(signal: Signal, cfg: RuntimeConfig): PaperEngineResult {
  const sid = scenarioId(cfg);
  const account = loadAccount(cfg.paper.initial_usdt, sid);
  resetDailyLossIfNeeded(account);

  let trade: PaperTrade | null = null;
  let skipped: string | undefined;

  if (signal.type === "buy") {
    const openCount = Object.keys(account.positions).length;
    if (openCount >= cfg.risk.max_positions) {
      skipped = `已达最大持仓数 ${cfg.risk.max_positions}，跳过 ${signal.symbol}`;
    } else {
      const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
      const existingPos = account.positions[signal.symbol];
      const symbolValue = existingPos ? existingPos.quantity * signal.price : 0;
      if (symbolValue / equity >= cfg.risk.max_position_per_symbol) {
        skipped = `${signal.symbol} 已达单币最大仓位 ${(cfg.risk.max_position_per_symbol * 100).toFixed(0)}%，跳过`;
      } else if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) {
        skipped = `今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`;
      }
    }

    if (!skipped) {
      // ── ATR 动态仓位计算 ──
      let overridePositionUsdt: number | undefined;
      const atrCfg = cfg.risk.atr_position;
      if (atrCfg?.enabled && signal.indicators.atr) {
        const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
        overridePositionUsdt = calcAtrPositionSize(
          equity,
          signal.price,
          signal.indicators.atr,
          atrCfg.risk_per_trade_percent / 100,
          atrCfg.atr_multiplier,
          atrCfg.max_position_ratio
        );
      }

      trade = paperBuy(
        account,
        signal.symbol,
        signal.price,
        signal.reason.join(", "),
        {
          ...paperOpts(cfg),
          ...(overridePositionUsdt !== undefined ? { overridePositionUsdt } : {}),
        }
      );

      // ── 初始化分批止盈进度 + 记录信号历史 ──
      const newPos = trade ? account.positions[signal.symbol] : undefined;
      if (newPos) {
        if (cfg.risk.take_profit_stages?.length) {
          newPos.tpStages = cfg.risk.take_profit_stages.map((s) => ({
            stagePct: s.at_percent,
            closeRatio: s.close_ratio,
            triggered: false,
          }));
        }
        // 记录入场信号
        try {
          const sigId = logSignal({
            symbol: signal.symbol,
            type: "buy",
            entryPrice: signal.price,
            conditions: {
              maShort: signal.indicators.maShort,
              maLong: signal.indicators.maLong,
              rsi: signal.indicators.rsi,
              ...(signal.indicators.atr !== undefined && { atr: signal.indicators.atr }),
              triggeredRules: signal.reason,
            },
            scenarioId: cfg.paper.scenarioId,
            source: "paper",
          });
          newPos.signalHistoryId = sigId;
        } catch { /* 不影响主流程 */ }

        // ── G5: SQLite 持久化（可选）──
        if (cfg.paper.use_sqlite === true && trade) {
          try {
            const db = getDb(cfg.paper.scenarioId);
            newPos.dbId = db.insertTrade(
              cfg.paper.scenarioId,
              signal.symbol,
              "buy",
              newPos.quantity,
              trade.price,
              newPos.stopLoss,
              newPos.takeProfit,
              trade.timestamp
            );
          } catch { /* SQLite 失败不影响主流程 */ }
        }

        // ── 初始化 DCA 状态（如已配置）──
        const dcaCfg = cfg.risk.dca;
        if (dcaCfg?.enabled && dcaCfg.tranches > 1) {
          newPos.dcaState = {
            totalTranches: dcaCfg.tranches,
            completedTranches: 1,
            lastTranchePrice: trade?.price ?? signal.price,
            dropPct: dcaCfg.drop_pct,
            startedAt: Date.now(),
            maxMs: dcaCfg.max_hours * 3600 * 1000,
          };
        }
      }
    }
  } else if (signal.type === "sell") {
    // 取出 signalHistoryId 用于关闭记录
    const posBeforeSell = account.positions[signal.symbol];
    const sigHistId = posBeforeSell?.signalHistoryId;
    trade = paperSell(
      account,
      signal.symbol,
      signal.price,
      signal.reason.join(", "),
      paperOpts(cfg)
    );
    if (trade && sigHistId) {
      try { closeSignal(sigHistId, signal.price, "signal", trade.pnl); } catch { /* skip */ }
    }
  } else if (signal.type === "short") {
    // ── 开空（仅 futures / margin 市场有效）──
    const market = cfg.exchange.market;
    if (market !== "futures" && market !== "margin") {
      skipped = `开空信号被忽略：当前市场类型为 ${market}，做空需要 futures 或 margin`;
    } else {
      const openCount = Object.keys(account.positions).length;
      if (openCount >= cfg.risk.max_positions) {
        skipped = `已达最大持仓数 ${cfg.risk.max_positions}，跳过开空 ${signal.symbol}`;
      } else {
        const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
        const existingPos = account.positions[signal.symbol];
        const symbolValue = existingPos
          ? (existingPos.marginUsdt ?? existingPos.quantity * signal.price)
          : 0;
        if (symbolValue / equity >= cfg.risk.max_position_per_symbol) {
          skipped = `${signal.symbol} 已达单币最大仓位，跳过开空`;
        } else if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) {
          skipped = `今日亏损已达 ${cfg.risk.daily_loss_limit_percent}%，暂停当日开仓`;
        }
      }
    }

    if (!skipped) {
      let overridePositionUsdt: number | undefined;
      const atrCfg = cfg.risk.atr_position;
      if (atrCfg?.enabled && signal.indicators.atr) {
        const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
        overridePositionUsdt = calcAtrPositionSize(
          equity,
          signal.price,
          signal.indicators.atr,
          atrCfg.risk_per_trade_percent / 100,
          atrCfg.atr_multiplier,
          atrCfg.max_position_ratio
        );
      }
      trade = paperOpenShort(
        account,
        signal.symbol,
        signal.price,
        signal.reason.join(", "),
        {
          ...paperOpts(cfg),
          ...(overridePositionUsdt !== undefined ? { overridePositionUsdt } : {}),
        }
      );
      // 记录开空信号
      const newShortPos = trade ? account.positions[signal.symbol] : undefined;
      if (newShortPos) {
        try {
          const sigId = logSignal({
            symbol: signal.symbol,
            type: "short",
            entryPrice: signal.price,
            conditions: {
              maShort: signal.indicators.maShort,
              maLong: signal.indicators.maLong,
              rsi: signal.indicators.rsi,
              ...(signal.indicators.atr !== undefined && { atr: signal.indicators.atr }),
              triggeredRules: signal.reason,
            },
            scenarioId: cfg.paper.scenarioId,
            source: "paper",
          });
          newShortPos.signalHistoryId = sigId;
        } catch { /* 不影响主流程 */ }

        // ── G5: SQLite 持久化（可选）──
        if (cfg.paper.use_sqlite === true && trade) {
          try {
            const db = getDb(cfg.paper.scenarioId);
            newShortPos.dbId = db.insertTrade(
              cfg.paper.scenarioId,
              signal.symbol,
              "short",
              newShortPos.quantity,
              trade.price,
              newShortPos.stopLoss,
              newShortPos.takeProfit,
              trade.timestamp
            );
          } catch { /* SQLite 失败不影响主流程 */ }
        }
      }
    }
  } else if (signal.type === "cover") {
    // ── 平空 ──
    const posBeforeCover = account.positions[signal.symbol];
    const sigHistIdCover = posBeforeCover?.signalHistoryId;
    trade = paperCoverShort(
      account,
      signal.symbol,
      signal.price,
      signal.reason.join(", "),
      paperOpts(cfg)
    );
    if (trade && sigHistIdCover) {
      try { closeSignal(sigHistIdCover, signal.price, "signal", trade.pnl); } catch { /* skip */ }
    }
  }

  saveAccount(account, sid);
  return { trade, skipped, stopLossTriggered: false, stopLossTrade: null, account };
}

/**
 * 分批止盈检查（内部辅助函数）
 * 遍历 tpStages，触发未执行的档位，执行部分平仓
 */
function checkStagedTakeProfit(
  account: PaperAccount,
  symbol: string,
  pos: PaperPosition,
  currentPrice: number,
  cfg: RuntimeConfig,
  triggered: { symbol: string; trade: PaperTrade; reason: ExitReason; pnlPercent: number }[]
): void {
  if (!pos.tpStages) return;
  const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // 用 entries() 获取索引，避免 indexOf 的 O(n) 搜索
  for (const [idx, stage] of pos.tpStages.entries()) {
    if (stage.triggered) continue;
    if (pnlPercent < stage.stagePct) continue;

    // 部分平仓：按当前剩余持仓的比例平仓
    const partialQty = pos.quantity * stage.closeRatio;
    if (partialQty <= 0) continue;

    const label = `分批止盈第${idx + 1}档：盈利 ${pnlPercent.toFixed(2)}%，平掉 ${(stage.closeRatio * 100).toFixed(0)}% 仓位`;
    const trade = paperSell(account, symbol, currentPrice, label, {
      ...paperOpts(cfg),
      overrideQty: partialQty,
    });
    if (trade) {
      stage.triggered = true;
      triggered.push({ symbol, trade, reason: "take_profit", pnlPercent });
    }
    // 若持仓已被全部卖出，停止检查后续档位
    if (!account.positions[symbol]) break;
  }
}

/**
 * 检查所有持仓的止损/止盈/追踪止损
 */
export type ExitReason = "stop_loss" | "take_profit" | "trailing_stop" | "time_stop";

export function checkExitConditions(
  prices: Record<string, number>,
  cfg: RuntimeConfig,
  strategy?: Strategy,
  ctx?: StrategyContext
): {
  symbol: string;
  trade: PaperTrade;
  reason: ExitReason;
  pnlPercent: number;
}[] {
  const sid = scenarioId(cfg);
  const account = loadAccount(cfg.paper.initial_usdt, sid);
  resetDailyLossIfNeeded(account);
  const triggered: {
    symbol: string;
    trade: PaperTrade;
    reason: ExitReason;
    pnlPercent: number;
  }[] = [];

  const EXIT_TIMEOUT_MAX_RETRIES = 3; // 与 executor.ts 保持一致

  for (const [symbol, pos] of Object.entries(account.positions)) {
    const currentPrice = prices[symbol];
    if (!currentPrice) continue;

    const isShort = pos.side === "short";

    // ── 强制出场：连续超时后立即市价出场 ──
    if ((pos.exitTimeoutCount ?? 0) >= EXIT_TIMEOUT_MAX_RETRIES) {
      const forceLabel = `force_exit_timeout：出场超时 ${EXIT_TIMEOUT_MAX_RETRIES} 次，强制市价出场`;
      const trade = isShort
        ? paperCoverShort(account, symbol, currentPrice, forceLabel, paperOpts(cfg))
        : paperSell(account, symbol, currentPrice, forceLabel, paperOpts(cfg));
      if (trade) {
        const pnlPct = isShort
          ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
          : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        triggered.push({ symbol, trade, reason: "stop_loss", pnlPercent: pnlPct });
      }
      continue;
    }

    // 盈亏百分比：多头=价格涨幅，空头=价格跌幅（下跌时空头盈利为正）
    const pnlPercent = isShort
      ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
      : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // ── P8.1 Break-Even Stop / Custom Stoploss ──
    {
      const holdMs = Date.now() - pos.entryTime;
      const profitRatio = isShort
        ? (pos.entryPrice - currentPrice) / pos.entryPrice
        : (currentPrice - pos.entryPrice) / pos.entryPrice;
      const newStop = resolveNewStopLoss(
        pos.side ?? "long",
        pos.entryPrice,
        pos.stopLoss,
        currentPrice,
        profitRatio,
        holdMs,
        symbol,
        cfg.risk,
        strategy,
        ctx
      );
      if (newStop !== null) {
        pos.stopLoss = newStop;
      }
    }

    let exitReason: "stop_loss" | "take_profit" | "trailing_stop" | "time_stop" | null = null;
    let exitLabel = "";

    // ── 止损：多头=价格跌破，空头=价格涨破 ──
    const hitStopLoss = isShort
      ? currentPrice >= pos.stopLoss  // 空头：价格上涨到止损线
      : currentPrice <= pos.stopLoss; // 多头：价格下跌到止损线

    // ── 止盈：多头=价格涨到目标，空头=价格跌到目标 ──
    const hitTakeProfit = isShort
      ? currentPrice <= pos.takeProfit  // 空头：价格下跌到止盈线
      : currentPrice >= pos.takeProfit; // 多头：价格上涨到止盈线

    // ── ROI Table：时间衰减止盈（优先于固定止盈，依赖持仓时长）──
    const roiTable = cfg.risk.minimal_roi;
    const hitRoiTable =
      roiTable !== undefined &&
      Object.keys(roiTable).length > 0 &&
      (() => {
        const holdMs = Date.now() - pos.entryTime;
        const profitRatio = isShort
          ? (pos.entryPrice - currentPrice) / pos.entryPrice
          : (currentPrice - pos.entryPrice) / pos.entryPrice;
        return checkMinimalRoi(roiTable, holdMs, profitRatio);
      })();

    if (hitStopLoss) {
      exitReason = "stop_loss";
      exitLabel = `止损触发：亏损 ${Math.abs(pnlPercent).toFixed(2)}%`;
    } else if (hitRoiTable) {
      exitReason = "take_profit";
      const holdMin = Math.round((Date.now() - pos.entryTime) / 60_000);
      exitLabel = `ROI Table 止盈：持仓 ${holdMin}min，盈利 ${pnlPercent.toFixed(2)}%`;
    } else if (hitTakeProfit) {
      exitReason = "take_profit";
      exitLabel = `止盈触发：盈利 ${pnlPercent.toFixed(2)}%`;
    } else if (cfg.risk.trailing_stop.enabled) {
      // ── G4 增强型 Trailing Stop（仿 Freqtrade）────────────────
      // positive trailing：盈利达到 offset 后切换为更紧的 trailing 幅度
      const positivePct = cfg.risk.trailing_stop_positive;
      const positiveOffset = cfg.risk.trailing_stop_positive_offset;
      const onlyOffset = cfg.risk.trailing_only_offset_is_reached;

      // 检查是否应激活 positive trailing
      if (positivePct !== undefined && positiveOffset !== undefined) {
        const offsetPct = positiveOffset * 100; // 如 0.02 → 2%
        if (!pos.trailingStopActivated && pnlPercent >= offsetPct) {
          pos.trailingStopActivated = true;
        }
      }

      // trailing_only_offset_is_reached=true + offset 未达到 → 跳过 trailing
      const skipTrailing =
        onlyOffset === true &&
        positivePct !== undefined &&
        positiveOffset !== undefined &&
        !pos.trailingStopActivated;

      if (!skipTrailing) {
        // 使用 positive trailing 幅度（已激活）或原始 callback_percent
        const callbackPct =
          pos.trailingStopActivated && positivePct !== undefined
            ? positivePct * 100
            : cfg.risk.trailing_stop.callback_percent;

        const shouldExit = updateTrailingStop(pos, currentPrice, {
          activationPercent: cfg.risk.trailing_stop.activation_percent,
          callbackPercent: callbackPct,
        });
        if (shouldExit) {
          exitReason = "trailing_stop";
          const dirLabel = isShort
            ? `从最低价反弹 ${callbackPct.toFixed(1)}%`
            : `从最高价回撤 ${callbackPct.toFixed(1)}%`;
          const positiveLabel = pos.trailingStopActivated ? "（positive trailing）" : "";
          exitLabel = `追踪止损触发${positiveLabel}：${dirLabel}`;
        }
      }
    }

    // ── 时间止损（多空均适用）──
    if (!exitReason && cfg.risk.time_stop_hours) {
      const holdingHours = (Date.now() - pos.entryTime) / 3_600_000;
      if (holdingHours >= cfg.risk.time_stop_hours && pnlPercent <= 0) {
        exitReason = "time_stop";
        exitLabel = `时间止损：持仓 ${holdingHours.toFixed(1)}h 未盈利`;
      }
    }

    if (exitReason) {
      // ── P8.2 出场确认钩子 ──────────────────────────────────────
      {
        const holdMs = Date.now() - pos.entryTime;
        const profitRatio = isShort
          ? (pos.entryPrice - currentPrice) / pos.entryPrice
          : (currentPrice - pos.entryPrice) / pos.entryPrice;
        const maxDev = cfg.execution.max_exit_price_deviation ?? 0.15;
        const cooldownSec = cfg.execution.exit_rejection_cooldown_seconds ?? 300;
        const confirmResult = shouldConfirmExit(
          { symbol, side: pos.side ?? "long", entryPrice: pos.entryPrice, currentPrice, profitRatio, holdMs },
          exitReason,
          maxDev,
          strategy,
          ctx
        );
        if (!confirmResult.confirmed) {
          const cooling = isExitRejectionCoolingDown(symbol, cooldownSec * 1000, _exitRejectionLog);
          if (!cooling) {
            console.log(
              `[confirm-exit] ${symbol} 出场被拒绝 (reason: ${confirmResult.reason ?? "unknown"}, exitReason: ${exitReason})`
            );
            _exitRejectionLog.set(symbol, Date.now());
          }
          continue;
        }
      }
      // ── 出场执行 ──────────────────────────────────────────────
      const sigHistId = pos.signalHistoryId;
      const posDbId = pos.dbId; // G5
      // 多头用 paperSell，空头用 paperCoverShort
      const trade = isShort
        ? paperCoverShort(account, symbol, currentPrice, exitLabel, paperOpts(cfg))
        : paperSell(account, symbol, currentPrice, exitLabel, paperOpts(cfg));
      if (trade) {
        triggered.push({ symbol, trade, reason: exitReason, pnlPercent });
        // 回写信号历史
        if (sigHistId) {
          try { closeSignal(sigHistId, currentPrice, exitReason, trade.pnl); } catch { /* skip */ }
        }
        // ── G5: SQLite 持久化（可选）──
        if (cfg.paper.use_sqlite === true && posDbId !== undefined) {
          try {
            const db = getDb(cfg.paper.scenarioId);
            db.closeTrade(
              posDbId,
              currentPrice,
              trade.pnl ?? 0,
              pnlPercent / 100,
              exitReason === "stop_loss" || exitReason === "trailing_stop",
              exitReason === "take_profit",
              Date.now()
            );
          } catch { /* SQLite 失败不影响主流程 */ }
        }
      }
      continue;
    }

    // ── 分批止盈（仅多头，无法全仓出场时才检查）──
    if (!isShort && pos.tpStages) {
      checkStagedTakeProfit(account, symbol, pos, currentPrice, cfg, triggered);
    }
  }

  // 有持仓时始终保存（追踪止损状态在每次价格更新后都可能变化）
  if (Object.keys(account.positions).length > 0 || triggered.length > 0) {
    saveAccount(account, sid);
  }
  return triggered;
}

/** compat shim — 只返回止损类出场（含时间止损） */
export function checkStopLoss(
  prices: Record<string, number>,
  cfg: RuntimeConfig
): { symbol: string; trade: PaperTrade; loss: number }[] {
  return checkExitConditions(prices, cfg)
    .filter((r) => r.reason === "stop_loss" || r.reason === "time_stop")
    .map((r) => ({ symbol: r.symbol, trade: r.trade, loss: r.pnlPercent / 100 }));
}

export function checkMaxDrawdown(prices: Record<string, number>, cfg: RuntimeConfig): boolean {
  const account = loadAccount(cfg.paper.initial_usdt, scenarioId(cfg));
  const equity = calcTotalEquity(account, prices);
  return (
    (equity - account.initialUsdt) / account.initialUsdt <= -cfg.risk.max_total_loss_percent / 100
  );
}

export function checkDailyLossLimit(prices: Record<string, number>, cfg: RuntimeConfig): boolean {
  const account = loadAccount(cfg.paper.initial_usdt, scenarioId(cfg));
  resetDailyLossIfNeeded(account);
  const equity = calcTotalEquity(account, prices);
  return (account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent;
}

/**
 * 检查所有持仓的 DCA 追加条件
 *
 * 触发条件（全部满足才执行）：
 * 1. 持仓有 dcaState 且未完成所有批次
 * 2. 当前价格比上次追加价下跌了 ≥ dropPct%
 * 3. DCA 开始至今未超过 maxMs（防止无限套牢）
 *
 * 若传入策略插件且策略实现了 adjustPosition，则优先调用策略逻辑：
 *   > 0 → 加仓（策略指定金额）
 *   < 0 → 减仓（减掉对应 USDT 价值的仓位）
 *   0 / null → 回退到内置 dropPct DCA 逻辑
 *
 * @returns 本次追加/减仓的交易列表（可能为空）
 */
export function checkDcaTranches(
  prices: Record<string, number>,
  cfg: RuntimeConfig,
  strategy?: Strategy,
  ctx?: StrategyContext
): { symbol: string; trade: PaperTrade; tranche: number; totalTranches: number }[] {
  const sid = scenarioId(cfg);
  const account = loadAccount(cfg.paper.initial_usdt, sid);
  const dcaCfg = cfg.risk.dca;
  if (!dcaCfg?.enabled) return [];

  const executed: { symbol: string; trade: PaperTrade; tranche: number; totalTranches: number }[] = [];

  for (const [symbol, pos] of Object.entries(account.positions)) {
    if (!pos.dcaState) continue;
    const dca = pos.dcaState;

    const currentPrice = prices[symbol];
    if (!currentPrice) continue;

    const side = (pos.side ?? "long") as "long" | "short";
    const costBasis = pos.quantity * pos.entryPrice;
    const profitRatio = side === "short"
      ? (pos.entryPrice - currentPrice) / pos.entryPrice
      : (currentPrice - pos.entryPrice) / pos.entryPrice;
    const holdMs = Date.now() - pos.entryTime;
    const dcaCount = dca.completedTranches - 1; // completedTranches includes first entry

    // ── 优先：策略 adjustPosition 钩子 ──────────────────────────
    if (strategy?.adjustPosition !== undefined && ctx !== undefined) {
      const adjustAmount = strategy.adjustPosition(
        {
          symbol,
          side,
          entryPrice: pos.entryPrice,
          currentPrice,
          quantity: pos.quantity,
          costBasis,
          profitRatio,
          holdMs,
          dcaCount,
        },
        ctx
      );

      if (adjustAmount !== null && adjustAmount !== 0) {
        if (adjustAmount > 0) {
          // 加仓：检查余额是否充足
          if (account.usdt >= adjustAmount) {
            const trade = paperDcaAdd(
              account,
              symbol,
              currentPrice,
              `adjustPosition 加仓 $${adjustAmount.toFixed(2)}`,
              { addUsdt: adjustAmount, feeRate: 0.001 }
            );
            if (trade) {
              executed.push({
                symbol,
                trade,
                tranche: dca.completedTranches,
                totalTranches: dca.totalTranches,
              });
            }
          }
        } else {
          // 减仓：卖出对应 USDT 价值的仓位
          const reduceUsdt = Math.abs(adjustAmount);
          const reduceQty = reduceUsdt / currentPrice;
          if (reduceQty > 0 && reduceQty <= pos.quantity) {
            const trade = paperSell(
              account,
              symbol,
              currentPrice,
              `adjustPosition 减仓 $${reduceUsdt.toFixed(2)}`,
              { ...paperOpts(cfg), overrideQty: reduceQty }
            );
            if (trade) {
              executed.push({
                symbol,
                trade,
                tranche: dca.completedTranches,
                totalTranches: dca.totalTranches,
              });
            }
          }
        }
        // 策略已处理（加仓或减仓），不再走默认 DCA 逻辑
        continue;
      }
      // adjustAmount === 0 or null → fall through to default DCA logic
    }

    // ── 默认 DCA 逻辑 ────────────────────────────────────────────
    // 已完成所有批次 → 跳过
    if (dca.completedTranches >= dca.totalTranches) continue;

    // 超时 → 跳过（不再追加）
    if (Date.now() - dca.startedAt > dca.maxMs) continue;

    // 价格下跌足够 → 触发追加
    const dropPct = ((dca.lastTranchePrice - currentPrice) / dca.lastTranchePrice) * 100;
    if (dropPct < dca.dropPct) continue;

    // 本次追加金额：与第一批相同比例
    const equity = calcTotalEquity(account, prices);
    const addUsdt = equity * cfg.risk.position_ratio;

    const trade = paperDcaAdd(account, symbol, currentPrice, `DCA 第 ${dca.completedTranches + 1} 批（跌幅 ${dropPct.toFixed(1)}%）`, {
      addUsdt,
      feeRate: cfg.execution.order_type === "market" ? 0.001 : 0.001,
    });

    if (trade) {
      executed.push({
        symbol,
        trade,
        tranche: dca.completedTranches,     // 已更新为 +1 后的值
        totalTranches: dca.totalTranches,
      });
    }
  }

  if (executed.length > 0) {
    saveAccount(account, sid);
  }

  return executed;
}

export function getPaperSummary(prices: Record<string, number>, cfg: RuntimeConfig) {
  return getAccountSummary(loadAccount(cfg.paper.initial_usdt, scenarioId(cfg)), prices);
}

export function formatSummaryMessage(
  prices: Record<string, number>,
  cfg: RuntimeConfig,
  mode: "full" | "brief" = "full"
): string {
  const summary = getPaperSummary(prices, cfg);
  const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";
  const pnlSign = summary.totalPnl >= 0 ? "+" : "";
  const marketLabel = cfg.exchange.market.toUpperCase();
  const leverageLabel = cfg.exchange.leverage?.enabled ? ` ${cfg.exchange.leverage.default}x` : "";

  const lines: string[] = [
    `📊 **[${marketLabel}${leverageLabel}]** ${new Date().toLocaleString("zh-CN")}`,
    ``,
    `💰 USDT 余额: $${summary.usdt.toFixed(2)}`,
    `💼 总资产: $${summary.totalEquity.toFixed(2)}`,
    `${pnlEmoji} 总盈亏: ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`,
    `🔴 今日亏损: $${summary.dailyLoss.toFixed(2)}`,
  ];

  if (summary.positions.length > 0) {
    lines.push(``, `📋 当前持仓 (${summary.positions.length}/${cfg.risk.max_positions}):`);
    for (const pos of summary.positions) {
      const posSign = pos.unrealizedPnl >= 0 ? "+" : "";
      const posEmoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      const dirLabel = pos.side === "short" ? "📉SHORT" : "📈LONG";
      lines.push(
        `  ${posEmoji} ${dirLabel} ${pos.symbol}: $${pos.entryPrice.toFixed(4)} → $${pos.currentPrice.toFixed(4)} | ${posSign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`,
        `     止损: $${pos.stopLoss.toFixed(4)} | 止盈: $${pos.takeProfit.toFixed(4)}`
      );
    }
  } else {
    lines.push(``, `📭 当前无持仓`);
  }

  if (mode === "full") {
    lines.push(
      ``,
      `📈 总交易次数: ${summary.tradeCount}`,
      `🎯 胜率: ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "暂无数据"}`
    );
  }

  return lines.join("\n");
}

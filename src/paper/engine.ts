/**
 * Paper Trading engine
 * Receives signals -> executes simulated trades -> stop loss/take profit/trailing stop checks
 * Each scenario uses an independent account file (logs/paper-{scenarioId}.json)
 */

import type { Signal, RuntimeConfig } from "../types.js";
import { calcAtrPositionSize } from "../strategy/indicators.js";
import { checkMinimalRoi } from "../strategy/roi-table.js";
import { resolveNewStopLoss } from "../strategy/break-even.js";
import { shouldConfirmExit, isExitRejectionCoolingDown } from "../strategy/confirm-exit.js";
import type { Strategy, StrategyContext } from "../strategies/types.js";
import { logSignal, closeSignal } from "../strategy/signal-history.js";
import { createLogger } from "../logger.js";
import { TradeDB } from "../persistence/db.js";

// ── G5: SQLite lazy singleton (one DB per scenarioId) ──────────
const _dbMap = new Map<string, TradeDB>();

// ── P8.2: Exit rejection cooldown log (symbol -> last rejection timestamp) ──────
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

const log = createLogger("engine");

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
 * Handle signal: open/close positions (includes position sizing, per-symbol limit, daily loss checks)
 */
export function handleSignal(signal: Signal, cfg: RuntimeConfig): PaperEngineResult {
  const sid = scenarioId(cfg);

  // ── Guard: invalid signal price (NaN / 0 / negative / Infinity) -> skip ──
  if (!signal.price || !isFinite(signal.price) || signal.price <= 0) {
    return {
      trade: null,
      skipped: `Invalid signal price (${signal.price}), skipping ${signal.symbol}`,
      stopLossTriggered: false,
      stopLossTrade: null,
      account: loadAccount(cfg.paper.initial_usdt, sid),
    };
  }

  const account = loadAccount(cfg.paper.initial_usdt, sid);
  resetDailyLossIfNeeded(account);

  let trade: PaperTrade | null = null;
  let skipped: string | undefined;

  if (signal.type === "buy") {
    const openCount = Object.keys(account.positions).length;
    if (openCount >= cfg.risk.max_positions) {
      skipped = `Max positions ${cfg.risk.max_positions} reached, skipping ${signal.symbol}`;
    } else {
      const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
      // ── Guard: equity <= 0 -> abnormal account equity, skip buy signal ──
      if (equity <= 0) {
        skipped = `Abnormal account equity (${equity.toFixed(2)} USDT), skipping ${signal.symbol}`;
      } else {
        const existingPos = account.positions[signal.symbol];
        const symbolValue = existingPos ? existingPos.quantity * signal.price : 0;
        if (symbolValue / equity >= cfg.risk.max_position_per_symbol) {
          skipped = `${signal.symbol} reached max per-symbol position ${(cfg.risk.max_position_per_symbol * 100).toFixed(0)}%, skipping`;
        } else if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) {
          skipped = `Daily loss reached ${cfg.risk.daily_loss_limit_percent}%, pausing new entries for today`;
        }
      }
    }

    if (!skipped) {
      // ── ATR dynamic position sizing ──
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

      // ── Initialize staged take profit progress + log signal history ──
      const newPos = trade ? account.positions[signal.symbol] : undefined;
      if (newPos) {
        if (cfg.risk.take_profit_stages?.length) {
          newPos.tpStages = cfg.risk.take_profit_stages.map((s) => ({
            stagePct: s.at_percent,
            closeRatio: s.close_ratio,
            triggered: false,
          }));
        }
        // Log entry signal
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
        } catch { /* does not affect main flow */ }

        // ── G5: SQLite persistence (optional) ──
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
          } catch { /* SQLite failure does not affect main flow */ }
        }

        // ── Initialize DCA state (if configured) ──
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
    // Extract signalHistoryId for closing the record
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
    // ── Open short (only valid on futures / margin markets) ──
    const market = cfg.exchange.market;
    if (market !== "futures" && market !== "margin") {
      skipped = `Short signal ignored: current market type is ${market}, shorting requires futures or margin`;
    } else {
      const openCount = Object.keys(account.positions).length;
      if (openCount >= cfg.risk.max_positions) {
        skipped = `Max positions ${cfg.risk.max_positions} reached, skipping short ${signal.symbol}`;
      } else {
        const equity = calcTotalEquity(account, { [signal.symbol]: signal.price });
        // ── Guard: equity <= 0 -> abnormal account equity, skip short signal ──
        if (equity <= 0) {
          skipped = `Abnormal account equity (${equity.toFixed(2)} USDT), skipping short ${signal.symbol}`;
        } else {
          const existingPos = account.positions[signal.symbol];
          const symbolValue = existingPos
            ? (existingPos.marginUsdt ?? existingPos.quantity * signal.price)
            : 0;
          if (symbolValue / equity >= cfg.risk.max_position_per_symbol) {
            skipped = `${signal.symbol} reached max per-symbol position, skipping short`;
          } else if ((account.dailyLoss.loss / equity) * 100 >= cfg.risk.daily_loss_limit_percent) {
            skipped = `Daily loss reached ${cfg.risk.daily_loss_limit_percent}%, pausing new entries for today`;
          }
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
      // Log short entry signal
      const newShortPos = trade ? account.positions[signal.symbol] : undefined;
      if (newShortPos) {
        // A-007 fix: initialize staged take profit for short positions too
        if (cfg.risk.take_profit_stages?.length) {
          newShortPos.tpStages = cfg.risk.take_profit_stages.map((s) => ({
            stagePct: s.at_percent,
            closeRatio: s.close_ratio,
            triggered: false,
          }));
        }
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
        } catch { /* does not affect main flow */ }

        // ── G5: SQLite persistence (optional) ──
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
          } catch { /* SQLite failure does not affect main flow */ }
        }
      }
    }
  } else if (signal.type === "cover") {
    // ── Cover short ──
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
 * Staged take profit check (internal helper)
 * Iterates tpStages, triggers untriggered stages, executes partial closes
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
  // ── Guard: entryPrice <= 0 would cause NaN in pnlPercent ──
  if (pos.entryPrice <= 0) return;
  const isShort = pos.side === "short";
  // A-007 fix: profit direction reversed for short positions
  const pnlPercent = isShort
    ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
    : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // Use entries() for index, avoiding O(n) indexOf lookup
  for (const [idx, stage] of pos.tpStages.entries()) {
    if (stage.triggered) continue;
    if (pnlPercent < stage.stagePct) continue;

    // Partial close: close proportion of remaining position
    const partialQty = pos.quantity * stage.closeRatio;
    if (partialQty <= 0) continue;

    const label = `Staged TP stage ${idx + 1}: profit ${pnlPercent.toFixed(2)}%, closing ${(stage.closeRatio * 100).toFixed(0)}% of position`;
    // A-007 fix: use paperCoverShort for short positions
    const trade = isShort
      ? paperCoverShort(account, symbol, currentPrice, label, { ...paperOpts(cfg), overrideQty: partialQty })
      : paperSell(account, symbol, currentPrice, label, { ...paperOpts(cfg), overrideQty: partialQty });
    if (trade) {
      stage.triggered = true;
      triggered.push({ symbol, trade, reason: "take_profit", pnlPercent });
    }
    // If position fully closed, stop checking remaining stages
    if (!account.positions[symbol]) break;
  }
}

/**
 * Check all positions for stop loss / take profit / trailing stop
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

  const EXIT_TIMEOUT_MAX_RETRIES = 3; // Keep in sync with executor.ts

  for (const [symbol, pos] of Object.entries(account.positions)) {
    const currentPrice = prices[symbol];
    if (!currentPrice) continue;
    // ── Guard: entryPrice <= 0 would cause NaN in pnlPercent/profitRatio ──
    if (pos.entryPrice <= 0) continue;

    const isShort = pos.side === "short";

    // ── Force exit: market exit after consecutive timeouts ──
    if ((pos.exitTimeoutCount ?? 0) >= EXIT_TIMEOUT_MAX_RETRIES) {
      const forceLabel = `force_exit_timeout: exit timed out ${EXIT_TIMEOUT_MAX_RETRIES} times, forcing market exit`;
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

    // PnL percentage: long=price rise, short=price drop (drop is positive profit for short)
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

    // ── Stop loss: long=price drops below, short=price rises above ──
    const hitStopLoss = isShort
      ? currentPrice >= pos.stopLoss  // Short: price rises to stop loss level
      : currentPrice <= pos.stopLoss; // Long: price drops to stop loss level

    // ── Take profit: long=price rises to target, short=price drops to target ──
    const hitTakeProfit = isShort
      ? currentPrice <= pos.takeProfit  // Short: price drops to take profit level
      : currentPrice >= pos.takeProfit; // Long: price rises to take profit level

    // ── ROI Table: time-decay take profit (takes priority over fixed TP, depends on hold duration) ──
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
      exitLabel = `Stop loss triggered: loss ${Math.abs(pnlPercent).toFixed(2)}%`;
    } else if (hitRoiTable) {
      exitReason = "take_profit";
      const holdMin = Math.round((Date.now() - pos.entryTime) / 60_000);
      exitLabel = `ROI Table take profit: held ${holdMin}min, profit ${pnlPercent.toFixed(2)}%`;
    } else if (hitTakeProfit) {
      exitReason = "take_profit";
      exitLabel = `Take profit triggered: profit ${pnlPercent.toFixed(2)}%`;
    } else if (cfg.risk.trailing_stop.enabled) {
      // ── G4 Enhanced Trailing Stop (Freqtrade-style) ────────────────
      // positive trailing: switches to tighter trailing distance after profit reaches offset
      const positivePct = cfg.risk.trailing_stop_positive;
      const positiveOffset = cfg.risk.trailing_stop_positive_offset;
      const onlyOffset = cfg.risk.trailing_only_offset_is_reached;

      // Check whether to activate positive trailing
      if (positivePct !== undefined && positiveOffset !== undefined) {
        const offsetPct = positiveOffset * 100; // e.g., 0.02 -> 2%
        if (!pos.trailingStopActivated && pnlPercent >= offsetPct) {
          pos.trailingStopActivated = true;
        }
      }

      // trailing_only_offset_is_reached=true + offset not reached -> skip trailing
      const skipTrailing =
        onlyOffset === true &&
        positivePct !== undefined &&
        positiveOffset !== undefined &&
        !pos.trailingStopActivated;

      if (!skipTrailing) {
        // Use positive trailing distance (if activated) or original callback_percent
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
            ? `bounced ${callbackPct.toFixed(1)}% from lowest`
            : `retraced ${callbackPct.toFixed(1)}% from highest`;
          const positiveLabel = pos.trailingStopActivated ? " (positive trailing)" : "";
          exitLabel = `Trailing stop triggered${positiveLabel}: ${dirLabel}`;
        }
      }
    }

    // ── Time stop (applies to both long and short) ──
    if (!exitReason && cfg.risk.time_stop_hours) {
      const holdingHours = (Date.now() - pos.entryTime) / 3_600_000;
      if (holdingHours >= cfg.risk.time_stop_hours && pnlPercent <= 0) {
        exitReason = "time_stop";
        exitLabel = `Time stop: held ${holdingHours.toFixed(1)}h without profit`;
      }
    }

    if (exitReason) {
      // ── P8.2 Exit confirmation hook ──────────────────────────────────────
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
            log.info(
              `[confirm-exit] ${symbol} exit rejected (reason: ${confirmResult.reason ?? "unknown"}, exitReason: ${exitReason})`
            );
            _exitRejectionLog.set(symbol, Date.now());
          }
          continue;
        }
      }
      // ── Execute exit ──────────────────────────────────────────────
      const sigHistId = pos.signalHistoryId;
      const posDbId = pos.dbId; // G5
      // Long uses paperSell, short uses paperCoverShort
      const trade = isShort
        ? paperCoverShort(account, symbol, currentPrice, exitLabel, paperOpts(cfg))
        : paperSell(account, symbol, currentPrice, exitLabel, paperOpts(cfg));
      if (trade) {
        triggered.push({ symbol, trade, reason: exitReason, pnlPercent });
        // Write back to signal history
        if (sigHistId) {
          try { closeSignal(sigHistId, currentPrice, exitReason, trade.pnl); } catch { /* skip */ }
        }
        // ── G5: SQLite persistence (optional) ──
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
          } catch { /* SQLite failure does not affect main flow */ }
        }
      }
      continue;
    }

    // ── Staged take profit (supports both long and short, A-007 fix) ──
    if (pos.tpStages) {
      checkStagedTakeProfit(account, symbol, pos, currentPrice, cfg, triggered);
    }
  }

  // Always save when positions exist (trailing stop state may change on every price update)
  if (Object.keys(account.positions).length > 0 || triggered.length > 0) {
    saveAccount(account, sid);
  }
  return triggered;
}

/** compat shim -- only returns stop loss exits (including time stop) */
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
 * Check DCA add conditions for all positions
 *
 * Trigger conditions (all must be met):
 * 1. Position has dcaState and not all tranches are completed
 * 2. Current price dropped >= dropPct% from last tranche price
 * 3. Time since DCA start has not exceeded maxMs (prevent infinite averaging down)
 *
 * If a strategy plugin is provided with adjustPosition implemented, it takes priority:
 *   > 0 -> add to position (strategy-specified amount)
 *   < 0 -> reduce position (sell corresponding USDT value)
 *   0 / null -> fall back to built-in dropPct DCA logic
 *
 * @returns List of add/reduce trades executed (may be empty)
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

    // ── Priority: strategy adjustPosition hook ──────────────────────────
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
          // Add to position: check if balance is sufficient
          if (account.usdt >= adjustAmount) {
            const trade = paperDcaAdd(
              account,
              symbol,
              currentPrice,
              `adjustPosition add $${adjustAmount.toFixed(2)}`,
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
          // Reduce position: sell corresponding USDT value
          const reduceUsdt = Math.abs(adjustAmount);
          const reduceQty = reduceUsdt / currentPrice;
          if (reduceQty > 0 && reduceQty <= pos.quantity) {
            const trade = paperSell(
              account,
              symbol,
              currentPrice,
              `adjustPosition reduce $${reduceUsdt.toFixed(2)}`,
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
        // Strategy has handled (add or reduce), skip default DCA logic
        continue;
      }
      // adjustAmount === 0 or null → fall through to default DCA logic
    }

    // ── Default DCA logic ────────────────────────────────────────────
    // All tranches completed -> skip
    if (dca.completedTranches >= dca.totalTranches) continue;

    // Timed out -> skip (no more additions)
    if (Date.now() - dca.startedAt > dca.maxMs) continue;

    // Price dropped enough -> trigger addition
    const dropPct = ((dca.lastTranchePrice - currentPrice) / dca.lastTranchePrice) * 100;
    if (dropPct < dca.dropPct) continue;

    // This tranche amount: same ratio as the first tranche
    const equity = calcTotalEquity(account, prices);
    const addUsdt = equity * cfg.risk.position_ratio;

    const trade = paperDcaAdd(account, symbol, currentPrice, `DCA tranche ${dca.completedTranches + 1} (drop ${dropPct.toFixed(1)}%)`, {
      addUsdt,
      feeRate: cfg.execution.order_type === "market" ? 0.001 : 0.001,
    });

    if (trade) {
      executed.push({
        symbol,
        trade,
        tranche: dca.completedTranches,     // Already updated to +1 value
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
    `📊 **[${marketLabel}${leverageLabel}]** ${new Date().toLocaleString("en-US")}`,
    ``,
    `💰 USDT Balance: $${summary.usdt.toFixed(2)}`,
    `💼 Total Equity: $${summary.totalEquity.toFixed(2)}`,
    `${pnlEmoji} Total PnL: ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${(summary.totalPnlPercent * 100).toFixed(2)}%)`,
    `🔴 Daily Loss: $${summary.dailyLoss.toFixed(2)}`,
  ];

  if (summary.positions.length > 0) {
    lines.push(``, `📋 Positions (${summary.positions.length}/${cfg.risk.max_positions}):`);
    for (const pos of summary.positions) {
      const posSign = pos.unrealizedPnl >= 0 ? "+" : "";
      const posEmoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
      const dirLabel = pos.side === "short" ? "📉SHORT" : "📈LONG";
      lines.push(
        `  ${posEmoji} ${dirLabel} ${pos.symbol}: $${pos.entryPrice.toFixed(4)} → $${pos.currentPrice.toFixed(4)} | ${posSign}${(pos.unrealizedPnlPercent * 100).toFixed(2)}%`,
        `     SL: $${pos.stopLoss.toFixed(4)} | TP: $${pos.takeProfit.toFixed(4)}`
      );
    }
  } else {
    lines.push(``, `📭 No open positions`);
  }

  if (mode === "full") {
    lines.push(
      ``,
      `📈 Total Trades: ${summary.tradeCount}`,
      `🎯 Win Rate: ${summary.tradeCount > 0 ? (summary.winRate * 100).toFixed(0) + "%" : "N/A"}`
    );
  }

  return lines.join("\n");
}

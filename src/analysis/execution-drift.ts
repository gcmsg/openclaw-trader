/**
 * Paper vs Live 执行漂移监控
 *
 * 对比同一信号在不同场景（paper / live）下的执行结果，
 * 检测滑点差异（执行漂移）。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PaperAccount, PaperTrade } from "../paper/account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

/** 默认偏差阈值 (%) */
export const DEFAULT_DRIFT_THRESHOLD = 0.5;

/** 匹配同场景 entryTime 的容忍窗口（毫秒） */
const MATCH_WINDOW_MS = 60_000; // 60 seconds

// ── 内部重建的「已平仓交易」记录 ──────────────────────────

interface ReconstructedTrade {
  symbol: string;
  side: "long" | "short";
  entryTime: number;
  entryFillPrice: number;
  /** 滑点金额 / 成交数量，即每单位滑点 (USDT/unit) */
  entrySlippagePerUnit: number;
  quantity: number;
}

// ── 公开接口 ──────────────────────────────────────────────

export interface DriftRecord {
  symbol: string;
  side: "long" | "short";
  signalTime: number; // 信号触发时间戳（= paper 入场时间）
  signalPrice: number; // 信号检测时的价格（填报价，从滑点倒算）
  paperFillPrice: number; // 模拟盘成交价
  liveFillPrice: number; // 实盘/testnet 成交价
  paperSlippage: number; // 模拟盘滑点 %
  liveSlippage: number; // 实盘滑点 %
  driftPercent: number; // 偏差 = |paperSlippage - liveSlippage|
  scenarioPaper: string; // paper 场景 ID
  scenarioLive: string; // live 场景 ID
}

// ── 辅助函数 ──────────────────────────────────────────────

/**
 * 从 paper-{scenarioId}.json 的 trades 数组中，
 * 重建所有已平仓交易（入场 → 出场配对）。
 */
export function reconstructClosedTrades(scenarioId: string): ReconstructedTrade[] {
  const filePath = path.join(LOGS_DIR, `paper-${scenarioId}.json`);
  if (!fs.existsSync(filePath)) return [];

  let account: PaperAccount;
  try {
    account = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PaperAccount;
  } catch {
    return [];
  }

  const trades = account.trades ?? [];
  const results: ReconstructedTrade[] = [];

  // 按 symbol 分组，按时间顺序处理
  const bySymbol = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  for (const [symbol, symbolTrades] of bySymbol) {
    // 按 timestamp 升序
    symbolTrades.sort((a, b) => a.timestamp - b.timestamp);

    // 简单栈：未配对的入场交易
    const entryStack: PaperTrade[] = [];

    for (const trade of symbolTrades) {
      if (trade.side === "buy" || trade.side === "short") {
        // 入场：仅当没有 pnl（非 DCA 再入场也一并收录）
        if (trade.pnl === undefined) {
          entryStack.push(trade);
        }
      } else if (trade.side === "sell" || trade.side === "cover") {
        // 出场：与最近未配对的入场配对
        const entry = entryStack.pop();
        if (!entry) continue;

        const side: "long" | "short" = entry.side === "buy" ? "long" : "short";
        // 倒算信号价格：
        //   buy:   execPrice = signalPrice + slippagePerUnit  → signalPrice = execPrice - slippagePerUnit
        //   short: execPrice = signalPrice - slippagePerUnit  → signalPrice = execPrice + slippagePerUnit
        const entrySlippagePerUnit = entry.quantity > 0 ? entry.slippage / entry.quantity : 0;

        results.push({
          symbol,
          side,
          entryTime: entry.timestamp,
          entryFillPrice: entry.price,
          entrySlippagePerUnit,
          quantity: entry.quantity,
        });
      }
    }
  }

  return results;
}

/**
 * 计算滑点百分比（%）。
 * signalPrice = fillPrice ∓ slippagePerUnit（多/空不同方向）
 */
function calcSlippagePct(
  side: "long" | "short",
  fillPrice: number,
  slippagePerUnit: number,
): number {
  if (fillPrice <= 0) return 0;
  const signalPrice =
    side === "long" ? fillPrice - slippagePerUnit : fillPrice + slippagePerUnit;
  if (signalPrice <= 0) return 0;
  return (Math.abs(fillPrice - signalPrice) / signalPrice) * 100;
}

/**
 * 从滑点倒算信号价格。
 */
function calcSignalPrice(
  side: "long" | "short",
  fillPrice: number,
  slippagePerUnit: number,
): number {
  return side === "long" ? fillPrice - slippagePerUnit : fillPrice + slippagePerUnit;
}

// ── 核心导出函数 ──────────────────────────────────────────

/**
 * 对比同一信号在不同场景下的执行结果，检测执行漂移。
 * 从各场景的 paper-{scenarioId}.json 的 closedTrades 中匹配同 symbol+entryTime 的交易对。
 */
export function detectDrift(paperScenarioId: string, liveScenarioId: string): DriftRecord[] {
  const paperTrades = reconstructClosedTrades(paperScenarioId);
  const liveTrades = reconstructClosedTrades(liveScenarioId);

  if (paperTrades.length === 0 || liveTrades.length === 0) return [];

  const records: DriftRecord[] = [];

  for (const paper of paperTrades) {
    // 在 live 中找同 symbol 且 entryTime 在容忍窗口内的记录
    const liveMatch = liveTrades.find(
      (lv) =>
        lv.symbol === paper.symbol &&
        lv.side === paper.side &&
        Math.abs(lv.entryTime - paper.entryTime) <= MATCH_WINDOW_MS,
    );

    if (!liveMatch) continue;

    const signalPrice = calcSignalPrice(
      paper.side,
      paper.entryFillPrice,
      paper.entrySlippagePerUnit,
    );
    const paperSlippage = calcSlippagePct(
      paper.side,
      paper.entryFillPrice,
      paper.entrySlippagePerUnit,
    );
    const liveSlippage = calcSlippagePct(
      liveMatch.side,
      liveMatch.entryFillPrice,
      liveMatch.entrySlippagePerUnit,
    );
    const driftPercent = Math.abs(paperSlippage - liveSlippage);

    records.push({
      symbol: paper.symbol,
      side: paper.side,
      signalTime: paper.entryTime,
      signalPrice,
      paperFillPrice: paper.entryFillPrice,
      liveFillPrice: liveMatch.entryFillPrice,
      paperSlippage,
      liveSlippage,
      driftPercent,
      scenarioPaper: paperScenarioId,
      scenarioLive: liveScenarioId,
    });
  }

  return records;
}

/**
 * 生成漂移报告摘要。
 * 包含：平均偏差、最大偏差、偏差 > 阈值的交易数量。
 */
export function summarizeDrift(
  records: DriftRecord[],
  threshold = DEFAULT_DRIFT_THRESHOLD,
): {
  totalPairs: number;
  avgDriftPercent: number;
  maxDriftPercent: number;
  driftExceedingThreshold: number; // 偏差 > threshold 的数量
  bySymbol: Record<string, { count: number; avgDrift: number }>;
} {
  if (records.length === 0) {
    return {
      totalPairs: 0,
      avgDriftPercent: 0,
      maxDriftPercent: 0,
      driftExceedingThreshold: 0,
      bySymbol: {},
    };
  }

  const totalPairs = records.length;
  const sumDrift = records.reduce((acc, r) => acc + r.driftPercent, 0);
  const avgDriftPercent = sumDrift / totalPairs;
  const maxDriftPercent = Math.max(...records.map((r) => r.driftPercent));
  const driftExceedingThreshold = records.filter((r) => r.driftPercent > threshold).length;

  // bySymbol 分组
  const symbolMap = new Map<string, { sum: number; count: number }>();
  for (const r of records) {
    const entry = symbolMap.get(r.symbol) ?? { sum: 0, count: 0 };
    entry.sum += r.driftPercent;
    entry.count += 1;
    symbolMap.set(r.symbol, entry);
  }

  const bySymbol: Record<string, { count: number; avgDrift: number }> = {};
  for (const [sym, { sum, count }] of symbolMap) {
    bySymbol[sym] = { count, avgDrift: sum / count };
  }

  return {
    totalPairs,
    avgDriftPercent,
    maxDriftPercent,
    driftExceedingThreshold,
    bySymbol,
  };
}

/**
 * 格式化漂移报告为可读文本。
 */
export function formatDriftReport(
  summary: ReturnType<typeof summarizeDrift>,
  threshold = DEFAULT_DRIFT_THRESHOLD,
): string {
  const lines: string[] = [
    "═══════════════════════════════════════",
    "   Paper vs Live 执行漂移报告",
    "═══════════════════════════════════════",
    `总匹配交易对:   ${summary.totalPairs}`,
    `平均漂移:       ${summary.avgDriftPercent.toFixed(4)} %`,
    `最大漂移:       ${summary.maxDriftPercent.toFixed(4)} %`,
    `漂移超 ${threshold}%:  ${summary.driftExceedingThreshold} 笔`,
    "───────────────────────────────────────",
  ];

  if (Object.keys(summary.bySymbol).length > 0) {
    lines.push("按品种统计:");
    for (const [symbol, { count, avgDrift }] of Object.entries(summary.bySymbol)) {
      lines.push(`  ${symbol.padEnd(12)} count=${count}  avgDrift=${avgDrift.toFixed(4)}%`);
    }
    lines.push("───────────────────────────────────────");
  }

  if (summary.totalPairs === 0) {
    lines.push("⚠️  无匹配交易对，无法计算漂移。");
  } else if (summary.driftExceedingThreshold === 0) {
    lines.push(`✅ 所有交易漂移均在 ${threshold}% 以内，执行质量良好。`);
  } else {
    lines.push(
      `⚠️  ${summary.driftExceedingThreshold} 笔交易漂移超过 ${threshold}%，建议检查执行配置。`,
    );
  }

  return lines.join("\n");
}

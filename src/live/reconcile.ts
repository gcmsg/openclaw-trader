/**
 * 持仓启动恢复（Position Reconciliation）
 *
 * 在 live-monitor.ts 启动时比较本地账户（paper-*.json）和
 * 交易所实际持仓（通过 API 获取），自动同步差异。
 *
 * ## 场景
 * 1. 服务器重启：本地持仓正确，交易所无订单 → 本地已记账，继续运行
 * 2. 手动平仓：交易所没有但本地有 → 发告警，本地需要同步
 * 3. 交易所有但本地没有：可能是人工干预 → 发告警，等待确认
 * 4. 数量差异 > 5%：价格波动或精度问题 → 告警
 *
 * ## 结果
 * - status: "ok" | "warning" | "critical"
 * - critical → 建议暂停 live 交易等待人工确认
 * - warning  → 记录日志，继续运行（差异在容忍范围内）
 */

import type { PaperAccount } from "../paper/account.js";

// ─── 类型 ──────────────────────────────────────────────

export interface ExchangePosition {
  symbol: string;
  side: "long" | "short";
  qty: number;       // 数量（base asset）
  avgPrice: number;  // 均价
}

export interface ReconcileDiscrepancy {
  symbol: string;
  issue: "missing_local" | "missing_exchange" | "qty_mismatch";
  localQty?: number;
  exchangeQty?: number;
  diffPct?: number;
  description: string;
}

export type ReconcileStatus = "ok" | "warning" | "critical";

export interface ReconcileResult {
  status: ReconcileStatus;
  discrepancies: ReconcileDiscrepancy[];
  message: string;
  autoSynced: string[]; // 自动同步的 symbol 列表
}

// ─── 核心比对逻辑 ─────────────────────────────────────

const QTY_TOLERANCE_PCT = 5; // 数量差异容忍度（5%）

/**
 * 比对本地账户持仓 vs 交易所持仓
 *
 * @param account          本地 paper account
 * @param exchangePositions 交易所当前持仓（由 executor.getPositions() 提供）
 * @param autoSyncMissing  是否自动将交易所有但本地没有的持仓同步到本地（默认 false）
 */
export function reconcilePositions(
  account: PaperAccount,
  exchangePositions: ExchangePosition[],
  autoSyncMissing = false
): ReconcileResult {
  const discrepancies: ReconcileDiscrepancy[] = [];
  const autoSynced: string[] = [];

  const localSymbols = new Set(Object.keys(account.positions));
  const exchangeMap = new Map<string, ExchangePosition>();
  for (const pos of exchangePositions) {
    exchangeMap.set(pos.symbol, pos);
  }

  // 检查本地有但交易所没有的
  for (const symbol of localSymbols) {
    if (!exchangeMap.has(symbol)) {
      const localQty = account.positions[symbol]?.quantity;
      discrepancies.push({
        symbol,
        issue: "missing_exchange",
        ...(localQty !== undefined ? { localQty } : {}),
        description: `本地持仓 ${symbol} 在交易所未找到（可能已平仓或人工干预）`,
      });
    }
  }

  // 检查交易所有但本地没有的
  for (const [symbol, exPos] of exchangeMap) {
    if (!localSymbols.has(symbol)) {
      discrepancies.push({
        symbol,
        issue: "missing_local",
        exchangeQty: exPos.qty,
        description: `交易所持仓 ${symbol} 在本地未记录（人工开仓或漏记）`,
      });
      if (autoSyncMissing) {
        // 自动同步：将交易所持仓写入本地账户记录
        // 注意：这里只记录，实际写入由调用方完成
        autoSynced.push(symbol);
      }
    }
  }

  // 检查数量差异
  for (const symbol of localSymbols) {
    const exPos = exchangeMap.get(symbol);
    if (!exPos) continue; // 已在上方处理

    const localQty = account.positions[symbol]?.quantity ?? 0;
    const exchangeQty = exPos.qty;

    if (localQty === 0 || exchangeQty === 0) continue;

    const diffPct = Math.abs(localQty - exchangeQty) / localQty * 100;
    if (diffPct > QTY_TOLERANCE_PCT) {
      discrepancies.push({
        symbol,
        issue: "qty_mismatch",
        localQty,
        exchangeQty,
        diffPct,
        description: `${symbol} 数量差异 ${diffPct.toFixed(1)}%（本地 ${localQty.toFixed(6)}，交易所 ${exchangeQty.toFixed(6)}）`,
      });
    }
  }

  // 判断严重度
  let status: ReconcileStatus = "ok";
  if (discrepancies.some((d) => d.issue === "qty_mismatch" && (d.diffPct ?? 0) > 10)) {
    status = "critical";
  } else if (discrepancies.length > 0) {
    status = "warning";
  }

  const message = discrepancies.length === 0
    ? "✅ 本地账户与交易所持仓一致"
    : `${status === "critical" ? "🚨" : "⚠️"} 发现 ${discrepancies.length} 处差异：${discrepancies.map((d) => d.description).join("；")}`;

  return { status, discrepancies, message, autoSynced };
}

/**
 * 格式化对账报告（用于日志和 Telegram 通知）
 */
export function formatReconcileReport(result: ReconcileResult): string {
  const lines: string[] = [
    `🔍 **持仓对账报告** [启动时]`,
    ``,
    result.message,
  ];

  if (result.discrepancies.length > 0) {
    lines.push(``, `**差异详情：**`);
    for (const d of result.discrepancies) {
      const icon = d.issue === "qty_mismatch" ? "📊" : d.issue === "missing_local" ? "🆕" : "❓";
      lines.push(`${icon} ${d.description}`);
    }
  }

  if (result.autoSynced.length > 0) {
    lines.push(``, `🔄 **自动同步**: ${result.autoSynced.join(", ")}`);
  }

  if (result.status === "critical") {
    lines.push(``, `⛔ **建议暂停实盘交易，手动确认后重启！**`);
  }

  return lines.join("\n");
}

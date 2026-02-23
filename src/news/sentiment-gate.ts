/**
 * 新闻情绪门控模块
 * 在技术信号触发后，读取最新新闻报告作为"二次过滤"
 * 决定：执行 / 减仓执行 / 跳过 / 警告
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Signal } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, "../../logs/news-report.json");

// 报告有效期：4 小时（超过则视为数据过旧）
const REPORT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type GateDecision =
  | { action: "execute"; positionRatio: number; reason: string }   // 正常执行
  | { action: "reduce"; positionRatio: number; reason: string }    // 减半仓执行
  | { action: "skip"; reason: string }                             // 跳过
  | { action: "warn"; positionRatio: number; reason: string };     // 执行但发出警告

export interface NewsReport {
  generatedAt: string;
  fearGreed: { value: number; label: string };
  globalMarket: { marketCapChangePercent24h: number };
  sentiment: "bullish" | "bearish" | "neutral";
  importantNews: Array<{ title: string }>;
  bigMovers: Array<{ symbol: string; priceChangePercent: number }>;
  fgAlert: boolean;
  fgDelta: number;
}

/** 加载最新新闻报告（没有则返回 null） */
export function loadNewsReport(): NewsReport | null {
  try {
    const raw = fs.readFileSync(REPORT_PATH, "utf-8");
    const report = JSON.parse(raw) as NewsReport;
    const age = Date.now() - new Date(report.generatedAt).getTime();
    if (age > REPORT_MAX_AGE_MS) return null; // 数据过旧
    return report;
  } catch {
    return null; // 文件不存在或解析失败
  }
}

/**
 * 根据新闻情绪决定信号如何处理
 *
 * 规则：
 * - 新闻与信号同向 → 正常执行
 * - 新闻中性       → 正常执行（技术面优先）
 * - 新闻与信号反向 → 减半仓位 + 警告
 * - 极度贪婪时买入 → 减半仓位（谨慎）
 * - 极度恐惧时卖出 → 提示可能是底部，仍执行但警告
 * - 大额新闻冲击   → 强制跳过，等待情绪稳定
 */
export function evaluateSentimentGate(
  signal: Signal,
  report: NewsReport | null,
  baseRatio: number
): GateDecision {
  // 没有报告 → 信任技术面，正常执行
  if (!report) {
    return { action: "execute", positionRatio: baseRatio, reason: "无情绪数据，依赖技术面" };
  }

  const { fearGreed, sentiment, importantNews, fgAlert } = report;
  const fg = fearGreed.value;

  // ── 极端市场情绪告警期：有 fgAlert 且变化方向与信号冲突 ──
  if (fgAlert) {
    if (signal.type === "buy" && report.fgDelta < 0) {
      return {
        action: "skip",
        reason: `恐惧贪婪指数急跌 ${report.fgDelta} 点，市场情绪急速恶化，跳过买入信号`,
      };
    }
    if (signal.type === "sell" && report.fgDelta > 0) {
      return {
        action: "warn",
        positionRatio: baseRatio * 0.5,
        reason: `恐惧贪婪指数急升 ${report.fgDelta} 点，可能短期见顶，减半卖出`,
      };
    }
  }

  // ── 重大新闻冲击（5条以上重要新闻）→ 谨慎处理 ──
  if (importantNews.length >= 5) {
    return {
      action: "reduce",
      positionRatio: baseRatio * 0.5,
      reason: `检测到 ${importantNews.length} 条重要新闻，市场不确定性高，减半仓位`,
    };
  }

  // ── 买入信号 × 情绪判断 ──
  if (signal.type === "buy") {
    // 极度贪婪时买入风险高
    if (fg > 80) {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `极度贪婪（FGI=${fg}），历史上往往是高点，减半仓位谨慎买入`,
      };
    }
    // 新闻情绪偏空，与买入信号冲突
    if (sentiment === "bearish") {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `新闻情绪偏空（${sentiment}），与买入信号冲突，减半仓位`,
      };
    }
    // 极度恐惧时买入是历史良机
    if (fg < 20) {
      return {
        action: "execute",
        positionRatio: baseRatio,
        reason: `极度恐惧（FGI=${fg}），历史底部区域，技术信号可信`,
      };
    }
    return { action: "execute", positionRatio: baseRatio, reason: `情绪中性/多头（FGI=${fg}）` };
  }

  // ── 卖出信号 × 情绪判断 ──
  if (signal.type === "sell") {
    // 极度恐惧时卖出 → 可能在底部，警告
    if (fg < 20) {
      return {
        action: "warn",
        positionRatio: baseRatio,
        reason: `极度恐惧（FGI=${fg}），可能是底部区域，卖出信号需谨慎确认`,
      };
    }
    // 新闻情绪偏多，与卖出信号冲突
    if (sentiment === "bullish") {
      return {
        action: "reduce",
        positionRatio: baseRatio * 0.5,
        reason: `新闻情绪偏多（${sentiment}），与卖出信号冲突，减半平仓`,
      };
    }
    return { action: "execute", positionRatio: baseRatio, reason: `情绪中性/空头（FGI=${fg}）` };
  }

  return { action: "execute", positionRatio: baseRatio, reason: "无冲突" };
}

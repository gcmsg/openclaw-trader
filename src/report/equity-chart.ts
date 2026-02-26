/**
 * 资金曲线图表生成器
 * 使用纯 SVG 模板生成图表（无 native canvas 依赖）。
 * 同时提供 ASCII 文本版本用于终端输出。
 */

import fs from "fs";
import path from "path";

/** 资金曲线数据点 */
export interface EquityPoint {
  timestamp: number;
  equity: number;
}

/**
 * 生成资金曲线 SVG 图片。
 * @param equityPoints 时间序列 [{ timestamp, equity }]
 * @param title 图表标题
 * @param outputPath 输出路径（.svg 扩展名）
 * @returns SVG 文件路径
 */
export async function generateEquityChart(
  equityPoints: Array<{ timestamp: number; equity: number }>,
  title: string,
  outputPath: string
): Promise<string> {
  if (equityPoints.length === 0) {
    // 无数据：生成空图表
    const svg = buildSvg([], title, 0, 0);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, svg, "utf-8");
    return outputPath;
  }

  const sorted = [...equityPoints].sort((a, b) => a.timestamp - b.timestamp);
  const equities = sorted.map((p) => p.equity);
  const minE = Math.min(...equities);
  const maxE = Math.max(...equities);

  const svg = buildSvg(sorted, title, minE, maxE);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, svg, "utf-8");
  return outputPath;
}

/** 生成 ASCII 文本图表（用于 Telegram 消息）*/
export function generateAsciiChart(
  equityPoints: Array<{ timestamp: number; equity: number }>,
  height = 10,
  width = 60
): string {
  if (equityPoints.length === 0) return "(no data)";

  const sorted = [...equityPoints].sort((a, b) => a.timestamp - b.timestamp);
  const values = sorted.map((p) => p.equity);

  // Downsample to fit width
  const sampled = downsample(values, width);
  return renderAscii(sampled, height);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function downsample(values: number[], targetLen: number): number[] {
  if (values.length <= targetLen) return values;
  const step = values.length / targetLen;
  const result: number[] = [];
  for (let i = 0; i < targetLen; i++) {
    const idx = Math.floor(i * step);
    const v = values[idx];
    if (v !== undefined) result.push(v);
  }
  return result;
}

function renderAscii(values: number[], height: number): string {
  if (values.length === 0) return "(no data)";

  const allVals = values as number[];
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const range = max - min || 1;

  const rows: string[][] = Array.from({ length: height }, () =>
    Array<string>(values.length).fill(" ")
  );

  for (let col = 0; col < values.length; col++) {
    const v = values[col] ?? min;
    const rowIdx = height - 1 - Math.round(((v - min) / range) * (height - 1));
    const safeRow = Math.max(0, Math.min(height - 1, rowIdx));
    const row = rows[safeRow];
    if (row !== undefined) row[col] = "·";
  }

  return rows.map((r) => r.join("")).join("\n");
}

function buildSvg(
  points: Array<{ timestamp: number; equity: number }>,
  title: string,
  minE: number,
  maxE: number
): string {
  const W = 800;
  const H = 300;
  const PAD = { top: 40, right: 30, bottom: 50, left: 80 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const range = maxE - minE || 1;

  const toX = (i: number, total: number) =>
    PAD.left + (total <= 1 ? chartW / 2 : (i / (total - 1)) * chartW);
  const toY = (e: number) =>
    PAD.top + chartH - ((e - minE) / range) * chartH;

  // Build polyline points
  const polylinePoints =
    points.length > 0
      ? points
          .map((p, i) => `${toX(i, points.length).toFixed(1)},${toY(p.equity).toFixed(1)}`)
          .join(" ")
      : "";

  // Color: green if last >= first, else red
  const firstEquity = points[0]?.equity ?? 0;
  const lastEquity = points[points.length - 1]?.equity ?? 0;
  const lineColor = lastEquity >= firstEquity ? "#22c55e" : "#ef4444";
  const fillColor = lastEquity >= firstEquity ? "#22c55e22" : "#ef444422";

  // Y-axis ticks (5 levels)
  const yTicks = 5;
  const yTickLines: string[] = [];
  const yTickLabels: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const val = minE + (range * i) / yTicks;
    const y = toY(val).toFixed(1);
    yTickLines.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`
    );
    yTickLabels.push(
      `<text x="${PAD.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#6b7280">${val.toFixed(0)}</text>`
    );
  }

  // X-axis labels
  const xLabels: string[] = [];
  if (points.length > 0) {
    const labelCount = Math.min(6, points.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1 || 1)) * (points.length - 1));
      const safeIdx = Math.min(idx, points.length - 1);
      const pt = points[safeIdx];
      if (pt === undefined) continue;
      const x = toX(safeIdx, points.length).toFixed(1);
      const label = new Date(pt.timestamp).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      });
      xLabels.push(
        `<text x="${x}" y="${H - PAD.bottom + 20}" text-anchor="middle" font-size="11" fill="#6b7280">${label}</text>`
      );
    }
  }

  // Fill path (area under chart)
  let fillPath = "";
  if (points.length > 1) {
    const firstX = toX(0, points.length).toFixed(1);
    const lastX = toX(points.length - 1, points.length).toFixed(1);
    const baseY = (PAD.top + chartH).toFixed(1);
    fillPath = `<path d="M ${firstX} ${baseY} L ${polylinePoints.split(" ").join(" L ")} L ${lastX} ${baseY} Z" fill="${fillColor}"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>

  <!-- Title -->
  <text x="${W / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#111827">${escapeXml(title)}</text>

  <!-- Grid lines -->
  ${yTickLines.join("\n  ")}

  <!-- Fill area -->
  ${fillPath}

  <!-- Data line -->
  ${
    points.length > 1
      ? `<polyline points="${polylinePoints}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
      : points.length === 1
        ? `<circle cx="${toX(0, 1).toFixed(1)}" cy="${toY(points[0]?.equity ?? 0).toFixed(1)}" r="4" fill="${lineColor}"/>`
        : ""
  }

  <!-- Y-axis labels -->
  ${yTickLabels.join("\n  ")}

  <!-- X-axis labels -->
  ${xLabels.join("\n  ")}

  <!-- Axes -->
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="#9ca3af" stroke-width="1.5"/>
  <line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="#9ca3af" stroke-width="1.5"/>
</svg>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

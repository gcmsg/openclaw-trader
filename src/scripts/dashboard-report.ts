/**
 * 静态 HTML Dashboard 生成器（CLI 入口脚本）
 *
 * 读取 paper 账户数据 → 生成 reports/dashboard.html
 * 包含：权益曲线、最大回撤、交易记录表、各币种统计
 *
 * 用法：npm run dashboard:report
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadAccount } from "../paper/account.js";
import { loadEnabledPaperRuntimes } from "../config/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../../reports");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "dashboard.html");

// ─────────────────────────────────────────────────────
// 数据提取
// ─────────────────────────────────────────────────────

interface EquityPoint {
  ts: number;          // Unix ms
  label: string;       // 日期标签
  equity: number;      // 净值（USDT）
  drawdown: number;    // 当前回撤（%）
}

interface TradeRow {
  id: string;
  ts: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  usdt: number;
  pnl: number | null;
  pnlPct: number | null;
}

interface SymbolStat {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

interface DashboardData {
  scenarioId: string;
  generatedAt: string;
  initialUsdt: number;
  currentEquity: number;
  totalReturn: number;   // %
  totalPnl: number;
  numTrades: number;
  numWins: number;
  winRate: number;
  maxDrawdown: number;   // %
  equityCurve: EquityPoint[];
  recentTrades: TradeRow[];
  symbolStats: SymbolStat[];
}

function buildDashboardData(scenarioId: string, initialUsdt: number): DashboardData {
  const account = loadAccount(initialUsdt, scenarioId);
  const trades = account.trades;

  // ── 权益曲线（逐笔重建）──
  const curve: EquityPoint[] = [];
  let equity = initialUsdt;
  let peak = initialUsdt;
  let maxDD = 0;

  // 起始点
  curve.push({
    ts: account.createdAt,
    label: new Date(account.createdAt).toLocaleDateString("zh-CN"),
    equity: initialUsdt,
    drawdown: 0,
  });

  for (const trade of trades) {
    const pnl = trade.pnl ?? 0;
    equity += pnl - trade.fee;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    curve.push({
      ts: trade.timestamp,
      label: new Date(trade.timestamp).toLocaleDateString("zh-CN"),
      equity: Math.max(0, equity),
      drawdown: dd,
    });
  }

  // ── 交易统计 ──
  const closedTrades = trades.filter((t) => t.pnl !== undefined);
  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const currentEquity = account.usdt; // approximation (no open positions priced)

  // ── 各币种统计 ──
  const symbolMap: Record<string, SymbolStat> = {};
  for (const t of closedTrades) {
    const sym = t.symbol;
    const s = symbolMap[sym] ?? { symbol: sym, trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0 };
    s.trades++;
    const pnl = t.pnl ?? 0;
    if (pnl > 0) s.wins++; else s.losses++;
    s.totalPnl += pnl;
    symbolMap[sym] = s;
  }
  const symbolStats = Object.values(symbolMap).map((s) => ({
    ...s,
    winRate: s.trades > 0 ? s.wins / s.trades : 0,
    avgPnl: s.trades > 0 ? s.totalPnl / s.trades : 0,
  })).sort((a, b) => b.totalPnl - a.totalPnl);

  // ── 最近 50 笔交易 ──
  const recentTrades: TradeRow[] = trades.slice(-50).reverse().map((t) => ({
    id: t.id,
    ts: new Date(t.timestamp).toLocaleString("zh-CN"),
    symbol: t.symbol,
    side: t.side,
    qty: t.quantity,
    price: t.price,
    usdt: t.usdtAmount,
    pnl: t.pnl ?? null,
    // PaperTrade.pnlPercent 存储为比例（0.038 = +3.8%），展示需 ×100
    pnlPct: t.pnlPercent != null ? t.pnlPercent * 100 : null,
  }));

  return {
    scenarioId,
    generatedAt: new Date().toLocaleString("zh-CN"),
    initialUsdt,
    currentEquity,
    totalReturn: initialUsdt > 0 ? ((currentEquity - initialUsdt) / initialUsdt) * 100 : 0,
    totalPnl,
    numTrades: closedTrades.length,
    numWins: wins.length,
    winRate,
    maxDrawdown: maxDD,
    equityCurve: curve,
    recentTrades,
    symbolStats,
  };
}

// ─────────────────────────────────────────────────────
// HTML 模板
// ─────────────────────────────────────────────────────

function generateHtml(datasets: DashboardData[]): string {
  const mainData = datasets[0];
  if (!mainData) return "<html><body>No data</body></html>";

  // 序列化 datasets 供 JS 使用（JSON.stringify 后嵌入 <script>）
  const dataJson = JSON.stringify(datasets);
  const genTime = new Date().toLocaleString("zh-CN");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>openclaw-trader — Paper Trading Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0f1117;
      --card: #1a1d27;
      --border: #2a2d3e;
      --text: #e0e0e0;
      --muted: #8890a4;
      --green: #22c55e;
      --red: #ef4444;
      --blue: #3b82f6;
      --yellow: #eab308;
      --accent: #6366f1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; padding: 20px; }
    h1 { font-size: 1.4rem; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 20px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    @media (max-width: 800px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .card-title { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .card-value { font-size: 1.6rem; font-weight: 700; }
    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .neutral { color: var(--text); }
    .chart-row { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; margin-bottom: 20px; }
    @media (max-width: 900px) { .chart-row { grid-template-columns: 1fr; } }
    .chart-wrap { position: relative; height: 260px; }
    canvas { max-height: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { color: var(--muted); font-weight: 500; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 0.78rem; text-transform: uppercase; }
    td { padding: 7px 10px; border-bottom: 1px solid #1e2130; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1e2130; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .badge-buy { background: rgba(34,197,94,0.15); color: var(--green); }
    .badge-sell { background: rgba(239,68,68,0.15); color: var(--red); }
    .badge-short { background: rgba(234,179,8,0.15); color: var(--yellow); }
    .badge-cover { background: rgba(59,130,246,0.15); color: var(--blue); }
    .scenario-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .tab { padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; border: 1px solid var(--border); background: var(--card); color: var(--muted); transition: all 0.15s; }
    .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
    .section-title { font-size: 0.95rem; font-weight: 600; margin-bottom: 10px; color: var(--text); display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .empty-msg { color: var(--muted); text-align: center; padding: 30px; font-size: 0.9rem; }
    .footer { margin-top: 20px; text-align: center; color: var(--muted); font-size: 0.78rem; }
  </style>
</head>
<body>
  <h1>📈 openclaw-trader Dashboard</h1>
  <p class="subtitle">Paper Trading — ${genTime} 生成 | Mia 🤖</p>

  <div class="scenario-tabs" id="tabs"></div>

  <!-- KPI 卡片 -->
  <div class="grid-4" id="kpi-cards"></div>

  <!-- 图表区 -->
  <div class="chart-row">
    <div class="card">
      <p class="section-title"><span class="dot"></span>权益曲线</p>
      <div class="chart-wrap"><canvas id="equity-chart"></canvas></div>
    </div>
    <div class="card">
      <p class="section-title"><span class="dot"></span>最大回撤</p>
      <div class="chart-wrap"><canvas id="dd-chart"></canvas></div>
    </div>
  </div>

  <!-- 各币种统计 -->
  <div class="card" style="margin-bottom:12px">
    <p class="section-title"><span class="dot"></span>各币种统计</p>
    <div id="symbol-stats-wrap"></div>
  </div>

  <!-- 最近交易 -->
  <div class="card" style="margin-bottom:12px">
    <p class="section-title"><span class="dot"></span>最近 50 笔交易</p>
    <div id="trades-wrap" style="overflow-x:auto"></div>
  </div>

  <div class="footer">openclaw-trader • paper mode • 数据仅供参考 • 所有操作需主人授权</div>

<script>
const datasets = ${dataJson};
let currentIdx = 0;
let equityChart = null;
let ddChart = null;

function fmt(n, d = 2) {
  return typeof n === 'number' ? n.toFixed(d) : '-';
}
function fmtPct(n) {
  if (n === null || n === undefined) return '-';
  const cls = n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
  return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + fmt(n) + '%</span>';
}
function fmtPnl(n) {
  if (n === null || n === undefined) return '-';
  const cls = n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
  return '<span class="' + cls + '">' + (n >= 0 ? '+' : '') + fmt(n) + '</span>';
}

// ── Tabs ────────────────────────────
function buildTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = datasets.map((d, i) =>
    '<div class="tab ' + (i === currentIdx ? 'active' : '') + '" onclick="switchTab(' + i + ')">' + d.scenarioId + '</div>'
  ).join('');
}

function switchTab(i) {
  currentIdx = i;
  buildTabs();
  render(datasets[i]);
}

// ── KPI Cards ────────────────────────
function buildKpi(d) {
  const el = document.getElementById('kpi-cards');
  const rClass = d.totalReturn >= 0 ? 'positive' : 'negative';
  const ddClass = d.maxDrawdown > 15 ? 'negative' : d.maxDrawdown > 5 ? 'neutral' : 'positive';
  const wClass = d.winRate >= 0.5 ? 'positive' : 'negative';
  el.innerHTML = [
    { label: '当前净值', val: '$' + fmt(d.currentEquity), cls: 'neutral' },
    { label: '总收益率', val: (d.totalReturn >= 0 ? '+' : '') + fmt(d.totalReturn) + '%', cls: rClass },
    { label: '已实现盈亏', val: (d.totalPnl >= 0 ? '+$' : '-$') + fmt(Math.abs(d.totalPnl)), cls: rClass },
    { label: '交易笔数', val: d.numTrades + ' 笔', cls: 'neutral' },
    { label: '胜率', val: fmt(d.winRate * 100) + '%', cls: wClass },
    { label: '盈利 / 亏损', val: d.numWins + ' / ' + (d.numTrades - d.numWins), cls: 'neutral' },
    { label: '最大回撤', val: fmt(d.maxDrawdown) + '%', cls: ddClass },
    { label: '初始资金', val: '$' + fmt(d.initialUsdt), cls: 'neutral' },
  ].map(k => '<div class="card"><div class="card-title">' + k.label + '</div><div class="card-value ' + k.cls + '">' + k.val + '</div></div>').join('');
}

// ── Charts ────────────────────────────
const CHART_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { display: false }, tooltip: { callbacks: {} } },
  scales: {
    x: { ticks: { color: '#8890a4', maxTicksLimit: 6, font: { size: 11 } }, grid: { color: '#1e2130' } },
    y: { ticks: { color: '#8890a4', font: { size: 11 } }, grid: { color: '#1e2130' } }
  }
};

function buildCharts(d) {
  const labels = d.equityCurve.map(p => p.label);
  const equities = d.equityCurve.map(p => p.equity);
  const drawdowns = d.equityCurve.map(p => -p.drawdown);

  if (equityChart) equityChart.destroy();
  if (ddChart) ddChart.destroy();

  equityChart = new Chart(document.getElementById('equity-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: equities,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: equities.length > 100 ? 0 : 3,
        borderWidth: 1.5
      }]
    },
    options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins, tooltip: { callbacks: {
      label: ctx => '$' + ctx.raw.toFixed(2)
    }}}}
  });

  ddChart = new Chart(document.getElementById('dd-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: drawdowns,
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: drawdowns.length > 100 ? 0 : 3,
        borderWidth: 1.5
      }]
    },
    options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins, tooltip: { callbacks: {
      label: ctx => ctx.raw.toFixed(2) + '%'
    }}}, scales: { ...CHART_OPTS.scales, y: { ...CHART_OPTS.scales.y, max: 0 }}}
  });
}

// ── Symbol Stats ────────────────────
function buildSymbolStats(d) {
  const wrap = document.getElementById('symbol-stats-wrap');
  if (!d.symbolStats.length) {
    wrap.innerHTML = '<div class="empty-msg">暂无交易记录</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>币种</th><th>交易数</th><th>胜率</th><th>总盈亏</th><th>均值盈亏</th>' +
    '</tr></thead><tbody>' +
    d.symbolStats.map(s => '<tr>' +
      '<td><strong>' + s.symbol.replace('USDT', '') + '</strong></td>' +
      '<td>' + s.trades + '</td>' +
      '<td>' + fmtPct(s.winRate * 100) + '</td>' +
      '<td>' + fmtPnl(s.totalPnl) + '</td>' +
      '<td>' + fmtPnl(s.avgPnl) + '</td>' +
    '</tr>').join('') +
    '</tbody></table>';
}

// ── Trades ────────────────────────────
function buildTrades(d) {
  const wrap = document.getElementById('trades-wrap');
  if (!d.recentTrades.length) {
    wrap.innerHTML = '<div class="empty-msg">暂无交易记录</div>';
    return;
  }
  const sideBadge = s => '<span class="badge badge-' + s + '">' + s.toUpperCase() + '</span>';
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>时间</th><th>币种</th><th>方向</th><th>数量</th><th>价格</th><th>金额(U)</th><th>盈亏</th><th>盈亏%</th>' +
    '</tr></thead><tbody>' +
    d.recentTrades.map(t => '<tr>' +
      '<td style="white-space:nowrap">' + t.ts + '</td>' +
      '<td><strong>' + t.symbol.replace('USDT', '') + '</strong></td>' +
      '<td>' + sideBadge(t.side) + '</td>' +
      '<td>' + fmt(t.qty, 4) + '</td>' +
      '<td>' + fmt(t.price, 2) + '</td>' +
      '<td>' + fmt(t.usdt, 2) + '</td>' +
      '<td>' + fmtPnl(t.pnl) + '</td>' +
      '<td>' + fmtPct(t.pnlPct) + '</td>' +
    '</tr>').join('') +
    '</tbody></table>';
}

// ── Main Render ──────────────────────
function render(d) {
  buildKpi(d);
  buildCharts(d);
  buildSymbolStats(d);
  buildTrades(d);
}

buildTabs();
render(datasets[currentIdx]);
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────

function main() {
  const configs = loadEnabledPaperRuntimes();

  const datasets: DashboardData[] = [];
  for (const cfg of configs) {
    try {
      const data = buildDashboardData(cfg.paper.scenarioId, cfg.paper.initial_usdt);
      datasets.push(data);
    } catch (e) {
      console.warn(`⚠️ 跳过场景 ${cfg.paper.scenarioId}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (datasets.length === 0) {
    // 创建空 dashboard（尚无交易记录时也能生成）
    datasets.push({
      scenarioId: "default",
      generatedAt: new Date().toLocaleString("zh-CN"),
      initialUsdt: 1000,
      currentEquity: 1000,
      totalReturn: 0,
      totalPnl: 0,
      numTrades: 0,
      numWins: 0,
      winRate: 0,
      maxDrawdown: 0,
      equityCurve: [{ ts: Date.now(), label: new Date().toLocaleDateString("zh-CN"), equity: 1000, drawdown: 0 }],
      recentTrades: [],
      symbolStats: [],
    });
  }

  const html = generateHtml(datasets);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, html, "utf-8");

  console.log(`✅ Dashboard 已生成：${OUTPUT_PATH}`);
  console.log(`   场景：${datasets.map((d) => d.scenarioId).join(", ")}`);
  console.log(`   总交易：${datasets.reduce((s, d) => s + d.numTrades, 0)} 笔`);
}

try {
  main();
} catch (e: unknown) {
  console.error("Dashboard 生成失败：", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

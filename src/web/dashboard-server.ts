/**
 * P6.8 — Web 实时仪表盘服务器
 *
 * 轻量级 HTTP 服务，实时展示持仓状态、资金曲线、信号历史。
 * 使用 Node.js 内置 http 模块，无需额外依赖。
 *
 * 端点：
 *   GET /           → HTML 仪表盘页面
 *   GET /api/data   → JSON (DashboardData)
 *   GET /api/health → JSON (系统健康)
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadAccount } from "../paper/account.js";
import { loadPaperConfig } from "../config/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─────────────────────────────────────────────────────
// Dashboard Types
// ─────────────────────────────────────────────────────

export interface AccountSummary {
  scenarioId: string;
  name: string;
  initialUsdt: number;
  usdt: number; // 可用现金
  totalEquity: number; // 总资产（含持仓市值）
  totalPnl: number; // 绝对盈亏
  totalPnlPercent: number; // 百分比盈亏
  tradeCount: number;
  winRate: number; // 0~1
  positionCount: number;
}

export interface PositionWithPnl {
  scenarioId: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number; // 以 entryPrice 代替（实时价格需另行获取）
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  stopLoss: number;
  takeProfit: number;
  stopLossDistance: number; // |currentPrice - stopLoss| / currentPrice (%)
  entryTime: number;
}

export interface TradeRecord {
  id: string;
  scenarioId: string;
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  quantity: number;
  price: number;
  usdtAmount: number;
  pnl: number | null;
  pnlPercent: number | null;
  timestamp: number;
  reason: string;
}

export interface EquityPoint {
  timestamp: number;
  equity: number; // USDT 净值
  label: string; // 日期时间标签
}

export interface SignalRecord {
  id: string;
  symbol: string;
  type: string;
  price: number;
  timestamp: number;
  status: string;
  pnl: number | null;
  pnlPercent: number | null;
}

export interface DashboardData {
  accounts: AccountSummary[]; // 所有场景的账户状态
  positions: PositionWithPnl[]; // 当前持仓（带 PnL）
  recentTrades: TradeRecord[]; // 最近 50 笔交易
  equityCurve: EquityPoint[]; // 资金曲线
  signalHistory: SignalRecord[]; // 最近信号记录
  lastUpdate: number;
}

// ─────────────────────────────────────────────────────
// Data Building
// ─────────────────────────────────────────────────────

/**
 * 从 paper 账户文件构建仪表盘数据。
 * 不依赖实时价格（使用入场价代替当前价，供仪表盘展示参考）。
 */
export function buildDashboardData(): DashboardData {
  const accounts: AccountSummary[] = [];
  const positions: PositionWithPnl[] = [];
  const allTrades: TradeRecord[] = [];

  // 加载所有 paper 场景
  let scenarios: { id: string; name: string; initial_usdt: number }[];
  try {
    const paperConfig = loadPaperConfig();
    scenarios = paperConfig.scenarios
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, name: s.name, initial_usdt: s.initial_usdt }));
  } catch {
    // 无 paper 配置时使用默认场景
    scenarios = [{ id: "default", name: "Default", initial_usdt: 1000 }];
  }

  for (const scenario of scenarios) {
    let account;
    try {
      account = loadAccount(scenario.initial_usdt, scenario.id);
    } catch {
      continue;
    }

    // 计算总资产（简化：用 entryPrice 作为当前价）
    let positionValue = 0;
    const positionList = Object.values(account.positions);
    for (const pos of positionList) {
      if (pos.side === "short") {
        positionValue += pos.marginUsdt ?? pos.quantity * pos.entryPrice;
      } else {
        positionValue += pos.quantity * pos.entryPrice;
      }
    }
    const totalEquity = account.usdt + positionValue;
    const totalPnl = totalEquity - account.initialUsdt;
    const totalPnlPercent = account.initialUsdt > 0 ? totalPnl / account.initialUsdt : 0;

    // 赢率
    const closedTrades = account.trades.filter(
      (t) => (t.side === "sell" || t.side === "cover") && t.pnl !== undefined
    );
    const winners = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate = closedTrades.length > 0 ? winners / closedTrades.length : 0;

    accounts.push({
      scenarioId: scenario.id,
      name: scenario.name,
      initialUsdt: account.initialUsdt,
      usdt: account.usdt,
      totalEquity,
      totalPnl,
      totalPnlPercent,
      tradeCount: account.trades.length,
      winRate,
      positionCount: positionList.length,
    });

    // 持仓列表
    for (const pos of positionList) {
      const side = pos.side ?? "long";
      const currentPrice = pos.entryPrice; // 静态展示使用入场价
      let unrealizedPnl: number;
      let costBasis = pos.quantity * pos.entryPrice;

      if (side === "short") {
        unrealizedPnl = (pos.entryPrice - currentPrice) * pos.quantity;
        costBasis = pos.marginUsdt ?? costBasis;
      } else {
        unrealizedPnl = (currentPrice - pos.entryPrice) * pos.quantity;
      }

      const unrealizedPnlPercent = costBasis > 0 ? unrealizedPnl / costBasis : 0;
      const stopLossDistance =
        currentPrice > 0 ? Math.abs(currentPrice - pos.stopLoss) / currentPrice : 0;

      positions.push({
        scenarioId: scenario.id,
        symbol: pos.symbol,
        side,
        quantity: pos.quantity,
        entryPrice: pos.entryPrice,
        currentPrice,
        unrealizedPnl,
        unrealizedPnlPercent,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        stopLossDistance,
        entryTime: pos.entryTime,
      });
    }

    // 交易记录
    for (const trade of account.trades) {
      allTrades.push({
        id: trade.id,
        scenarioId: scenario.id,
        symbol: trade.symbol,
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        usdtAmount: trade.usdtAmount,
        pnl: trade.pnl ?? null,
        pnlPercent: trade.pnlPercent ?? null,
        timestamp: trade.timestamp,
        reason: trade.reason,
      });
    }
  }

  // 最近 50 笔交易（全场景合并，按时间排序）
  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  const recentTrades = allTrades.slice(0, 50);

  // 资金曲线：从第一个 paper 账户重建
  const equityCurve = buildEquityCurve(accounts, allTrades);

  // 信号历史（从 signal-history.jsonl 读取）
  const signalHistory = loadSignalHistory(20);

  return {
    accounts,
    positions,
    recentTrades,
    equityCurve,
    signalHistory,
    lastUpdate: Date.now(),
  };
}

/**
 * 从账户初始资金 + 交易记录重建资金曲线。
 * 逻辑：按时间排序的交易记录，累计盈亏，加上初始资金。
 */
export function buildEquityCurve(
  accounts: AccountSummary[],
  trades: TradeRecord[]
): EquityPoint[] {
  if (accounts.length === 0) return [];

  // 使用第一个账户作为主曲线
  const mainAccount = accounts[0]!;
  let equity = mainAccount.initialUsdt;

  // 过滤出该账户的平仓交易（按时间升序）
  const closedTrades = trades
    .filter(
      (t) =>
        t.scenarioId === mainAccount.scenarioId &&
        (t.side === "sell" || t.side === "cover") &&
        t.pnl !== null
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const curve: EquityPoint[] = [
    {
      timestamp: mainAccount.initialUsdt > 0 ? Date.now() - 30 * 24 * 3600_000 : Date.now(),
      equity,
      label: formatDateLabel(Date.now() - 30 * 24 * 3600_000),
    },
  ];

  for (const trade of closedTrades) {
    equity += trade.pnl ?? 0;
    curve.push({
      timestamp: trade.timestamp,
      equity,
      label: formatDateLabel(trade.timestamp),
    });
  }

  // 加入当前总资产作为最终点
  curve.push({
    timestamp: Date.now(),
    equity: mainAccount.totalEquity,
    label: formatDateLabel(Date.now()),
  });

  // 去重（相同时间戳的点保留最后一个）
  const seen = new Map<number, EquityPoint>();
  for (const p of curve) {
    seen.set(p.timestamp, p);
  }
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function formatDateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** 从 signal-history.jsonl 加载最近 N 条信号记录 */
function loadSignalHistory(limit = 20): SignalRecord[] {
  const signalFile = path.join(LOGS_DIR, "signal-history.jsonl");
  try {
    const content = fs.readFileSync(signalFile, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            id?: string;
            symbol?: string;
            type?: string;
            entryPrice?: number;
            entryTime?: number;
            status?: string;
            pnl?: number;
            pnlPercent?: number;
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return lines
      .slice(-limit)
      .reverse()
      .map((r) => ({
        id: r?.id ?? "",
        symbol: r?.symbol ?? "",
        type: r?.type ?? "",
        price: r?.entryPrice ?? 0,
        timestamp: r?.entryTime ?? 0,
        status: r?.status ?? "",
        pnl: r?.pnl ?? null,
        pnlPercent: r?.pnlPercent ?? null,
      }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// HTML Page
// ─────────────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenClaw Trader Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1e293b; padding: 16px 24px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 1.4rem; font-weight: 700; color: #38bdf8; }
    .header .update-time { font-size: 0.8rem; color: #94a3b8; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card h2 { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .big-num { font-size: 2.2rem; font-weight: 700; }
    .sub-num { font-size: 0.9rem; color: #94a3b8; margin-top: 4px; }
    .pos { color: #34d399; }
    .neg { color: #f87171; }
    .neu { color: #e2e8f0; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
    .chart-container { position: relative; height: 260px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; padding: 10px 12px; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e293b; }
    tr:hover td { background: #0f172a22; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-buy { background: #064e3b; color: #34d399; }
    .badge-sell { background: #7f1d1d; color: #f87171; }
    .badge-short { background: #1e1b4b; color: #a5b4fc; }
    .badge-cover { background: #1c1917; color: #fbbf24; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    .loading { color: #94a3b8; text-align: center; padding: 40px; }
    .stat-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.875rem; }
    .stat-label { color: #94a3b8; }
    .no-data { color: #475569; text-align: center; padding: 24px; font-style: italic; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 OpenClaw Trader Dashboard</h1>
    <div class="update-time" id="update-time">Loading...</div>
  </div>
  <div class="container">
    <div class="summary-grid" id="accounts-grid">
      <div class="card"><div class="loading">Loading accounts...</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="section-title">📈 资金曲线 Equity Curve</div>
        <div class="chart-container">
          <canvas id="equity-chart"></canvas>
        </div>
      </div>
      <div class="card">
        <div class="section-title">💼 当前持仓 Positions</div>
        <div id="positions-table"><div class="loading">Loading...</div></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:24px">
      <div class="section-title">🔔 最近信号 Signal History</div>
      <div id="signal-table"><div class="loading">Loading...</div></div>
    </div>
    <div class="card">
      <div class="section-title">📋 最近交易 Recent Trades</div>
      <div id="trades-table"><div class="loading">Loading...</div></div>
    </div>
  </div>
  <script>
    let equityChart = null;

    function pct(v) {
      const sign = v >= 0 ? '+' : '';
      return sign + (v * 100).toFixed(2) + '%';
    }
    function colorClass(v) {
      return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu';
    }
    function fmtUsdt(v) {
      return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtTime(ts) {
      if (!ts) return '-';
      return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function renderAccounts(accounts) {
      const grid = document.getElementById('accounts-grid');
      if (!accounts || accounts.length === 0) {
        grid.innerHTML = '<div class="card"><div class="no-data">No account data</div></div>';
        return;
      }
      grid.innerHTML = accounts.map(a => {
        const pnlClass = colorClass(a.totalPnl);
        return \`
          <div class="card">
            <h2>\${a.name} (\${a.scenarioId})</h2>
            <div class="big-num \${pnlClass}">\${fmtUsdt(a.totalEquity)}</div>
            <div class="sub-num \${pnlClass}">\${pct(a.totalPnlPercent)} (\${a.totalPnl >= 0 ? '+' : ''}\${fmtUsdt(a.totalPnl)})</div>
            <div style="margin-top:16px">
              <div class="stat-row"><span class="stat-label">可用现金</span><span>\${fmtUsdt(a.usdt)}</span></div>
              <div class="stat-row"><span class="stat-label">当前持仓</span><span>\${a.positionCount} 个</span></div>
              <div class="stat-row"><span class="stat-label">总交易</span><span>\${a.tradeCount} 笔</span></div>
              <div class="stat-row"><span class="stat-label">胜率</span><span class="\${colorClass(a.winRate - 0.5)}">\${(a.winRate * 100).toFixed(1)}%</span></div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderPositions(positions) {
      const el = document.getElementById('positions-table');
      if (!positions || positions.length === 0) {
        el.innerHTML = '<div class="no-data">暂无持仓</div>';
        return;
      }
      el.innerHTML = \`<div style="overflow-x:auto"><table>
        <thead><tr><th>Symbol</th><th>Side</th><th>入场价</th><th>PnL%</th><th>止损距</th></tr></thead>
        <tbody>\${positions.map(p => {
          const pnlClass = colorClass(p.unrealizedPnlPercent);
          const sideClass = p.side === 'long' ? 'badge-buy' : 'badge-short';
          return \`<tr>
            <td><strong>\${p.symbol}</strong></td>
            <td><span class="badge \${sideClass}">\${p.side}</span></td>
            <td>\${p.entryPrice.toFixed(4)}</td>
            <td class="\${pnlClass}">\${pct(p.unrealizedPnlPercent)}</td>
            <td class="neg">\${pct(p.stopLossDistance)}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table></div>\`;
    }

    function renderSignals(signals) {
      const el = document.getElementById('signal-table');
      if (!signals || signals.length === 0) {
        el.innerHTML = '<div class="no-data">暂无信号记录</div>';
        return;
      }
      el.innerHTML = \`<div style="overflow-x:auto"><table>
        <thead><tr><th>时间</th><th>Symbol</th><th>Type</th><th>价格</th><th>状态</th><th>PnL%</th></tr></thead>
        <tbody>\${signals.map(s => {
          const typeClass = s.type === 'buy' ? 'badge-buy' : s.type === 'sell' ? 'badge-sell' : s.type === 'short' ? 'badge-short' : 'badge-cover';
          const pnlClass = s.pnlPercent != null ? colorClass(s.pnlPercent) : 'neu';
          return \`<tr>
            <td>\${fmtTime(s.timestamp)}</td>
            <td>\${s.symbol}</td>
            <td><span class="badge \${typeClass}">\${s.type}</span></td>
            <td>\${s.price > 0 ? s.price.toFixed(4) : '-'}</td>
            <td>\${s.status}</td>
            <td class="\${pnlClass}">\${s.pnlPercent != null ? pct(s.pnlPercent / 100) : '-'}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table></div>\`;
    }

    function renderTrades(trades) {
      const el = document.getElementById('trades-table');
      if (!trades || trades.length === 0) {
        el.innerHTML = '<div class="no-data">暂无交易记录</div>';
        return;
      }
      el.innerHTML = \`<div style="overflow-x:auto"><table>
        <thead><tr><th>时间</th><th>Symbol</th><th>Side</th><th>价格</th><th>金额</th><th>PnL</th><th>场景</th></tr></thead>
        <tbody>\${trades.slice(0, 20).map(t => {
          const badgeClass = 'badge-' + t.side;
          const pnlClass = t.pnl != null ? colorClass(t.pnl) : 'neu';
          return \`<tr>
            <td>\${fmtTime(t.timestamp)}</td>
            <td>\${t.symbol}</td>
            <td><span class="badge \${badgeClass}">\${t.side}</span></td>
            <td>\${t.price.toFixed(4)}</td>
            <td>\${fmtUsdt(t.usdtAmount)}</td>
            <td class="\${pnlClass}">\${t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmtUsdt(t.pnl) : '-'}</td>
            <td><small style="color:#94a3b8">\${t.scenarioId}</small></td>
          </tr>\`;
        }).join('')}</tbody>
      </table></div>\`;
    }

    function renderEquityCurve(curve) {
      const ctx = document.getElementById('equity-chart').getContext('2d');
      const labels = curve.map(p => p.label);
      const data = curve.map(p => p.equity);
      const colors = data.map((v, i) => i === 0 || v >= data[i - 1] ? '#34d399' : '#f87171');

      if (equityChart) equityChart.destroy();
      equityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Equity (USDT)',
            data,
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56,189,248,0.1)',
            borderWidth: 2,
            pointRadius: data.length < 20 ? 4 : 2,
            tension: 0.3,
            fill: true,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 11 } }, grid: { color: '#1e293b' } },
            y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#334155' } }
          }
        }
      });
    }

    async function fetchData() {
      try {
        const resp = await fetch('/api/data');
        if (!resp.ok) throw new Error('API error ' + resp.status);
        const data = await resp.json();

        renderAccounts(data.accounts);
        renderPositions(data.positions);
        renderSignals(data.signalHistory);
        renderTrades(data.recentTrades);
        if (data.equityCurve && data.equityCurve.length > 0) {
          renderEquityCurve(data.equityCurve);
        }

        const updateEl = document.getElementById('update-time');
        updateEl.textContent = '更新: ' + new Date(data.lastUpdate).toLocaleTimeString('zh-CN');
      } catch (err) {
        console.error('Fetch failed:', err);
      }
    }

    // 初始加载 + 每 10 秒刷新
    fetchData();
    setInterval(fetchData, 10000);
  </script>
</body>
</html>`;

// ─────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────

let server: http.Server | null = null;

/**
 * 启动仪表盘 HTTP 服务器。
 *
 * @param port - 监听端口，默认 8080
 */
export function startDashboardServer(port = 8080): void {
  if (server) {
    console.log("[dashboard] 服务器已在运行中");
    return;
  }

  server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return;
    }

    if (url === "/api/data") {
      try {
        const data = buildDashboardData();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    if (url === "/api/health") {
      const health = {
        status: "ok",
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(health));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`[dashboard] 🚀 仪表盘运行中: http://localhost:${port}`);
  });

  server.on("error", (err) => {
    console.error("[dashboard] 服务器错误:", err.message);
  });
}

/**
 * 停止仪表盘服务器。
 */
export function stopDashboardServer(): void {
  if (!server) return;
  server.close(() => {
    console.log("[dashboard] 服务器已停止");
  });
  server = null;
}

/**
 * Web Dashboard Server (Freqtrade-style GUI)
 *
 * API Endpoints:
 *   GET /               → HTML SPA (sidebar navigation)
 *   GET /api/data       → Account, positions, trade records, signal history
 *   GET /api/prices     → Binance real-time prices
 *   GET /api/perf       → Performance stats (by symbol / by date)
 *   GET /api/logs       → monitor.log tail lines
 *   GET /api/scenarios  → Scenario list
 *   GET /api/health     → Health check
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../logger.js";
import { loadAccount } from "../paper/account.js";
import { loadPaperConfig } from "../config/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const log = createLogger("dashboard");

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface AccountSummary {
  scenarioId: string;
  name: string;
  initialUsdt: number;
  usdt: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPercent: number;
  tradeCount: number;
  winRate: number;
  positionCount: number;
}

export interface PositionWithPnl {
  scenarioId: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  stopLoss: number;
  takeProfit: number;
  stopLossDistance: number;
  slPercent: number;
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
  equity: number;
  label: string;
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
  accounts: AccountSummary[];
  positions: PositionWithPnl[];
  recentTrades: TradeRecord[];
  equityCurve: EquityPoint[];
  signalHistory: SignalRecord[];
  lastUpdate: number;
}

export interface SymbolPerf {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

export interface DayPerf {
  date: string;
  pnl: number;
  trades: number;
}

export interface PerfData {
  bySymbol: SymbolPerf[];
  byDay: DayPerf[];
}

// ─────────────────────────────────────────────────────
// Data: Dashboard
// ─────────────────────────────────────────────────────

export function buildDashboardData(): DashboardData {
  const accounts: AccountSummary[] = [];
  const positions: PositionWithPnl[] = [];
  const allTrades: TradeRecord[] = [];

  let scenarios: { id: string; name: string; initial_usdt: number }[];
  try {
    const paperConfig = loadPaperConfig();
    scenarios = paperConfig.scenarios
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, name: s.name, initial_usdt: s.initial_usdt }));
  } catch {
    scenarios = [{ id: "default", name: "Default", initial_usdt: 1000 }];
  }

  for (const scenario of scenarios) {
    let account;
    try {
      account = loadAccount(scenario.initial_usdt, scenario.id);
    } catch {
      continue;
    }

    let positionValue = 0;
    const positionList = Object.values(account.positions);
    for (const pos of positionList) {
      positionValue +=
        pos.side === "short"
          ? (pos.marginUsdt ?? pos.quantity * pos.entryPrice)
          : pos.quantity * pos.entryPrice;
    }

    const totalEquity = account.usdt + positionValue;
    const totalPnl = totalEquity - account.initialUsdt;
    const totalPnlPercent = account.initialUsdt > 0 ? totalPnl / account.initialUsdt : 0;

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

    for (const pos of positionList) {
      const side = pos.side ?? "long";
      const currentPrice = pos.entryPrice;
      const costBasis =
        side === "short" ? (pos.marginUsdt ?? pos.quantity * pos.entryPrice) : pos.quantity * pos.entryPrice;
      const unrealizedPnl =
        side === "short"
          ? (pos.entryPrice - currentPrice) * pos.quantity
          : (currentPrice - pos.entryPrice) * pos.quantity;
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
        slPercent: stopLossDistance * 100,
        entryTime: pos.entryTime,
      });
    }

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
        // pnlPercent is stored as a ratio in PaperTrade (e.g. 0.038), convert to percentage (3.8) for frontend display
        pnlPercent: trade.pnlPercent != null ? trade.pnlPercent * 100 : null,
        timestamp: trade.timestamp,
        reason: trade.reason,
      });
    }
  }

  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  const recentTrades = allTrades.slice(0, 50);
  const equityCurve = buildEquityCurve(accounts, allTrades);
  const signalHistory = loadSignalHistory(50);

  return { accounts, positions, recentTrades, equityCurve, signalHistory, lastUpdate: Date.now() };
}

export function buildEquityCurve(accounts: AccountSummary[], trades: TradeRecord[]): EquityPoint[] {
  if (accounts.length === 0) return [];
  const mainAccount = accounts[0]!;
  let equity = mainAccount.initialUsdt;

  const closedTrades = trades
    .filter(
      (t) =>
        t.scenarioId === mainAccount.scenarioId &&
        (t.side === "sell" || t.side === "cover") &&
        t.pnl !== null
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  // Starting point: if there are trade records, start from 1 hour before the first trade; otherwise default to 7 days ago
  // (avoid chart showing dozens of days of blank lines when account was just created)
  const startTs =
    closedTrades.length > 0
      ? closedTrades[0]!.timestamp - 3_600_000
      : Date.now() - 7 * 24 * 3600_000;
  const curve: EquityPoint[] = [
    { timestamp: startTs, equity, label: fmtLabel(startTs) },
  ];

  for (const trade of closedTrades) {
    equity += trade.pnl ?? 0;
    curve.push({ timestamp: trade.timestamp, equity, label: fmtLabel(trade.timestamp) });
  }

  curve.push({ timestamp: Date.now(), equity: mainAccount.totalEquity, label: fmtLabel(Date.now()) });

  const seen = new Map<number, EquityPoint>();
  for (const p of curve) seen.set(p.timestamp, p);
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ─────────────────────────────────────────────────────
// Data: Performance
// ─────────────────────────────────────────────────────

export function buildPerfData(): PerfData {
  const allTrades: TradeRecord[] = [];

  let scenarios: { id: string; initial_usdt: number }[];
  try {
    const cfg = loadPaperConfig();
    scenarios = cfg.scenarios.filter((s) => s.enabled).map((s) => ({ id: s.id, initial_usdt: s.initial_usdt }));
  } catch {
    scenarios = [{ id: "default", initial_usdt: 1000 }];
  }

  for (const s of scenarios) {
    try {
      const acct = loadAccount(s.initial_usdt, s.id);
      for (const t of acct.trades) {
        allTrades.push({
          id: t.id,
          scenarioId: s.id,
          symbol: t.symbol,
          side: t.side,
          quantity: t.quantity,
          price: t.price,
          usdtAmount: t.usdtAmount,
          pnl: t.pnl ?? null,
          pnlPercent: t.pnlPercent != null ? t.pnlPercent * 100 : null,
          timestamp: t.timestamp,
          reason: t.reason,
        });
      }
    } catch {
      /* skip */
    }
  }

  const closed = allTrades.filter((t) => (t.side === "sell" || t.side === "cover") && t.pnl !== null);

  // by symbol
  const symMap = new Map<string, SymbolPerf>();
  for (const t of closed) {
    const pnl = t.pnl ?? 0;
    const s = symMap.get(t.symbol) ?? {
      symbol: t.symbol,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
    };
    s.trades++;
    if (pnl > 0) s.wins++;
    else s.losses++;
    s.totalPnl += pnl;
    symMap.set(t.symbol, s);
  }
  const bySymbol = Array.from(symMap.values()).map((s) => ({
    ...s,
    winRate: s.trades > 0 ? s.wins / s.trades : 0,
    avgPnl: s.trades > 0 ? s.totalPnl / s.trades : 0,
  })).sort((a, b) => b.totalPnl - a.totalPnl);

  // by day
  const dayMap = new Map<string, DayPerf>();
  for (const t of closed) {
    const d = new Date(t.timestamp);
    const key = `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
    const day = dayMap.get(key) ?? { date: key, pnl: 0, trades: 0 };
    day.pnl += t.pnl ?? 0;
    day.trades++;
    dayMap.set(key, day);
  }
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return { bySymbol, byDay };
}

// ─────────────────────────────────────────────────────
// Data: Prices (Binance)
// ─────────────────────────────────────────────────────

export function fetchBinancePrices(symbols: string[]): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    if (symbols.length === 0) {
      resolve({});
      return;
    }
    const results: Record<string, number> = {};
    let done = 0;
    const timeout = setTimeout(() => resolve(results), 5000);

    for (const sym of symbols) {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
      https
        .get(url, (res) => {
          let raw = "";
          res.on("data", (chunk: string) => (raw += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(raw) as { price?: string };
              if (parsed.price) results[sym] = parseFloat(parsed.price);
            } catch {
              /* ignore */
            }
            if (++done === symbols.length) {
              clearTimeout(timeout);
              resolve(results);
            }
          });
        })
        .on("error", () => {
          if (++done === symbols.length) {
            clearTimeout(timeout);
            resolve(results);
          }
        });
    }
  });
}

// ─────────────────────────────────────────────────────
// Data: Logs
// ─────────────────────────────────────────────────────

export function getLogLines(tail = 200): string[] {
  const logFile = path.join(LOGS_DIR, "monitor.log");
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-tail);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// Data: Signal History
// ─────────────────────────────────────────────────────

function loadSignalHistory(limit = 50): SignalRecord[] {
  const signalFile = path.join(LOGS_DIR, "signal-history.jsonl");
  try {
    const content = fs.readFileSync(signalFile, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return lines
      .slice(-limit)
      .reverse()
      .map((r) => ({
        id: String(r?.["id"] ?? ""),
        symbol: String(r?.["symbol"] ?? ""),
        type: String(r?.["type"] ?? ""),
        price: Number(r?.["entryPrice"] ?? 0),
        timestamp: Number(r?.["entryTime"] ?? 0),
        status: String(r?.["status"] ?? ""),
        pnl: r?.["pnl"] != null ? Number(r["pnl"]) : null,
        // pnlPercent in signal-history.jsonl is stored as a ratio (e.g. 0.038), convert to percentage (3.8) for frontend display
        pnlPercent: r?.["pnlPercent"] != null ? Number(r["pnlPercent"]) * 100 : null,
      }));
  } catch {
    return [];
  }
}

function fmtLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * Lightweight fetch of all currently held trading pair list, used by /api/prices
 * Avoids calling buildDashboardData() just to get symbols (which loads full account data)
 */
export function getActiveSymbols(): string[] {
  try {
    const cfg = loadPaperConfig();
    const syms = new Set<string>();
    for (const s of cfg.scenarios.filter((sc) => sc.enabled)) {
      try {
        const acct = loadAccount(s.initial_usdt, s.id);
        for (const sym of Object.keys(acct.positions)) syms.add(sym);
      } catch {
        /* skip failed scenarios */
      }
    }
    return Array.from(syms);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// HTML Page (Freqtrade-style SPA)
// ─────────────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OpenClaw Trader</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;
  --green:#34d399;--red:#f87171;--blue:#38bdf8;--yellow:#fbbf24;--purple:#a78bfa;
  --sidebar:220px;
}
body{display:flex;min-height:100vh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}

/* ── Sidebar ── */
#sidebar{
  width:var(--sidebar);min-width:var(--sidebar);background:#0d1526;border-right:1px solid var(--border);
  display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100
}
.sidebar-logo{padding:20px 16px 16px;border-bottom:1px solid var(--border)}
.sidebar-logo .title{font-size:1rem;font-weight:700;color:var(--blue);margin-top:4px}
.sidebar-logo .subtitle{font-size:0.72rem;color:var(--muted)}
.nav-links{list-style:none;padding:12px 0;flex:1}
.nav-links li{
  display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;
  color:var(--muted);border-left:3px solid transparent;transition:all .15s;font-size:0.875rem
}
.nav-links li:hover{background:rgba(56,189,248,.06);color:var(--text)}
.nav-links li.active{background:rgba(56,189,248,.1);color:var(--blue);border-left-color:var(--blue)}
.nav-links .icon{font-size:1rem;width:20px;text-align:center}
.sidebar-footer{padding:14px 16px;border-top:1px solid var(--border);font-size:0.75rem;color:var(--muted)}
.sidebar-footer .uptime{color:var(--green)}

/* ── Main ── */
#main{margin-left:var(--sidebar);flex:1;min-height:100vh;display:flex;flex-direction:column}
.topbar{
  background:#0d1526;border-bottom:1px solid var(--border);padding:12px 24px;
  display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50
}
.topbar-title{font-size:1rem;font-weight:600}
.topbar-right{display:flex;align-items:center;gap:12px}
.badge-status{padding:3px 10px;border-radius:12px;font-size:0.75rem;font-weight:600}
.badge-running{background:rgba(52,211,153,.15);color:var(--green)}
.badge-stopped{background:rgba(248,113,113,.15);color:var(--red)}
.refresh-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}
#content{flex:1;padding:24px;overflow-y:auto}
.page{display:none}.page.active{display:block}

/* ── Cards ── */
.card{background:var(--card);border-radius:10px;padding:20px;border:1px solid var(--border);margin-bottom:16px}
.card-title{font-size:0.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px}
.kpi-label{font-size:0.78rem;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.9rem;font-weight:700}
.kpi-sub{font-size:0.8rem;margin-top:4px}
.pos{color:var(--green)}.neg{color:var(--red)}.neu{color:var(--text)}.muted{color:var(--muted)}

/* ── Grid layouts ── */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.chart-wrap{position:relative;height:260px}
.chart-wrap-sm{position:relative;height:200px}

/* ── Positions cards (horizontal scroll) ── */
.pos-cards{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;margin-bottom:20px}
.pos-card{
  min-width:200px;background:var(--card);border:1px solid var(--border);border-radius:10px;
  padding:16px;flex-shrink:0
}
.pos-card .sym{font-size:1rem;font-weight:700;margin-bottom:4px}
.pos-card .side-badge{font-size:0.7rem;padding:1px 7px;border-radius:4px;font-weight:600}
.side-long{background:rgba(52,211,153,.15);color:var(--green)}
.side-short{background:rgba(247,113,113,.15);color:var(--red)}
.pos-card .metrics{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px}
.pos-card .metric-label{font-size:0.7rem;color:var(--muted)}
.pos-card .metric-val{font-size:0.85rem;font-weight:600}

/* ── Tables ── */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{padding:10px 12px;text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid rgba(51,65,85,.5);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(30,41,59,.6)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:600}
.badge-buy{background:rgba(52,211,153,.15);color:var(--green)}
.badge-sell{background:rgba(248,113,113,.15);color:var(--red)}
.badge-short{background:rgba(167,139,250,.15);color:var(--purple)}
.badge-cover{background:rgba(251,191,36,.15);color:var(--yellow)}
.no-data{color:var(--muted);text-align:center;padding:40px;font-style:italic}
.section-head{font-size:0.95rem;font-weight:600;margin-bottom:14px;color:var(--text)}

/* ── Scenario selector ── */
.scenario-select{background:var(--card);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:6px;font-size:0.85rem}

/* ── Logs ── */
#log-terminal{background:#0a0a0a;border-radius:8px;padding:16px;height:500px;overflow-y:auto;font-family:'Courier New',monospace;font-size:0.8rem;line-height:1.6}
.log-line{padding:1px 0}
.log-error{color:#f87171}.log-warn{color:#fbbf24}.log-info{color:#86efac}.log-default{color:#94a3b8}
.log-controls{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.log-controls label{display:flex;align-items:center;gap:6px;font-size:0.85rem;color:var(--muted);cursor:pointer}
.log-controls input[type=checkbox]{accent-color:var(--blue)}

/* ── Loading skeleton ── */
.skeleton{background:linear-gradient(90deg,#1e293b 25%,#243047 50%,#1e293b 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;height:20px;margin-bottom:8px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Mobile ── */
@media(max-width:768px){
  #sidebar{width:100%;height:auto;position:sticky;flex-direction:row;border-right:none;border-bottom:1px solid var(--border)}
  .sidebar-logo{display:none}
  .nav-links{display:flex;flex-direction:row;padding:0;overflow-x:auto}
  .nav-links li{padding:12px 14px;border-left:none;border-bottom:3px solid transparent;white-space:nowrap}
  .nav-links li.active{border-left:none;border-bottom-color:var(--blue)}
  .sidebar-footer{display:none}
  #main{margin-left:0}
  .kpi-grid{grid-template-columns:1fr 1fr}
  .grid-2{grid-template-columns:1fr}
}
</style>
</head>
<body>

<!-- Sidebar -->
<nav id="sidebar">
  <div class="sidebar-logo">
    <div style="font-size:1.4rem">🚀</div>
    <div class="title">OpenClaw Trader</div>
    <div class="subtitle">Paper Trading Dashboard</div>
  </div>
  <ul class="nav-links">
    <li class="active" onclick="switchPage('overview')"><span class="icon">📊</span>Overview</li>
    <li onclick="switchPage('positions')"><span class="icon">💼</span>Positions</li>
    <li onclick="switchPage('trades')"><span class="icon">📋</span>Trades</li>
    <li onclick="switchPage('performance')"><span class="icon">📈</span>Performance</li>
    <li onclick="switchPage('signals')"><span class="icon">🔔</span>Signals</li>
    <li onclick="switchPage('logs')"><span class="icon">📜</span>Logs</li>
  </ul>
  <div class="sidebar-footer">
    <div>Updated</div>
    <div class="uptime" id="update-time">--</div>
  </div>
</nav>

<!-- Main -->
<div id="main">
  <div class="topbar">
    <span class="topbar-title" id="page-title">Overview</span>
    <div class="topbar-right">
      <span class="badge-status badge-running" id="bot-status">● RUNNING</span>
      <button class="refresh-btn" onclick="manualRefresh()">↻ Refresh</button>
    </div>
  </div>
  <div id="content">

    <!-- Overview -->
    <div id="page-overview" class="page active">
      <div class="kpi-grid" id="kpi-grid">
        <div class="kpi-card"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>
        <div class="kpi-card"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>
        <div class="kpi-card"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>
        <div class="kpi-card"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>
      </div>
      <div class="pos-cards" id="pos-cards-overview"></div>
      <div class="card">
        <div class="section-head">📈 Equity Curve</div>
        <div class="chart-wrap"><canvas id="equity-chart"></canvas></div>
      </div>
    </div>

    <!-- Positions -->
    <div id="page-positions" class="page">
      <div class="card">
        <div class="section-head">💼 Current Positions</div>
        <div class="table-wrap" id="positions-table"><div class="skeleton"></div></div>
      </div>
    </div>

    <!-- Trades -->
    <div id="page-trades" class="page">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="section-head" style="margin:0">📋 Trade History</div>
          <select class="scenario-select" id="trades-scenario-filter" onchange="renderTradesPage()">
            <option value="">All Scenarios</option>
          </select>
        </div>
        <div class="table-wrap" id="trades-table"><div class="skeleton"></div></div>
        <div id="trades-summary" style="margin-top:14px;display:flex;gap:24px;font-size:0.85rem;color:var(--muted)"></div>
      </div>
    </div>

    <!-- Performance -->
    <div id="page-performance" class="page">
      <div class="grid-2">
        <div class="card">
          <div class="section-head">💰 Total PnL by Symbol</div>
          <div class="chart-wrap"><canvas id="perf-bar-chart"></canvas></div>
        </div>
        <div class="card">
          <div class="section-head">🏆 Performance by Symbol</div>
          <div class="table-wrap" id="perf-symbol-table"><div class="skeleton"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="section-head">📅 Daily PnL</div>
        <div class="chart-wrap-sm"><canvas id="perf-day-chart"></canvas></div>
      </div>
    </div>

    <!-- Signals -->
    <div id="page-signals" class="page">
      <div class="card">
        <div class="section-head">🔔 Signal History</div>
        <div class="table-wrap" id="signals-table"><div class="skeleton"></div></div>
      </div>
    </div>

    <!-- Logs -->
    <div id="page-logs" class="page">
      <div class="card">
        <div class="log-controls">
          <span class="section-head" style="margin:0">📜 monitor.log</span>
          <label><input type="checkbox" id="auto-scroll" checked> Auto Scroll</label>
          <span style="font-size:0.8rem;color:var(--muted)" id="log-count"></span>
        </div>
        <div id="log-terminal"></div>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /main -->

<script>
// ── State ──
var state = {
  data: null,
  prices: {},
  perf: null,
  currentPage: 'overview',
  refreshInterval: null,
  logInterval: null
};
var charts = {};

// ── Page switching ──
var PAGE_TITLES = {
  overview: 'Overview',
  positions: 'Positions',
  trades: 'Trades',
  performance: 'Performance',
  signals: 'Signals',
  logs: 'Logs'
};

function switchPage(name) {
  document.querySelectorAll('.page').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.nav-links li').forEach(function(el) { el.classList.remove('active'); });
  var page = document.getElementById('page-' + name);
  if (page) page.classList.add('active');
  var navItems = document.querySelectorAll('.nav-links li');
  var idx = ['overview','positions','trades','performance','signals','logs'].indexOf(name);
  if (navItems[idx]) navItems[idx].classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[name] || name;
  state.currentPage = name;

  // per-page actions
  if (name === 'performance') loadPerf();
  if (name === 'logs') { fetchLogs(); startLogRefresh(); } else stopLogRefresh();
  if (name === 'trades') populateScenarioFilter();
}

// ── Formatters ──
function fmt2(n) { return typeof n === 'number' ? n.toFixed(2) : '-'; }
function fmt4(n) { return typeof n === 'number' ? n.toFixed(4) : '-'; }
function fmtPct(n) {
  if (n == null) return '-';
  var cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu';
  return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + fmt2(n) + '%</span>';
}
function fmtPnl(n) {
  if (n == null) return '-';
  var cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu';
  return '<span class="' + cls + '">' + (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) + '</span>';
}
function fmtTime(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  return (d.getMonth()+1).toString().padStart(2,'0') + '/'
    + d.getDate().toString().padStart(2,'0') + ' '
    + d.getHours().toString().padStart(2,'0') + ':'
    + d.getMinutes().toString().padStart(2,'0');
}
function fmtDuration(ts) {
  if (!ts) return '-';
  var ms = Date.now() - ts;
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function fmtUsdt(n) { return '$' + (n || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

// ── KPI cards ──
function renderKpi() {
  var d = state.data;
  if (!d || !d.accounts || d.accounts.length === 0) return;
  var a = d.accounts[0];
  var eq = a.totalEquity;
  var pnl = a.totalPnl;
  var pnlPct = a.totalPnlPercent * 100;
  var pnlClass = pnl >= 0 ? 'pos' : 'neg';
  var wrClass = a.winRate >= 0.5 ? 'pos' : 'neg';

  var html = [
    kpiCard('Net Equity', fmtUsdt(eq), '<span class="' + pnlClass + '">' + (pnl>=0?'+':'') + fmtUsdt(pnl) + '</span>'),
    kpiCard('Total Return', '<span class="' + pnlClass + '">' + (pnlPct>=0?'+':'') + fmt2(pnlPct) + '%</span>', a.scenarioId),
    kpiCard('Positions', a.positionCount + ' open', a.tradeCount + ' total trades'),
    kpiCard('Win Rate', '<span class="' + wrClass + '">' + fmt2(a.winRate*100) + '%</span>', 'Initial ' + fmtUsdt(a.initialUsdt))
  ].join('');
  document.getElementById('kpi-grid').innerHTML = html;
}

function kpiCard(label, value, sub) {
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div>'
    + '<div class="kpi-value">' + value + '</div>'
    + '<div class="kpi-sub muted">' + sub + '</div></div>';
}

// ── Position overview cards ──
function renderPosCards() {
  var d = state.data;
  var wrap = document.getElementById('pos-cards-overview');
  if (!d || !d.positions || d.positions.length === 0) {
    wrap.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:8px 0">No open positions</div>';
    return;
  }
  wrap.innerHTML = d.positions.map(function(p) {
    var curPrice = state.prices[p.symbol] || p.entryPrice;
    var costBasis = p.entryPrice * p.quantity; // long/short notional value (approximately equals margin when fees are minimal)
    var upnl = p.side === 'short' ? (p.entryPrice - curPrice) * p.quantity : (curPrice - p.entryPrice) * p.quantity;
    var upnlPct = costBasis > 0 ? (upnl / costBasis * 100) : 0;
    var slDist = curPrice > 0 ? Math.abs(curPrice - p.stopLoss) / curPrice * 100 : 0;
    var pnlCls = upnl >= 0 ? 'pos' : 'neg';
    var sym = p.symbol.replace('USDT','');
    return '<div class="pos-card">'
      + '<div style="display:flex;align-items:center;justify-content:space-between">'
      + '<div class="sym">' + sym + '</div>'
      + '<span class="side-badge side-' + p.side + '">' + p.side.toUpperCase() + '</span>'
      + '</div>'
      + '<div class="metrics">'
      + '<div><div class="metric-label">UPnL</div><div class="metric-val ' + pnlCls + '">' + (upnl>=0?'+':'') + '$' + Math.abs(upnl).toFixed(2) + '</div></div>'
      + '<div><div class="metric-label">UPnL%</div><div class="metric-val ' + pnlCls + '">' + (upnlPct>=0?'+':'') + upnlPct.toFixed(2) + '%</div></div>'
      + '<div><div class="metric-label">SL Dist</div><div class="metric-val neg">' + slDist.toFixed(2) + '%</div></div>'
      + '<div><div class="metric-label">Held</div><div class="metric-val muted">' + fmtDuration(p.entryTime) + '</div></div>'
      + '</div></div>';
  }).join('');
}

// ── Equity chart ──
function renderEquityChart() {
  var d = state.data;
  if (!d || !d.equityCurve || d.equityCurve.length < 2) return;
  var labels = d.equityCurve.map(function(p) { return p.label; });
  var data = d.equityCurve.map(function(p) { return p.equity; });
  var ctx = document.getElementById('equity-chart').getContext('2d');
  if (charts.equity) charts.equity.destroy();
  charts.equity = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Equity (USDT)',
        data: data,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56,189,248,0.08)',
        borderWidth: 2,
        pointRadius: data.length < 30 ? 4 : 1,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 11 } }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#334155' } }
      }
    }
  });
}

// ── Positions page ──
function renderPositionsPage() {
  var d = state.data;
  var wrap = document.getElementById('positions-table');
  if (!d || !d.positions || d.positions.length === 0) {
    wrap.innerHTML = '<div class="no-data">No open positions</div>';
    return;
  }
  var rows = d.positions.map(function(p) {
    var cur = state.prices[p.symbol] || p.entryPrice;
    var upnl = p.side === 'short' ? (p.entryPrice - cur) * p.quantity : (cur - p.entryPrice) * p.quantity;
    var cost = p.entryPrice * p.quantity;
    var upnlPct = cost > 0 ? upnl / cost * 100 : 0;
    var slDist = cur > 0 ? Math.abs(cur - p.stopLoss) / cur * 100 : 0;
    return '<tr>'
      + '<td><strong>' + p.symbol.replace('USDT','') + '</strong></td>'
      + '<td><span class="badge badge-' + (p.side==='long'?'buy':'short') + '">' + p.side + '</span></td>'
      + '<td>' + fmt4(p.quantity) + '</td>'
      + '<td>' + fmt2(p.entryPrice) + '</td>'
      + '<td style="color:var(--blue)">' + fmt2(cur) + '</td>'
      + '<td>' + fmtPnl(upnl) + '</td>'
      + '<td>' + fmtPct(upnlPct) + '</td>'
      + '<td class="neg">' + fmt2(p.stopLoss) + '</td>'
      + '<td class="pos">' + fmt2(p.takeProfit) + '</td>'
      + '<td class="neg">' + slDist.toFixed(2) + '%</td>'
      + '<td class="muted">' + fmtDuration(p.entryTime) + '</td>'
      + '</tr>';
  }).join('');
  wrap.innerHTML = '<table><thead><tr>'
    + '<th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Current</th>'
    + '<th>UPnL</th><th>UPnL%</th><th>SL</th><th>TP</th><th>SL Dist</th><th>Duration</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Trades page ──
function populateScenarioFilter() {
  var d = state.data;
  if (!d) return;
  var sel = document.getElementById('trades-scenario-filter');
  var existing = Array.from(sel.options).map(function(o) { return o.value; });
  var ids = {};
  (d.recentTrades || []).forEach(function(t) { ids[t.scenarioId] = 1; });
  Object.keys(ids).forEach(function(id) {
    if (existing.indexOf(id) < 0) {
      var opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      sel.appendChild(opt);
    }
  });
}

function renderTradesPage() {
  var d = state.data;
  var wrap = document.getElementById('trades-table');
  var sumEl = document.getElementById('trades-summary');
  if (!d || !d.recentTrades || d.recentTrades.length === 0) {
    wrap.innerHTML = '<div class="no-data">No trade records</div>';
    sumEl.innerHTML = '';
    return;
  }
  var filter = document.getElementById('trades-scenario-filter').value;
  var trades = filter ? d.recentTrades.filter(function(t) { return t.scenarioId === filter; }) : d.recentTrades;
  var rows = trades.map(function(t) {
    return '<tr>'
      + '<td>' + fmtTime(t.timestamp) + '</td>'
      + '<td><strong>' + t.symbol.replace('USDT','') + '</strong></td>'
      + '<td><span class="badge badge-' + t.side + '">' + t.side.toUpperCase() + '</span></td>'
      + '<td>' + fmt2(t.price) + '</td>'
      + '<td>' + fmtUsdt(t.usdtAmount) + '</td>'
      + '<td>' + fmtPnl(t.pnl) + '</td>'
      + '<td>' + (t.pnlPercent != null ? fmtPct(t.pnlPercent) : '-') + '</td>'
      + '<td style="color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis" title="' + (t.reason||'') + '">' + (t.reason||'-').substring(0,30) + '</td>'
      + '<td><small class="muted">' + t.scenarioId + '</small></td>'
      + '</tr>';
  }).join('');
  wrap.innerHTML = '<table><thead><tr>'
    + '<th>Time</th><th>Symbol</th><th>Side</th><th>Price</th><th>Amount</th>'
    + '<th>PnL</th><th>PnL%</th><th>Reason</th><th>Scenario</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';

  var closedTrades = trades.filter(function(t) { return t.pnl != null; });
  var totalPnl = closedTrades.reduce(function(s, t) { return s + (t.pnl||0); }, 0);
  var cls = totalPnl >= 0 ? 'pos' : 'neg';
  sumEl.innerHTML = '<span>Total <strong>' + trades.length + '</strong> trades</span>'
    + ' <span>Closed <strong>' + closedTrades.length + '</strong></span>'
    + ' <span>Total PnL <strong class="' + cls + '">' + (totalPnl>=0?'+':'') + '$' + Math.abs(totalPnl).toFixed(2) + '</strong></span>';
}

// ── Performance page ──
function loadPerf() {
  fetch('/api/perf').then(function(r) { return r.json(); }).then(function(perf) {
    state.perf = perf;
    renderPerfPage();
  }).catch(function(e) { console.error('perf fetch failed', e); });
}

function renderPerfPage() {
  var perf = state.perf;
  if (!perf) { document.getElementById('perf-symbol-table').innerHTML = '<div class="skeleton"></div>'; return; }

  // Bar chart
  var byS = perf.bySymbol || [];
  var ctx1 = document.getElementById('perf-bar-chart').getContext('2d');
  if (charts.perfBar) charts.perfBar.destroy();
  charts.perfBar = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: byS.map(function(s) { return s.symbol.replace('USDT',''); }),
      datasets: [{
        label: 'Total PnL (USDT)',
        data: byS.map(function(s) { return s.totalPnl; }),
        backgroundColor: byS.map(function(s) { return s.totalPnl >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)'; }),
        borderColor: byS.map(function(s) { return s.totalPnl >= 0 ? '#34d399' : '#f87171'; }),
        borderWidth: 1
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#334155' } }
      }
    }
  });

  // Symbol table
  var tbl = byS.map(function(s) {
    var wrCls = s.winRate >= 0.5 ? 'pos' : 'neg';
    return '<tr>'
      + '<td><strong>' + s.symbol.replace('USDT','') + '</strong></td>'
      + '<td>' + s.trades + '</td>'
      + '<td class="pos">' + s.wins + '</td>'
      + '<td class="neg">' + s.losses + '</td>'
      + '<td>' + fmtPct(s.winRate * 100) + '</td>'
      + '<td>' + fmtPnl(s.totalPnl) + '</td>'
      + '<td>' + fmtPnl(s.avgPnl) + '</td>'
      + '</tr>';
  }).join('');
  document.getElementById('perf-symbol-table').innerHTML = tbl.length
    ? '<table><thead><tr><th>Symbol</th><th>Total</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Total PnL</th><th>Avg</th></tr></thead><tbody>' + tbl + '</tbody></table>'
    : '<div class="no-data">No data available</div>';

  // Day chart
  var byD = perf.byDay || [];
  var ctx2 = document.getElementById('perf-day-chart').getContext('2d');
  if (charts.perfDay) charts.perfDay.destroy();
  charts.perfDay = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: byD.map(function(d) { return d.date; }),
      datasets: [{
        label: 'Daily PnL',
        data: byD.map(function(d) { return d.pnl; }),
        backgroundColor: byD.map(function(d) { return d.pnl >= 0 ? 'rgba(52,211,153,0.6)' : 'rgba(248,113,113,0.6)'; }),
        borderColor: byD.map(function(d) { return d.pnl >= 0 ? '#34d399' : '#f87171'; }),
        borderWidth: 1
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: '#334155' } }
      }
    }
  });
}

// ── Signals page ──
function renderSignalsPage() {
  var d = state.data;
  var wrap = document.getElementById('signals-table');
  if (!d || !d.signalHistory || d.signalHistory.length === 0) {
    wrap.innerHTML = '<div class="no-data">No signal records</div>';
    return;
  }
  var rows = d.signalHistory.map(function(s) {
    var typeClass = s.type === 'buy' ? 'buy' : s.type === 'sell' ? 'sell' : s.type === 'short' ? 'short' : 'cover';
    return '<tr>'
      + '<td>' + fmtTime(s.timestamp) + '</td>'
      + '<td><strong>' + (s.symbol||'').replace('USDT','') + '</strong></td>'
      + '<td><span class="badge badge-' + typeClass + '">' + (s.type||'-').toUpperCase() + '</span></td>'
      + '<td>' + fmt4(s.price) + '</td>'
      + '<td><small class="muted">' + (s.status||'-') + '</small></td>'
      + '<td>' + (s.pnlPercent != null ? fmtPct(s.pnlPercent) : '-') + '</td>'
      + '</tr>';
  }).join('');
  wrap.innerHTML = '<table><thead><tr><th>Time</th><th>Symbol</th><th>Type</th><th>Entry Price</th><th>Status</th><th>PnL%</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
}

// ── Logs page ──
function startLogRefresh() {
  stopLogRefresh();
  state.logInterval = setInterval(fetchLogs, 5000);
}
function stopLogRefresh() {
  if (state.logInterval) { clearInterval(state.logInterval); state.logInterval = null; }
}
function fetchLogs() {
  fetch('/api/logs?tail=200').then(function(r) { return r.json(); }).then(function(res) {
    renderLogs(res.lines || []);
  }).catch(function(e) { console.warn("[dashboard] fetchLogs failed:", e); });
}
function renderLogs(lines) {
  var term = document.getElementById('log-terminal');
  var autoScroll = document.getElementById('auto-scroll').checked;
  document.getElementById('log-count').textContent = lines.length + ' lines';
  term.innerHTML = lines.map(function(line) {
    var cls = 'log-default';
    var l = line.toLowerCase();
    if (l.indexOf('error') >= 0 || l.indexOf('err]') >= 0) cls = 'log-error';
    else if (l.indexOf('warn') >= 0) cls = 'log-warn';
    else if (l.indexOf('info') >= 0 || l.indexOf('signal') >= 0 || l.indexOf('buy') >= 0 || l.indexOf('sell') >= 0) cls = 'log-info';
    return '<div class="log-line ' + cls + '">' + escHtml(line) + '</div>';
  }).join('');
  if (autoScroll) term.scrollTop = term.scrollHeight;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Data fetching ──
function fetchAll() {
  return Promise.all([
    fetch('/api/data').then(function(r) { return r.json(); }),
    fetch('/api/prices').then(function(r) { return r.json(); })
  ]).then(function(results) {
    state.data = results[0];
    state.prices = results[1] || {};
    var t = new Date(state.data.lastUpdate || Date.now());
    document.getElementById('update-time').textContent =
      t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0') + ':' + t.getSeconds().toString().padStart(2,'0');
    renderAll();
  }).catch(function(e) { console.error('fetch failed', e); });
}

function renderAll() {
  renderKpi();
  renderPosCards();
  renderEquityChart();
  if (state.currentPage === 'positions') renderPositionsPage();
  if (state.currentPage === 'trades') { populateScenarioFilter(); renderTradesPage(); }
  if (state.currentPage === 'signals') renderSignalsPage();
}

function manualRefresh() {
  fetchAll();
  if (state.currentPage === 'performance') loadPerf();
  if (state.currentPage === 'logs') fetchLogs();
}

// ── Init ──
fetchAll();
state.refreshInterval = setInterval(fetchAll, 10000);
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────

let server: http.Server | null = null;

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, msg: string, status = 500): void {
  sendJson(res, { error: msg }, status);
}

export function startDashboardServer(port = 8080): void {
  if (server) {
    log.info("Server is already running");
    return;
  }

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "GET") {
      res.writeHead(405); res.end("Method Not Allowed"); return;
    }

    // ── Routes ──
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return;
    }

    if (pathname === "/api/data") {
      try {
        sendJson(res, buildDashboardData());
      } catch (e) {
        sendError(res, e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (pathname === "/api/prices") {
      // Lightweight fetch of current position trading pairs, batch fetch Binance real-time prices
      const symbols = getActiveSymbols();
      if (symbols.length === 0) {
        sendJson(res, {}); return;
      }
      fetchBinancePrices(symbols)
        .then((prices) => sendJson(res, prices))
        .catch(() => sendJson(res, {}));
      return;
    }

    if (pathname === "/api/perf") {
      try {
        sendJson(res, buildPerfData());
      } catch (e) {
        sendError(res, e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (pathname === "/api/logs") {
      const tail = parseInt(url.searchParams.get("tail") ?? "200", 10) || 200;
      try {
        const lines = getLogLines(tail);
        sendJson(res, { lines, file: "monitor.log", tail });
      } catch (e) {
        sendError(res, e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (pathname === "/api/scenarios") {
      try {
        const cfg = loadPaperConfig();
        const scenarios = cfg.scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          initial_usdt: s.initial_usdt,
        }));
        sendJson(res, scenarios);
      } catch (e) {
        sendError(res, e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (pathname === "/api/health") {
      sendJson(res, {
        status: "ok",
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version,
      });
      return;
    }

    res.writeHead(404); res.end("Not Found");
  });

  // Security: bind to localhost only, prevent external access (no authentication)
  server.listen(port, "127.0.0.1", () => {
    log.info(`🚀 Dashboard running at: http://localhost:${port}`);
    log.info("   Pages: Overview / Positions / Trades / Performance / Signals / Logs");
    log.info(`   ⚠️  Localhost only. For remote access use SSH tunnel: ssh -L ${port}:localhost:${port} user@server`);
  });

  server.on("error", (err) => {
    log.error(`Server error: ${err.message}`);
  });
}

export function stopDashboardServer(): void {
  if (!server) return;
  server.close(() => { log.info("Server stopped"); });
  server = null;
}

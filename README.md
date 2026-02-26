# openclaw-trader

> AI-powered crypto trading bot built on [OpenClaw](https://openclaw.ai)

[🇨🇳 中文文档](./README_CN.md)

---

## Features

- 📊 **Technical Analysis** — EMA (20/60) + RSI Wilder (14) + MACD (12/26/9) + ATR + VWAP (daily, ±1σ/±2σ bands) + CVD
- ⚙️ **Config-driven Strategy** — Edit `config/strategy.yaml`, no code changes needed
- 🗞️ **News & Sentiment** — Fear & Greed + LLM semantic scoring + keyword gate + 6h cache
- 🚨 **Emergency Monitor** — Every 10 min: scan 30 critical keywords (hack/SEC/depeg); auto-halt open signals for 2h
- 🎭 **Paper Trading Mode** — Simulates trades with real prices; tracks P&L, win rate, positions, Calmar ratio
- 🔬 **Backtesting Engine** — Historical data; Sharpe / Sortino / Calmar / max drawdown / BTC benchmark alpha; `--slippage-sweep`
- 📉 **Short / Bearish Engine** — Open short + cover; inverted SL/TP/trailing stop; ATR-based position sizing
- 🏦 **Binance Testnet & Live** — Spot + Futures Testnet fully verified; one-way mode
- 🔔 **AI-triggered Signals** — Zero token cost when idle; only wakes the AI agent on signal detection
- 🛡️ **Risk Management** — Stop-loss · take-profit · trailing stop · staged TP · time-stop · daily loss limit · total drawdown pause · R:R pre-filter
- 🏁 **Regime Filter** — Classifies market as trending / sideways / breakout_watch / reduced_size; skips or halves position accordingly
- 🔄 **Regime-Adaptive Parameters** (P5.2) — Auto-switch TP / SL / ROI Table per regime via `regime_overrides` config block
- 💥 **Liquidation Heatmap** (P5.3) — Binance Futures public API (`/fapi/v1/allForceOrders`); BTC + ETH long/short squeeze summary per analysis run
- 🗣️ **Reddit Sentiment** (P5.4) — Reddit public JSON API (no auth); r/CryptoCurrency + r/Bitcoin; keyword sentiment + top posts per analysis run
- 📐 **ATR Dynamic Sizing** — Normalize per-trade risk using ATR volatility
- 🎯 **Kelly Position Sizing** — Dynamic position size from rolling win-rate and R:R; half-Kelly mode; fallback to fixed when sample < 10
- 🔗 **Correlation Filter** — Portfolio heat map; Pearson > 0.75 → continuous position reduction (not binary block)
- 💹 **Funding Rate Signals** — `funding_rate_overlong` / `funding_rate_overshort` reversal signals with 10-min cache
- 📈 **BTC Dominance Tracker** — 30-day history; `btc_dominance_rising` / `btc_dominance_falling` signals
- ⏱️ **ROI Table** (F1) — Time-decayed take-profit targets (Freqtrade `minimal_roi` design); consistent across paper / live / backtest
- 🛡️ **Entry Slippage Guard** (F4) — Pre-order price check; cancels entry if drift from signal price exceeds `max_entry_slippage`
- 📋 **Order State Machine** (F2/F5) — `PendingOrder` lifecycle tracking; partial-fill detection; orphan order scan on startup
- 📡 **WebSocket Monitor** — Real-time kline stream with < 1s signal latency; CVD WebSocket framework
- 🪙 **Multi-symbol** — BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX
- 🧪 **Multi-strategy Scenarios** — Long-only / short-only / bidirectional in parallel
- 📊 **Signal Attribution** — `npm run attribution`: rank signal combinations by win-rate, R:R, avg hold time
- 🩺 **Watchdog** — Every 5 min: alert if `price_monitor` hasn't run within 3 min; 30-min cooldown
- 🗂️ **Log Rotation** — Daily: archive logs > 20 MB / 24h; keep 30 days; clean old paper backups
- 🔄 **Position Reconciliation** — On live-monitor startup: diff local account vs exchange; halt if > 10% mismatch
- 🔄 **Auto Walk-Forward** (P6.6) — Periodic re-optimization scheduler; `npm run auto-wf`
- 🔌 **Strategy Plugin System** (F4) — Pluggable strategies: default (YAML), rsi-reversal, breakout; custom plugin in ~20 lines
- 📊 **Strategy State Store** (P7.4) — Cross-candle persistence for strategy plugins; consecutive-loss protection in rsi-reversal
- 🛡️ **Exchange-Native Stop Loss** (P7.1) — `STOP_LOSS_LIMIT` placed on Binance after fill; survives bot crash
- ⚡ **Force Exit** (P7.2) — Market-order emergency close after 3 exit-order timeouts
- 💬 **Telegram Commands** (P7.3) — `/profit`, `/positions`, `/balance`, `/status`, `/forcesell BTCUSDT`, `/help`
- 🏠 **Break-Even Stop** (P8.1) — Auto-move SL to entry+offset after profit threshold; `customStoploss()` strategy hook
- ✅ **Exit Confirmation** (P8.2) — Flash-crash protection: reject abnormal exits; `confirmExit()` strategy hook
- 🛡️ **Protection Manager** (G1) — CooldownPeriod / MaxDrawdown / StoplossGuard / LowProfitPairs (Freqtrade design)
- 📦 **DataProvider Cache** (G2) — Centralized kline cache with 30s TTL; pre-fetch all pairs per cycle
- 🔄 **Enhanced Trailing Stop** (G4) — `trailing_stop_positive` / `trailing_stop_positive_offset` / `only_offset_is_reached`
- 💾 **SQLite Persistence** (G5) — Optional `better-sqlite3` trade history; `paper.use_sqlite: true`
- ✅ **Tested** — 1040 unit tests across indicators, signals, VWAP, CVD, ROI table, Kelly, attribution, watchdog, reconcile, liquidation heatmap, Reddit sentiment

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Every 1 min   src/monitor.ts                            │
│  → Fetch klines → VWAP/CVD/Indicators → Detect signal   │
│  → Regime filter → R:R check → Correlation → Kelly size  │
│  → Emergency halt? → Sentiment gate → Execute / notify   │
├──────────────────────────────────────────────────────────┤
│  Every 5 min   src/health/watchdog.ts                    │
│  → Check price_monitor last ping; alert if > 3 min      │
├──────────────────────────────────────────────────────────┤
│  Every 10 min  src/news/emergency-monitor.ts             │
│  → Scan latest news for 30 critical keywords             │
│  → Trigger: halt open signals 2h + Telegram alert       │
├──────────────────────────────────────────────────────────┤
│  Every 4 hrs   src/news/monitor.ts                       │
│  → Fear & Greed + headlines + sentiment → report.json    │
├──────────────────────────────────────────────────────────┤
│  Every 30 min  src/health/checker.ts                     │
│  → Health check all cron tasks; alert on failure         │
├──────────────────────────────────────────────────────────┤
│  Daily 00:00   src/health/log-rotate.ts                  │
│  → Archive logs > 20 MB / 24h; delete > 30d archives    │
│  → Delete paper backup files > 7 days                    │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in your API keys

# Edit strategy (no restart needed)
vim config/strategy.yaml

# Single run (test)
npm run monitor

# View paper trading account
npm run paper:status

# Run tests
npm test
```

## Environment Variables

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Binance API key (read + spot trade, no withdrawal) |
| `BINANCE_SECRET_KEY` | Binance API secret |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw gateway token for AI agent notifications |
| `OPENCLAW_GATEWAY_PORT` | Gateway port (default: `18789`) |

## Cron Setup

```bash
# Price monitor — every 1 minute
* * * * *  cd /path/to/openclaw-trader && source .env && npx tsx src/monitor.ts >> logs/monitor.log 2>&1

# News collector — every 4 hours
0 */4 * * *  cd /path/to/openclaw-trader && source .env && npx tsx src/news/monitor.ts >> logs/news-monitor.log 2>&1
```

## Backtesting

Test any strategy against historical data before running it live:

```bash
# Backtest default strategy (90 days)
npm run backtest

# Backtest a specific strategy
npm run backtest -- --strategy conservative --days 90
npm run backtest -- --strategy aggressive --days 60

# Custom symbols and timeframe
npm run backtest -- --strategy trend --symbols BTCUSDT,ETHUSDT,SOLUSDT --timeframe 4h --days 180

# Compare all strategies side-by-side
npm run backtest:compare -- --days 90
```

**Backtest output includes:**
- Total return % and USDT
- Max drawdown, Sharpe ratio, Sortino ratio
- Win rate, profit factor, average win/loss ratio
- Exit reason breakdown (signal / stop-loss / take-profit / trailing stop)
- Per-symbol performance table
- JSON report saved to `logs/backtest/`

> ⚠️ Past performance does not guarantee future results. Always validate in paper mode before going live.

## Hyperopt — Bayesian Parameter Optimization

Automatically find the best strategy parameters using Bayesian optimization (TPE + Elite Evolution):

```bash
# Run 100 optimization trials on BTCUSDT (last 60 days)
npm run hyperopt -- --symbol BTCUSDT --trials 100

# Longer history for more robust results
npm run hyperopt -- --symbol BTCUSDT --trials 200 --days 90

# With walk-forward validation (70% train / 30% test)
npm run hyperopt -- --symbol BTCUSDT --trials 100 --walk-forward

# Reproducible run with fixed seed
npm run hyperopt -- --symbol BTCUSDT --trials 100 --seed 42
```

**How it works:**
1. **Warm-up phase** (first 20 trials): random sampling across the 8-dimensional parameter space
2. **Optimization phase**: TPE with Gaussian KDE + elite perturbation selects candidates that maximize EI
3. **Objective**: `score = sharpe_ratio - 0.5 × max_drawdown%` (higher is better)
4. **Constraint**: `ma_short < ma_long` is always enforced (violated configs return score=-999)

**Optimized parameters:**
| Parameter | Range | Description |
|-----------|-------|-------------|
| `ma_short` | 5–50 | Short MA period |
| `ma_long` | 20–200 | Long MA period |
| `rsi_period` | 7–21 | RSI lookback |
| `rsi_overbought` | 60–80 | RSI sell threshold |
| `rsi_oversold` | 20–40 | RSI buy threshold |
| `stop_loss_pct` | 2–10% | Stop loss |
| `take_profit_pct` | 5–30% | Take profit |
| `position_ratio` | 10–40% | Position size |

**Output:**
- Best parameters with copy-paste YAML snippet for `config/strategy.yaml`
- Backtest metrics for best config (Sharpe, drawdown, win rate, etc.)
- Walk-forward validation (degradation % between train/test)
- Full trial history saved to `logs/hyperopt-results.json`

## Strategy Configuration

Edit `config/strategy.yaml`:

```yaml
mode: "paper"         # notify_only | paper | auto

strategy:
  ma:
    short: 20         # Short-term MA period
    long: 60          # Long-term MA period
  rsi:
    oversold: 35      # Buy signal threshold
    overbought: 65    # Sell signal threshold

risk:
  stop_loss_percent: 5        # Stop loss per trade
  max_total_loss_percent: 20  # Pause strategy at 20% total loss
  position_ratio: 0.2         # 20% of equity per trade

paper:
  initial_usdt: 1000          # Simulated starting capital
```

## Buy / Sell Logic

All signal conditions are defined in `config/strategy.yaml` under `signals.buy / sell / short / cover`. Mix and match freely.

**Available signal checkers (signals.ts)**:

| Category | Condition | Description |
|---|---|---|
| **MA** | `ma_bullish` / `ma_bearish` | EMA short > / < long (trend direction) |
| **MA cross** | `ma_crossover` / `ma_crossunder` | EMA cross this bar (entry timing) |
| **RSI** | `rsi_bullish` / `rsi_bearish` | RSI below oversold / above overbought |
| **RSI** | `rsi_bullish_zone` / `rsi_not_overbought` | Mid-range zone filters |
| **RSI exit** | `rsi_overbought_exit` | RSI > `overbought_exit` (default 75) — momentum fade |
| **MACD** | `macd_bullish` / `macd_bearish` | MACD line vs signal line |
| **MACD exit** | `macd_histogram_shrinking` | 3 consecutive bars shrinking — momentum fade exit |
| **Volume** | `volume_surge` / `volume_low` | Volume vs 20-period average |
| **CVD** | `cvd_bullish` / `cvd_bearish` | 20-bar net buy/sell pressure (kline approximation) |
| **VWAP** | `price_above_vwap` / `price_below_vwap` | Price vs daily VWAP |
| **VWAP** | `vwap_bounce` / `vwap_breakdown` | Cross through VWAP (institutional level) |
| **VWAP** | `price_above_vwap_upper2` / `price_below_vwap_lower2` | ±2σ overbought/oversold |
| **Funding** | `funding_rate_overlong` / `funding_rate_overshort` | Crowded long/short reversal (default ±0.30% / ±0.15%) |
| **Dominance** | `btc_dominance_rising` / `btc_dominance_falling` | 7-day BTC dominance trend (altcoin risk signal) |

> **Short engine**: single-direction (no hedge mode). Longs and shorts share the `max_positions` pool.  
> `marketSell` = open short · `marketBuyByQty` = cover short

## Strategy Plugin System (F4)

Beyond YAML condition matching, you can write **code-based strategy plugins** for complex or ML-driven logic.

**Built-in plugins:**

| ID | Name | Description |
|---|---|---|
| `default` | YAML Condition Match | Reads `signals.buy/sell/short/cover` from YAML (existing behavior) |
| `rsi-reversal` | RSI Mean Reversion | RSI < 30 → buy (oversold); RSI > 70 → sell (overbought). Best for ranging markets. |
| `breakout` | Trend Breakout | Close > N-bar high + volume × 1.5x → buy; close < N-bar low → sell. Best for trending markets. |

**How to use a plugin** — set `strategy_id` in a strategy profile YAML:

```yaml
# config/strategies/my-strategy.yaml
name: "RSI Reversal Strategy"
strategy_id: "rsi-reversal"   # ← selects the plugin
rsi:
  oversold: 30
  overbought: 70
```

**How to create a custom plugin** (TypeScript, ~20 lines):

```typescript
// src/strategies/my-plugin.ts
import type { Strategy, StrategyContext } from "./types.js";
import { registerStrategy } from "./registry.js";

const myStrategy: Strategy = {
  id: "my-plugin",
  name: "My Custom Strategy",
  description: "Example plugin",
  populateSignal(ctx: StrategyContext) {
    const { indicators } = ctx;
    if (indicators.rsi < 25 && indicators.maShort > indicators.maLong) return "buy";
    if (indicators.rsi > 75) return "sell";
    return "none";
  },
};

registerStrategy(myStrategy);
export { myStrategy };
```

Then add it to `src/strategies/index.ts`:
```typescript
import "./my-plugin.js";   // triggers registration
```

**List all registered strategies:**
```bash
npm run strategies
```

## Telegram Commands (P7.3)

Interactive commands via Telegram or CLI:

```bash
# Run a command directly
npm run cmd -- "/profit"
npm run cmd -- "/positions"
npm run cmd -- "/forcesell BTCUSDT testnet-default"
```

| Command | Description |
|---------|-------------|
| `/profit` | Show P&L summary for all scenarios |
| `/positions` | List all open positions |
| `/balance` | Show USDT balance per scenario |
| `/status` | System status (uptime, health) |
| `/forcesell SYMBOL [scenario]` | Force-close a position |
| `/help` | List available commands |

## Project Structure

```
src/
├── monitor.ts              Polling monitor (cron, 1-min); injects VWAP/CVD/funding/dominance
├── types.ts                Global TypeScript types (Indicators, RiskConfig, StrategyConfig…)
├── exchange/
│   ├── binance-client.ts   Binance REST (Spot + Futures, live + testnet)
│   ├── binance.ts          Public kline + price fetch (no auth)
│   ├── ws.ts               WebSocket kline stream manager (closed-candle callbacks)
│   ├── order-flow.ts       CVD: CvdManager (aggTrade stream) + file cache
│   ├── futures-data.ts     Funding rate + OI (Binance public API)
│   ├── macro-data.ts       DXY / SPX / VIX via FRED API
│   ├── derivatives-data.ts Options skew, L/S ratio, basis
│   ├── onchain-data.ts     On-chain metrics (stablecoin flow, miner activity)
│   ├── pairlist.ts         Dynamic pairlist (volume/volatility filter)
│   └── options-data.ts     Options OI + put/call ratio
├── strategy/
│   ├── indicators.ts       EMA / RSI Wilder / MACD / ATR / VWAP / CVD
│   ├── signals.ts          All signal checkers (20+ conditions)
│   ├── correlation.ts      Pearson correlation filter (portfolio heat)
│   ├── regime.ts           Market regime classifier (trend/sideways/breakout)
│   ├── rr-filter.ts        Risk:Reward pre-trade filter
│   ├── kelly.ts            Kelly position sizing (half-Kelly, fallback)
│   ├── portfolio-risk.ts   Portfolio exposure + correlation-adjusted sizing
│   ├── market-context.ts   Multi-timeframe context (1h/4h/1d + pivot points)
│   ├── btc-dominance.ts    BTC dominance 30-day history + trend signals
│   ├── funding-rate-signal.ts  Funding rate extreme signals + 10-min cache
│   ├── break-even.ts       Break-even stop + customStoploss resolver
│   ├── confirm-exit.ts     Exit confirmation + flash-crash protection
│   ├── roi-table.ts        ROI Table time-decayed take-profit
│   ├── protection-manager.ts  4 Freqtrade protections
│   └── events-calendar.ts  Economic event risk gate
├── strategies/             Strategy plugin directory
│   ├── types.ts            Strategy interface + hooks
│   ├── registry.ts         Plugin registry
│   ├── state-store.ts      Cross-candle state persistence
│   ├── default.ts          YAML condition match (existing behavior)
│   ├── rsi-reversal.ts     RSI mean reversion plugin
│   └── breakout.ts         Trend breakout plugin
├── paper/
│   ├── account.ts          Virtual account (long + short, P&L, DCA state)
│   ├── engine.ts           Signal handler + all exit conditions
│   └── status.ts           CLI account status viewer
├── backtest/
│   ├── fetcher.ts          Historical K-line fetcher (paginated + cached)
│   ├── metrics.ts          Sharpe / Sortino / Calmar / drawdown / BTC alpha
│   ├── runner.ts           Multi-symbol engine (regime + R:R + correlation)
│   └── report.ts           Console output + JSON report
├── live/
│   ├── executor.ts         Live/testnet order execution
│   └── reconcile.ts        Startup position reconciliation (local vs exchange)
├── news/
│   ├── fetcher.ts          Fear & Greed + CryptoCompare headlines
│   ├── monitor.ts          Full news scan (4h cron)
│   ├── emergency-monitor.ts  Critical keyword scan (10-min cron); halt open signals
│   ├── sentiment-gate.ts   Keyword scoring gate + sentiment cache integration
│   ├── sentiment-cache.ts  LLM sentiment persistence (6h TTL)
│   ├── llm-sentiment.ts    OpenClaw Gateway LLM analysis
│   └── digest.ts           News digest formatter
├── health/
│   ├── heartbeat.ts        Task ping/status tracking (logs/heartbeat.json)
│   ├── checker.ts          Health check cron (30-min); alert on failure
│   ├── watchdog.ts         Price-monitor liveness check (5-min); 30-min cooldown
│   ├── log-rotate.ts       Daily log archival + paper backup cleanup
│   └── kill-switch.ts      Circuit breaker (halt trading on trigger)
├── telegram/
│   └── command-handler.ts  Telegram command parser + handler (/profit, /forcesell…)
├── optimization/           Hyperopt + Walk-Forward optimization
├── persistence/
│   └── db.ts               SQLite persistence layer (better-sqlite3)
├── web/
│   └── dashboard-server.ts Web dashboard server (Node http, no extra deps)
├── config/
│   └── loader.ts           Runtime config loader (merges strategy profiles)
├── notify/
│   └── openclaw.ts         OpenClaw agent notifications (system event)
├── report/
│   ├── weekly.ts           Weekly performance report
│   └── dashboard.ts        HTML dashboard with equity curve (npm run dashboard)
└── scripts/
    ├── backtest.ts         Backtest CLI (--slippage-sweep, --compare)
    ├── market-analysis.ts  On-demand market analysis (npm run analysis)
    ├── signal-attribution.ts  Signal attribution report (npm run attribution)
    ├── live-monitor.ts     Testnet/live monitor (npm run live)
    ├── ws-monitor.ts       WebSocket realtime monitor
    ├── sync-cron.ts        Cron sync utility (npm run cron:sync)
    └── test-futures.ts     Futures testnet connectivity test
config/
├── strategy.yaml           Global strategy + all schedule tasks
├── paper.yaml              Paper / testnet trading scenarios
└── strategies/             Named strategy profiles (default/aggressive/trend/rsi…)
logs/
├── news-report.json        Latest market sentiment report
├── paper-{scenario}.json   Per-scenario paper trading accounts
├── heartbeat.json          Task heartbeat timestamps
├── btc-dominance-history.json  30-day BTC dominance records
├── funding-rate-cache.json     Funding rate 10-min cache
├── cvd-state.json              CVD WebSocket state
├── news-emergency.json         Emergency halt state
├── backtest/               Backtest JSON reports
├── archive/                Rotated log files (30-day retention)
└── kline-cache/            Cached historical K-line data
```

## Schedule Configuration

All scheduled tasks are defined in `config/strategy.yaml` under `schedule:`.
After editing, run `npm run cron:sync` to apply changes to system crontab.

```yaml
schedule:
  price_monitor:
    enabled: true
    cron: "* * * * *"       # Every minute — signal detection
    timeout_minutes: 3

  news_emergency:
    enabled: true
    cron: "*/10 * * * *"    # Every 10 min — critical keyword scan
    timeout_minutes: 5

  watchdog:
    enabled: true
    cron: "*/5 * * * *"     # Every 5 min — monitor liveness check
    timeout_minutes: 10

  news_collector:
    enabled: true
    cron: "0 */4 * * *"     # Every 4 hours — full sentiment report
    timeout_minutes: 260

  health_check:
    enabled: true
    cron: "*/30 * * * *"    # Every 30 min — task health check
    timeout_minutes: 35

  log_rotate:
    enabled: true
    cron: "0 0 * * *"       # Daily midnight — log archival + cleanup
    timeout_minutes: 10
```

## Health Monitoring

```bash
# Manual health check
npm run health:check

# Sync cron from config
npm run cron:sync

# List current cron jobs
npm run cron:list
```

Health status levels:
- ✅ `ok` — Task ran within expected interval
- ⚠️ `warn` — Task overdue (not run within `timeout_minutes`)
- ❌ `error` — Last run failed with error
- 🔘 `never` — Task has never run (normal after fresh deploy)

Alerts are sent to Telegram only when issues are detected (silent when healthy).

## Dynamic Pairlist (P6.2)

Automatically selects the best trading pairs from Binance daily, replacing the fixed 8-symbol list:

```bash
# Manually refresh the dynamic pairlist
npm run pairlist:refresh

# Runs automatically via cron at midnight (configured in config/strategy.yaml)
npm run cron:sync
```

**Filtering logic:**
1. Calls `GET https://api.binance.com/api/v3/ticker/24hr` (free, no API key)
2. Filters: USDT-quoted only + no stablecoins (USDC/BUSD/DAI/TUSD bases) + no leveraged tokens (UP/DOWN/BEAR/BULL)
3. Filters by 24h volume ≥ 50M USDT (configurable)
4. Sorts by volume / volatility / momentum (configurable)
5. Takes top 15 pairs; whitelist always included, blacklist always excluded

When changes are detected, a Telegram notification lists added/removed pairs and updates `logs/current-pairlist.json`.

## Web Real-Time Dashboard (P6.8)

Lightweight web interface to monitor positions, equity curve, and signal history in real time:

```bash
# Start the dashboard server (default port 8080)
npm run dashboard

# Custom port via environment variable
DASHBOARD_PORT=3000 npm run dashboard
```

**API endpoints:**
- `GET /` — HTML dashboard page (auto-refreshes every 10 seconds)
- `GET /api/data` — JSON data (accounts, positions, trades, equity curve, signals)
- `GET /api/health` — System health (uptime, memory, Node.js version)

**Dashboard features:**
- Total assets + today's P&L (large display)
- Position table: symbol / entry price / PnL% / stop-loss distance
- Equity curve chart (Chart.js, from initial balance to now)
- Recent 20 trades table
- Recent 20 signal history records

## Roadmap

**Phase 0 — Critical Fixes** ✅
- [x] Regime filter (breakout_watch / reduced_size) in monitor + backtest
- [x] Momentum-fade exit: `macd_histogram_shrinking` + `rsi_overbought_exit`
- [x] Backtest config fix: realistic slippage + `--slippage-sweep`
- [x] BTC Benchmark + Calmar ratio + Alpha in backtest reports

**Phase 1 — Core Alpha** ✅
- [x] R:R pre-filter (`risk.min_rr`, opt-in)
- [x] CVD (kline approximation + aggTrade WebSocket framework)
- [x] Correlation filter enabled by default (threshold 0.75)
- [x] Funding rate reversal signals (10-min cache)

**Phase 2 — Risk & Attribution** ✅
- [x] VWAP (daily, ±1σ/±2σ) + 6 signal conditions
- [x] BTC dominance 30-day tracker + trend signals
- [x] Signal attribution report (`npm run attribution`)
- [x] Kelly position sizing (half-Kelly, fallback to fixed)

**Phase 3 — Ops Hardening** ✅
- [x] Watchdog: alert if `price_monitor` silent > 3 min
- [x] Log rotation: daily archive, 30-day retention
- [x] Position reconciliation on live-monitor startup
- [x] Emergency news monitor: 30 critical keywords, auto-halt 2h

**Phase 4 — Advanced** *(needs 50+ trades)*
- [ ] Signal statistics analysis (`getSignalStats()`)
- [ ] Live trading mode (`mode: auto`)

**Phase 6 — Intelligence & Ops** ✅
- [x] P6.1 Hyperopt — Bayesian parameter optimization (`npm run hyperopt`)
- [x] P6.2 Dynamic Pairlist — Daily auto-selection from Binance (`npm run pairlist:refresh`)
- [x] P6.3 Intra-candle backtest simulation
- [x] P6.4 Options market data signals
- [x] P6.5 Economic calendar risk gate
- [x] P6.6 Auto Walk-Forward — Periodic re-optimization (`npm run auto-wf`)
- [x] P6.7 Kill switch circuit breaker
- [x] P6.8 Web real-time dashboard (`npm run dashboard`)

**Phase 7 — Reliability & Safety** ✅
- [x] P7.1 Exchange-native stop loss (STOP_LOSS_LIMIT on Binance)
- [x] P7.2 Force exit (market order after 3 timeout retries)
- [x] P7.3 Telegram interactive commands (/profit, /positions, /forcesell…)
- [x] P7.4 Strategy state store (cross-candle persistence)

**Phase 8 — Freqtrade Parity** ✅
- [x] P8.1 Break-even stop + customStoploss() strategy hook
- [x] P8.2 Exit confirmation + confirmExit() strategy hook

**Phase G — Freqtrade Alignment** ✅
- [x] G1 Protection Manager (4 protections)
- [x] G2 DataProvider centralized kline cache
- [x] G3 Complete order timeout loop
- [x] G4 Enhanced trailing stop (positive/offset)
- [x] G5 SQLite optional persistence
- [x] G6 P5.3/P5.4 research (Binance OI + Reddit)

## License

MIT

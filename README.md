# openclaw-trader

> AI-powered crypto trading bot built on [OpenClaw](https://openclaw.ai) — autonomous signal detection, risk management, and trade execution for Binance.

[🇨🇳 中文文档](./README_CN.md)

---

## What It Does

openclaw-trader monitors crypto markets 24/7, detects trading signals using technical + sentiment analysis, and executes trades on Binance (paper, testnet, or live). An AI agent (via OpenClaw) handles market analysis, strategy decisions, and Telegram reporting — you set the rules, it does the work.

**Core loop** (every 60 seconds):
1. Fetch klines → compute indicators (EMA, RSI, MACD, ATR, VWAP, CVD)
2. Classify market regime → filter by risk:reward → check correlations
3. Gate through sentiment + news → size position via Kelly formula
4. Execute or notify → manage exits (SL/TP/trailing/ROI table/break-even)

## Key Features

### Signal Detection
- **20+ signal conditions** — MA crossover, RSI zones, MACD histogram, volume surge, CVD pressure, VWAP bounce, funding rate extremes, BTC dominance shifts
- **Multi-timeframe confirmation** — 1h / 4h / 1d trend alignment before entry
- **Regime-aware** — trending / sideways / breakout / reduced-size; auto-adjusts parameters per regime
- **Pluggable strategies** — YAML config (default) or TypeScript plugins (RSI reversal, breakout, custom)
- **Ensemble voting** — Multiple strategies vote with configurable weights; threshold and unanimous modes

### Risk Management
- **Entry protection** — R:R pre-filter, entry slippage guard, correlation-based position reduction, Kelly sizing
- **Exit protection** — Stop-loss, take-profit, trailing stop (with positive offset), ROI table (time-decayed targets), staged take-profit, time-stop
- **Break-even stop** — Auto-move SL to entry after profit threshold; `customStoploss()` hook for dynamic logic
- **Exit confirmation** — Reject abnormal exits during flash crashes; `confirmExit()` strategy hook
- **Exchange-native stop-loss** — `STOP_LOSS_LIMIT` on Binance after fill; survives bot crashes
- **Force exit** — Market-order emergency close after repeated timeout failures
- **Circuit breaker** — Kill switch halts all trading on extreme drawdown or BTC crash
- **Protection manager** — Cooldown period, max drawdown guard, stoploss guard, low-profit pair filter

### Market Intelligence
- **News & sentiment** — Fear & Greed index + LLM semantic analysis (via OpenClaw Gateway) + keyword scoring
- **Emergency halt** — 30 critical keywords scanned every 10 min; auto-freeze trading for 2h on match
- **Liquidation heatmap** — Binance Futures forced liquidation data; long/short squeeze detection
- **Reddit sentiment** — r/CryptoCurrency + r/Bitcoin keyword analysis
- **Options signals** — Put/call ratio + open interest from Binance options
- **Economic calendar** — FOMC/CPI/NFP event risk gating

### Backtesting & Optimization
- **Backtest engine** — Historical data with Sharpe, Sortino, Calmar, max drawdown, BTC alpha, slippage sweep
- **Bid/ask spread modeling** — Configurable `spread_bps` for realistic backtest cost simulation
- **Intra-candle simulation** — High/low price exit checks within each candle
- **Bayesian hyperopt** — TPE + elite evolution across 8 parameters; walk-forward validation
- **Auto walk-forward** — Scheduled periodic re-optimization
- **Signal statistics** — Per-signal-combo win rate, expectancy, profit factor analysis (`npm run signal-stats`)

### Operations
- **Telegram commands** — `/profit`, `/positions`, `/balance`, `/status`, `/forcesell BTCUSDT`
- **Web dashboard** — Real-time positions, equity curve, trade history (lightweight Express server)
- **Dynamic pairlist** — Auto-select top pairs by volume/volatility from Binance daily
- **Watchdog** — Alert if monitor goes silent; health checks every 30 min
- **Log rotation** — Daily archival, 30-day retention
- **Position reconciliation** — Diff local vs exchange state on startup
- **SQLite persistence** — Optional `better-sqlite3` trade history alongside JSON
- **Weekly performance report** — Equity curve SVG chart + key metrics, auto-send to Telegram (`npm run weekly`)
- **Execution drift monitor** — Compare paper vs live fills to detect slippage divergence (`npm run drift`)
- **Strategy-level DCA** — `adjustPosition()` hook lets plugins control add/reduce logic per trade

## Quick Start

```bash
git clone https://github.com/gcmsg/openclaw-trader
cd openclaw-trader
npm run setup       # ← interactive wizard: credentials, paper config, cron sync

npm run live        # Start testnet/live monitor
npm run paper:status  # View account status
npm run doctor      # Diagnose environment issues
npm test            # Run test suite
```

## Testnet Setup (Important)

> ⚠️ Binance has **two separate testnet systems** — they use different API keys and cannot be swapped.

| System | URL | Used for |
|--------|-----|----------|
| **Spot Testnet** | https://testnet.binance.vision | Spot paper trading |
| **Futures Testnet** | https://testnet.binancefuture.com | Futures paper trading |

**Step-by-step:**

1. **Spot Testnet** — Log in with your GitHub account at [testnet.binance.vision](https://testnet.binance.vision), click "Generate HMAC_SHA256 Key". Save to `.secrets/binance-testnet.json`.

2. **Futures Testnet** — Register separately at [testnet.binancefuture.com](https://testnet.binancefuture.com). API Keys → Create. Save to `.secrets/binance-futures-testnet.json`.

3. Both keys follow the same format:
   ```json
   { "apiKey": "YOUR_KEY_HERE", "secretKey": "YOUR_SECRET_HERE" }
   ```

**Known testnet limitations** (handled automatically — no action needed):
- Spot testnet limits you to 5 concurrent stop-loss/take-profit orders (`MAX_NUM_ALGO_ORDERS`). The system gracefully falls back to local price-polling for any orders beyond this limit.
- Futures testnet rejects conditional orders via the standard REST API. The system automatically falls back to local price-polling stop-loss management.

## Configuration

### Strategy (`config/strategy.yaml`)

```yaml
mode: "paper"                  # notify_only | paper | auto

strategy:
  ma: { short: 20, long: 60 }
  rsi: { oversold: 35, overbought: 65 }

risk:
  stop_loss_percent: 5
  take_profit_percent: 15
  position_ratio: 0.2          # 20% of equity per trade
  break_even_profit: 0.03      # Move SL to entry after +3%
  minimal_roi:                 # Time-decayed take-profit
    "0": 0.08
    "60": 0.04
    "120": 0.02

paper:
  initial_usdt: 1000
```

### Signals (`config/strategy.yaml` → `signals`)

All conditions are composable — mix and match freely:

| Category | Conditions |
|----------|-----------|
| **Trend** | `ma_bullish`, `ma_bearish`, `ma_crossover`, `ma_crossunder` |
| **Momentum** | `rsi_bullish`, `rsi_bearish`, `rsi_bullish_zone`, `rsi_overbought_exit` |
| **MACD** | `macd_bullish`, `macd_bearish`, `macd_histogram_shrinking` |
| **Volume** | `volume_surge`, `volume_low`, `cvd_bullish`, `cvd_bearish` |
| **VWAP** | `price_above_vwap`, `vwap_bounce`, `vwap_breakdown`, `price_below_vwap_lower2` |
| **Funding** | `funding_rate_overlong`, `funding_rate_overshort` |
| **Dominance** | `btc_dominance_rising`, `btc_dominance_falling` |

### Strategy Plugins

Write code-based strategies for complex logic:

```typescript
// src/strategies/my-plugin.ts
import type { Strategy, StrategyContext } from "./types.js";
import { registerStrategy } from "./registry.js";

const myStrategy: Strategy = {
  id: "my-plugin",
  name: "My Custom Strategy",
  populateSignal(ctx) {
    if (ctx.indicators.rsi < 25 && ctx.indicators.maShort > ctx.indicators.maLong) return "buy";
    if (ctx.indicators.rsi > 75) return "sell";
    return "none";
  },
  // Optional hooks:
  // customStoploss?(position, ctx) → number | null
  // confirmExit?(position, exitReason, ctx) → boolean
  // shouldExit?(position, ctx) → ExitResult | null
  // adjustPosition?(position, ctx) → number | null  (DCA: >0 add, <0 reduce)
  // onTradeClosed?(result, ctx) → void
};

registerStrategy(myStrategy);
```

Built-in: `default` (YAML conditions), `rsi-reversal`, `breakout`, `ensemble` (multi-strategy voting)

## CLI Commands

| Command | Description |
|---------|-------------|
| `npm run monitor` | Single signal scan (cron mode) |
| `npm run live` | Start testnet/live monitor daemon |
| `npm run backtest` | Run backtest (`--strategy`, `--days`, `--symbols`, `--slippage-sweep`) |
| `npm run backtest:compare` | Compare all strategies side-by-side |
| `npm run hyperopt` | Bayesian parameter optimization (`--trials`, `--walk-forward`) |
| `npm run auto-wf` | Auto walk-forward re-optimization |
| `npm run analysis` | On-demand market analysis report |
| `npm run attribution` | Signal attribution (win-rate per signal combo) |
| `npm run dashboard` | Web dashboard (default port 8080) |
| `npm run pairlist:refresh` | Refresh dynamic pairlist from Binance |
| `npm run paper:status` | View paper trading account |
| `npm run cmd -- "/profit"` | Execute Telegram command locally |
| `npm run cron:sync` | Sync scheduled tasks to system crontab |
| `npm run health:check` | Manual health check |
| `npm run signal-stats` | Signal combo statistics (`--backtest`, `--days`, `--top`) |
| `npm run weekly` | Weekly performance report (`--scenario`, `--days`, `--send`) |
| `npm run drift` | Paper vs live execution drift (`--paper`, `--live`, `--threshold`) |
| `npm test` | Run all tests |

## Scheduled Tasks

Defined in `config/strategy.yaml` → `schedule:`. Apply with `npm run cron:sync`.

| Task | Interval | Description |
|------|----------|-------------|
| `price_monitor` | Every 1 min | Signal detection + trade execution |
| `news_emergency` | Every 10 min | Critical keyword scan; auto-halt 2h |
| `watchdog` | Every 5 min | Monitor liveness check |
| `news_collector` | Every 4 hrs | Full sentiment report (F&G + LLM) |
| `health_check` | Every 30 min | Task health verification |
| `log_rotate` | Daily 00:00 | Log archival + cleanup |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BINANCE_API_KEY` | Binance API key (read + trade, no withdrawal) |
| `BINANCE_SECRET_KEY` | Binance API secret |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw gateway token for AI notifications |
| `OPENCLAW_GATEWAY_PORT` | Gateway port (default: `18789`) |

## Project Structure

```
src/
├── monitor.ts                  Main polling loop (1-min cron)
├── types.ts                    Global TypeScript types
├── exchange/                   Binance REST/WS, market data, pairlist
├── strategy/                   Indicators, signals, risk filters, break-even, ROI table
├── strategies/                 Pluggable strategy system (interface + registry + plugins + ensemble)
├── analysis/                   Signal statistics + execution drift monitoring
├── paper/                      Paper trading engine (account, exits, status)
├── backtest/                   Backtest engine (fetcher, runner, metrics, report)
├── live/                       Live/testnet executor + reconciliation
├── optimization/               Hyperopt (Bayesian TPE) + walk-forward
├── news/                       Sentiment analysis (F&G, LLM, Reddit, emergency)
├── health/                     Watchdog, health checks, log rotation, kill switch
├── telegram/                   Telegram command handler
├── web/                        Dashboard server
├── persistence/                SQLite layer (optional)
├── notify/                     OpenClaw agent notifications
└── scripts/                    CLI entry points

config/
├── strategy.yaml               Strategy + schedule configuration
├── paper.yaml                  Paper/testnet trading scenarios
└── strategies/                 Named strategy profiles

logs/                           Runtime state, reports, caches, backtest results
```

## Testing

```bash
npm test                        # 1557 tests, ~15s
npx tsc --noEmit                # TypeScript strict mode check
```

All network calls are mocked. Tests cover indicators, signals, risk management, order execution, backtesting, optimization, Telegram commands, and more.

## Troubleshooting

### Kill switch triggered unexpectedly
The kill switch activates when total drawdown exceeds the configured threshold (default 20% for futures, 80% for spot testnet).

```bash
# Check current state
npm run doctor

# Deactivate kill switch
npm run paper:reset -- --kill-switch
```

**Root causes and fixes:**
- **State file `initialUsdt` mismatch**: If `initialUsdt` in `logs/paper-*.json` doesn't match `paper.yaml → initial_usdt`, P&L is calculated against the wrong baseline. Fix:
  ```bash
  npm run paper:reset -- --scenario testnet-default --set-initial 3000
  ```
- **Position reconciliation wipe**: On restart, if the monitor can't find positions on the exchange (e.g., they were manually closed), it zeros out local state. The resulting equity drop triggers the kill switch. Fix: check exchange positions, then `paper:reset` or manually edit the state file.

### `initialUsdt` shows wrong value
The `paper-*.json` state files persist `initialUsdt` independently from `paper.yaml`. If they diverge:
```bash
npm run paper:reset -- --scenario <id> --set-initial <correct_value>
```

### Futures Testnet `-2015` error
You're using the Spot Testnet key on a Futures endpoint. These use different systems — see **Testnet Setup** above.

### Cron jobs not running
```bash
npm run cron:sync    # Re-register all scheduled tasks
npm run cron:list    # Verify registered tasks
```

## License

[GPLv3](./LICENSE)

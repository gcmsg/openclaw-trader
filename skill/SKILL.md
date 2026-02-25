---
name: openclaw-trader
description: Operate and maintain the openclaw-trader crypto trading bot. Use when the user wants to set up, configure, monitor, backtest, or troubleshoot the automated trading system. Covers paper trading, backtesting, signal monitoring, news sentiment analysis, short/bearish engine, Futures testnet, health checks, strategy tuning, bug fixes, and weekly review reports. Also use when the user asks about trading signals, account status, cron jobs, backtesting results, or strategy parameters.
---

# openclaw-trader

AI-powered crypto trading bot with paper trading, backtesting engine, technical indicators (EMA + RSI Wilder + MACD + ATR), news sentiment gating, **full short/bearish engine (Futures/Margin)**, Binance Testnet verification, and automated health monitoring.

## Project Layout

```
openclaw-trader/
├── config/
│   ├── strategy.yaml        ← Global strategy + 7 schedule tasks
│   ├── paper.yaml           ← Paper / testnet trading scenarios
│   └── strategies/          ← Named strategy profiles
├── src/
│   ├── monitor.ts           ← Polling monitor: indicators → signal → regime → R:R → Kelly → execute
│   ├── types.ts             ← Global TypeScript types
│   ├── exchange/
│   │   ├── binance-client.ts   ← REST (Spot + Futures, live + testnet)
│   │   ├── binance.ts          ← Public kline/price (no auth)
│   │   ├── ws.ts               ← WebSocket kline stream
│   │   ├── order-flow.ts       ← CVD (aggTrade + file cache)
│   │   ├── futures-data.ts     ← Funding rate + OI
│   │   └── macro-data.ts       ← DXY/SPX/VIX via FRED
│   ├── strategy/
│   │   ├── indicators.ts       ← EMA / RSI Wilder / MACD / ATR / VWAP
│   │   ├── signals.ts          ← 20+ condition checkers
│   │   ├── correlation.ts      ← Pearson filter + portfolio heat
│   │   ├── regime.ts           ← Market regime classifier
│   │   ├── rr-filter.ts        ← R:R pre-trade filter
│   │   ├── kelly.ts            ← Kelly position sizing (half-Kelly)
│   │   ├── portfolio-risk.ts   ← Portfolio exposure + corr-adjusted sizing
│   │   ├── market-context.ts   ← MTF (1h/4h/1d) + pivot points
│   │   ├── btc-dominance.ts    ← 30-day dominance tracker + signals
│   │   └── funding-rate-signal.ts ← Funding extremes + 10-min cache
│   ├── paper/
│   │   ├── account.ts       ← Virtual account (P&L, staged TP, time-stop)
│   │   ├── engine.ts        ← All exit conditions
│   │   └── status.ts        ← CLI status viewer
│   ├── backtest/
│   │   ├── fetcher.ts       ← Historical kline fetcher (paginated + cached)
│   │   ├── metrics.ts       ← Sharpe / Sortino / Calmar / BTC alpha
│   │   ├── runner.ts        ← Multi-symbol engine (regime + R:R + correlation)
│   │   └── report.ts        ← Console + JSON
│   ├── live/
│   │   ├── executor.ts      ← Order execution (Spot + Futures)
│   │   └── reconcile.ts     ← Startup position reconciliation
│   ├── news/
│   │   ├── fetcher.ts       ← Fear & Greed + headlines
│   │   ├── monitor.ts       ← Full 4h news scan
│   │   ├── emergency-monitor.ts ← Critical keyword scan (10-min cron)
│   │   ├── sentiment-gate.ts    ← Keyword scoring + cache integration
│   │   ├── sentiment-cache.ts   ← LLM sentiment persistence (6h TTL)
│   │   └── llm-sentiment.ts     ← OpenClaw Gateway LLM analysis
│   ├── health/
│   │   ├── heartbeat.ts     ← Task ping tracking
│   │   ├── checker.ts       ← Health check cron (30-min)
│   │   ├── watchdog.ts      ← price_monitor liveness (5-min, 30-min cooldown)
│   │   └── log-rotate.ts    ← Daily log archival + cleanup
│   ├── notify/
│   │   └── openclaw.ts      ← OpenClaw agent notifications
│   ├── report/
│   │   └── weekly.ts        ← Weekly performance report
│   └── scripts/
│       ├── backtest.ts         ← Backtest CLI
│       ├── market-analysis.ts  ← On-demand analysis (npm run analysis)
│       ├── signal-attribution.ts ← Attribution report (npm run attribution)
│       ├── live-monitor.ts     ← Live/testnet monitor
│       ├── ws-monitor.ts       ← WebSocket realtime
│       └── sync-cron.ts        ← Cron sync (7 tasks)
├── .secrets/                ← API keys (gitignored)
├── AGENT_POLICY.md          ← Authorization boundary (READ BEFORE ACTING)
└── logs/
    ├── news-emergency.json         ← Emergency halt state (2h auto-expire)
    ├── btc-dominance-history.json  ← 30-day dominance records
    ├── funding-rate-cache.json     ← 10-min funding rate cache
    ├── heartbeat.json              ← Task heartbeat timestamps
    ├── paper-{scenarioId}.json     ← Paper account state
    ├── backtest/                   ← Backtest JSON reports
    ├── archive/                    ← Rotated logs (30-day retention)
    └── kline-cache/                ← Historical K-line cache
```

## Setup

```bash
npm install
cp .env.example .env       # Fill in OPENCLAW_GATEWAY_TOKEN
npm run cron:sync          # Apply schedule config to system crontab
```

Binance credentials go in `.secrets/` (see `.secrets/*.example` files).

## Operating Modes

Set `mode` per scenario in `config/paper.yaml`:
- `paper` — Simulate trades with real prices (default, safe)
- `live` — Real money (**requires explicit user authorization**)

Exchange type per scenario (`exchange.market`):
- `spot` — Long only; buy/sell
- `futures` — Long + Short; Futures Testnet verified
- `margin` — Long + Short via margin borrowing

## Agent Policy (read AGENT_POLICY.md before acting)

**Auto-execute + notify:**
- Bug fixes, test failures, config errors
- Strategy parameter tuning (MA/RSI/MACD thresholds, stop-loss %)
- Refactoring, test coverage, README/skill updates

**Discuss with user first:**
- New features, core logic changes
- Switching to live trading
- Any real-money operations

## Key Workflows

### Run a backtest
```bash
npm run backtest
npm run backtest -- --strategy short-trend --days 90
npm run backtest -- --strategy long-short --symbols BTCUSDT,ETHUSDT --days 60
npm run backtest:compare -- --days 90
npm run backtest -- --slippage-sweep        # Test multiple slippage values
```

### Signal attribution analysis
```bash
npm run attribution   # Reads logs/signal-history.jsonl → reports/signal-attribution.json
```

### On-demand market analysis
```bash
npm run analysis          # Full report (indicators + macro + sentiment)
npm run analysis -- --quick  # Quick scan (skip slow data sources)
```

### Emergency news management
```bash
npm run news:emergency    # Manually trigger one news poll cycle
# To clear an active halt: delete logs/news-emergency.json
```

### Watchdog / health
```bash
npm run watchdog          # Manual watchdog run (normally cron, every 5 min)
npm run health:check      # Manual health check
npm run log:rotate        # Manual log rotation
```

### Futures testnet connectivity test
```bash
npx tsx src/scripts/test-futures.ts
```

### Start live / testnet trading
```bash
npm run live          # Uses paper.yaml; reconciles positions on startup
npm run ws-monitor    # WebSocket realtime version (< 1s latency)
```

### View paper account
```bash
npm run paper:status
```

### Run tests
```bash
npm test              # 479 unit tests
npm run typecheck     # 0 TS errors target
npm run lint          # 0 ESLint errors target
```

### Update schedule or strategy
1. Edit `config/strategy.yaml` or `config/paper.yaml`
2. Run `npm run cron:sync` to apply cron changes (7 tasks: price_monitor, news_emergency, watchdog, news_collector, health_check, weekly_report, log_rotate)

## Signal Logic

### Long (Spot / Futures)
| Signal | Typical Conditions |
|---|---|
| `buy` | `ma_bullish` + `macd_golden_cross` + `rsi_not_overbought` |
| `sell` | `ma_bearish` |

### Short (Futures / Margin only)
| Signal | Typical Conditions |
|---|---|
| `short` | `ma_bearish` + `macd_death_cross` + `rsi_not_oversold` |
| `cover` | `ma_bullish` |

Signal priority: `buy → sell → short → cover`  
MTF filter: skip `buy` if higher-TF MA is bearish; skip `short` if higher-TF MA is bullish.

### Available condition checkers

**MA / Trend**
`ma_bullish` / `ma_bearish` / `ma_crossover` / `ma_crossunder`

**RSI**
`rsi_bullish` / `rsi_bearish` / `rsi_not_overbought` / `rsi_not_oversold` / `rsi_bullish_zone`  
`rsi_overbought_exit` ← momentum-fade sell (RSI > `overbought_exit`, default 75)

**MACD**
`macd_bullish` / `macd_bearish` / `macd_golden_cross` / `macd_death_cross`  
`macd_histogram_shrinking` ← 3 consecutive bars shrinking (momentum-fade exit)

**Volume / CVD**
`volume_surge` / `volume_low`  
`cvd_bullish` / `cvd_bearish` ← 20-bar net buy/sell pressure (kline approximation)

**VWAP** (daily, resets at midnight UTC)
`price_above_vwap` / `price_below_vwap`  
`vwap_bounce` ← prev bar below VWAP, current bar back above (institutional buy)  
`vwap_breakdown` ← prev bar above VWAP, current bar drops below  
`price_above_vwap_upper2` / `price_below_vwap_lower2` ← ±2σ overbought/oversold

**Funding Rate** (futures markets; 10-min cache)
`funding_rate_overlong` ← rate > `strategy.funding_rate.long_threshold` (default 0.30%)  
`funding_rate_overshort` ← rate < `-short_threshold` (default 0.15%)

**BTC Dominance** (7-day trend from `logs/btc-dominance-history.json`)
`btc_dominance_rising` ← 7d change > +0.5% → altcoin risk  
`btc_dominance_falling` ← 7d change < -0.5% → altcoin season

### Short engine key facts
- **Single-direction mode**: no hedge mode; same symbol holds one direction at a time
- **Shared pool**: longs + shorts share `max_positions` limit
- **SL/TP inverted**: short SL = `entryPrice × (1 + SL%)`, TP = `entryPrice × (1 - TP%)`
- **Trailing stop**: tracks `lowestPrice`; triggers when price bounces > `lowestPrice × (1 + callback%)`
- **Binance Futures**: `marketSell` = open short, `marketBuyByQty` = cover short
- **Testnet quirk**: market orders return `status=NEW` initially; poll `getOrder()` after ~2s for `FILLED`

## Risk Parameters (quick reference)

```yaml
risk:
  stop_loss_percent: 5
  take_profit_percent: 10
  trailing_stop:
    enabled: true
    activation_percent: 5    # Activate after X% gain (long) or drop (short)
    callback_percent: 2      # Trigger on X% reversal from peak/trough
  position_ratio: 0.2        # Fraction of equity per trade
  max_positions: 4           # Long + short combined
  max_total_loss_percent: 20
  daily_loss_limit_percent: 8
  # Optional: R:R pre-trade filter (disabled by default)
  min_rr: 1.5                # Skip trade if risk:reward < 1.5 (entry must be near support)
  # Optional: ATR dynamic sizing
  atr_position:
    enabled: true
    risk_per_trade_percent: 2
    atr_multiplier: 1.5
    max_position_ratio: 0.3
  # Optional: staged take-profit
  take_profit_stages:
    - at_percent: 8
      close_ratio: 0.5
  # Optional: time stop
  time_stop_hours: 72
  # Optional: Kelly position sizing (replaces position_ratio)
  position_sizing: "kelly"   # "fixed" (default) or "kelly"
  kelly_lookback: 50         # Use last N signals for win-rate (default 50)
  kelly_half: true           # Use half-Kelly (default true)
  kelly_min_ratio: 0.05      # Minimum position ratio (default 0.05)
  kelly_max_ratio: 0.40      # Maximum position ratio (default 0.40)
```

### Regime Filter (quick reference)

Market regime is inferred from `regime_filter` config in strategy:

```yaml
regime_filter:
  enabled: true
  min_confidence: 60         # Minimum regime confidence to act (0–100)
```

Regime labels: `trending_up` / `trending_down` → normal size  
`sideways` → skip all open signals  
`breakout_watch` → skip if `skip_on_breakout_watch: true`  
`reduced_size` → halve `position_ratio`

### Emergency News Halt

State file: `logs/news-emergency.json`  
Triggered when ≥ 2 of 30 critical keywords appear in latest news.  
Effect: monitor.ts skips all `buy`/`short` signals for 2 hours.  
Clear manually: `npm run news:emergency` or delete state file.

### Correlation Filter (quick reference)

```yaml
correlation:
  enabled: true              # Default: true
  threshold: 0.75            # Pearson correlation threshold (default 0.75)
  lookback_periods: 30       # Rolling window for correlation calc
```

When portfolio heat (correlation × weight sum) ≥ 0.9: position blocked.  
When heat < 0.9: continuous reduction — `adjusted_size = base × (1 - heat)`.

## References

- **All commands**: See `references/commands.md`
- **Config options**: See `references/config.md`

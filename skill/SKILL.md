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
│   ├── strategy.yaml       ← Global strategy + schedule config
│   ├── paper.yaml          ← Paper / testnet trading scenarios
│   └── strategies/         ← Named strategy profiles
│       ├── default.yaml
│       ├── aggressive.yaml
│       ├── conservative.yaml
│       ├── trend.yaml
│       ├── rsi-pure.yaml
│       ├── short-trend.yaml   ← Pure short (bearish) strategy
│       └── long-short.yaml    ← Bidirectional (long + short)
├── src/
│   ├── monitor.ts          ← Polling price scanner (cron mode)
│   ├── types.ts            ← Global TypeScript types
│   ├── exchange/
│   │   ├── binance-client.ts  ← Binance REST (Spot + Futures, live + testnet)
│   │   └── ws.ts              ← WebSocket kline stream manager
│   ├── strategy/
│   │   ├── indicators.ts   ← EMA / RSI Wilder / MACD / ATR
│   │   ├── signals.ts      ← Signal detection (buy/sell/short/cover)
│   │   └── correlation.ts  ← Pearson correlation filter
│   ├── paper/
│   │   ├── account.ts      ← Virtual account (long + short, P&L, trailing stop)
│   │   ├── engine.ts       ← Signal handler + exit conditions
│   │   └── status.ts       ← CLI account status viewer
│   ├── backtest/
│   │   ├── fetcher.ts      ← Historical K-line fetcher (paginated + cached)
│   │   ├── metrics.ts      ← Sharpe / Sortino / drawdown / profit factor
│   │   ├── runner.ts       ← Multi-symbol backtest engine (long + short)
│   │   └── report.ts       ← Console output + JSON report saver
│   ├── live/
│   │   └── executor.ts     ← Live executor (Spot buy/sell + Futures short/cover)
│   ├── news/
│   │   ├── fetcher.ts      ← Fear & Greed + CryptoCompare headlines
│   │   ├── monitor.ts      ← News scan entry point
│   │   └── sentiment-gate.ts ← Keyword scoring gate
│   ├── config/
│   │   └── loader.ts       ← Runtime config loader
│   ├── report/
│   │   └── weekly.ts       ← Weekly performance report
│   ├── notify/
│   │   └── openclaw.ts     ← OpenClaw agent notifications
│   └── scripts/
│       ├── backtest.ts     ← Backtest CLI (npm run backtest)
│       ├── live-monitor.ts ← Testnet live monitor (npm run live)
│       ├── ws-monitor.ts   ← WebSocket realtime monitor (npm run ws-monitor)
│       ├── sync-cron.ts    ← Cron sync utility
│       └── test-futures.ts ← Futures testnet connectivity test
├── .secrets/
│   ├── binance-testnet.json           ← Spot Testnet API key
│   ├── binance-futures-testnet.json   ← Futures Testnet API key
│   └── binance.json                   ← Live API key (⚠️ real money)
├── AGENT_POLICY.md         ← Agent authorization boundary (read before acting)
└── logs/
    ├── paper-{scenarioId}.json   ← Per-scenario paper trading accounts
    ├── backtest/                 ← Backtest JSON reports
    └── kline-cache/              ← Cached historical K-line data
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
```

### Futures testnet connectivity test
```bash
npx tsx src/scripts/test-futures.ts
# Verifies: ping → balance → price → open short → query order → cover short
```

### Start live / testnet trading
```bash
npm run live          # Uses paper.yaml scenarios with testnet:true
npm run ws-monitor    # WebSocket realtime version (< 1s latency)
```

### View paper account
```bash
npm run paper:status
```

### Run tests
```bash
npm test              # 269 unit tests
npm run typecheck     # 0 TS errors target
npm run lint          # 0 ESLint errors target
```

### Update schedule or strategy
1. Edit `config/strategy.yaml` or `config/paper.yaml`
2. Run `npm run cron:sync` to apply cron changes

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
`ma_bullish` / `ma_bearish` / `ma_golden_cross` / `ma_death_cross`  
`rsi_oversold` / `rsi_overbought` / `rsi_not_overbought` / `rsi_not_oversold` / `rsi_bullish_zone`  
`macd_bullish` / `macd_bearish` / `macd_golden_cross` / `macd_death_cross`  
`volume_surge` / `volume_low`

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
  # Optional ATR dynamic sizing
  atr_position:
    enabled: true
    risk_per_trade_percent: 2
    atr_multiplier: 1.5
    max_position_ratio: 0.3
  # Optional staged take-profit
  take_profit_stages:
    - at_percent: 8
      close_ratio: 0.5
  # Optional time stop
  time_stop_hours: 72
```

## References

- **All commands**: See `references/commands.md`
- **Config options**: See `references/config.md`

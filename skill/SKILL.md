---
name: openclaw-trader
description: Operate and maintain the openclaw-trader crypto trading bot. Use when the user wants to set up, configure, monitor, or troubleshoot the automated trading system. Covers paper trading, signal monitoring, news sentiment analysis, health checks, strategy tuning, bug fixes, and weekly review reports. Also use when the user asks about trading signals, account status, cron jobs, or strategy parameters.
---

# openclaw-trader

AI-powered crypto trading bot with paper trading, technical indicators (MA + RSI + MACD), news sentiment gating, and automated health monitoring.

## Project Layout

```
openclaw-trader/
├── config/strategy.yaml    ← All strategy + schedule config (single source of truth)
├── src/
│   ├── monitor.ts          ← Price scanner (runs every minute)
│   ├── exchange/binance.ts ← Binance REST API
│   ├── strategy/           ← indicators.ts, signals.ts
│   ├── paper/              ← account.ts, engine.ts, status.ts
│   ├── news/               ← fetcher.ts, monitor.ts, sentiment-gate.ts
│   ├── health/             ← heartbeat.ts, checker.ts
│   ├── report/weekly.ts    ← Weekly review generator
│   └── scripts/sync-cron.ts ← Cron sync from config
├── logs/                   ← Runtime logs and state files
├── AGENT_POLICY.md         ← Agent authorization boundary (read before acting)
└── .env                    ← API keys (not committed)
```

## Setup

```bash
npm install
cp .env.example .env       # Fill in BINANCE_API_KEY, BINANCE_SECRET_KEY, OPENCLAW_GATEWAY_TOKEN
npm run cron:sync          # Apply schedule config to system crontab
```

## Operating Modes

Set `mode` in `config/strategy.yaml`:
- `notify_only` — Detect signals, notify agent only
- `paper` — Simulate trades with real prices (default)
- `auto` — Live trading (**requires explicit user authorization**)

## Agent Policy (read AGENT_POLICY.md before acting)

**Auto-execute + notify:**
- Bug fixes, test failures, config errors
- Strategy parameter tuning (MA/RSI/MACD thresholds, stop-loss %)
- Refactoring, test coverage, README updates

**Discuss with user first:**
- New features, core logic changes
- Switching to live trading
- Any real-money operations

## Key Workflows

### Check system health
```bash
npm run health:check
cat logs/health-snapshot.json
```

### View paper account
```bash
npm run paper:status
```

### Update schedule or strategy
1. Edit `config/strategy.yaml`
2. Run `npm run cron:sync` to apply cron changes

### Run tests
```bash
npm test
```

### Generate weekly report manually
```bash
npm run report:weekly
```

## Signal Logic

Buy triggers when ALL conditions met:
- `ma_bullish`: MA short > MA long
- `rsi_oversold`: RSI < 35
- `macd_bullish`: MACD > Signal line, histogram > 0

Sell triggers when ALL conditions met:
- `ma_bearish`: MA short < MA long
- `rsi_overbought`: RSI > 65
- `macd_bearish`: MACD < Signal line, histogram < 0

Sentiment gate adjusts position size before execution. See `references/config.md` for tunable thresholds.

## Logs

| File | Purpose |
|---|---|
| `logs/price_monitor.log` | Per-minute scan results |
| `logs/news_collector.log` | News fetch results |
| `logs/health.log` | Health check runs |
| `logs/health-snapshot.json` | Latest health status |
| `logs/heartbeat.json` | Task last-run timestamps |
| `logs/paper-account.json` | Paper trading state |
| `logs/news-report.json` | Latest sentiment report |
| `logs/reports/weekly-*.json` | Weekly review data |

## References

- **Config options**: See `references/config.md`
- **All commands**: See `references/commands.md`

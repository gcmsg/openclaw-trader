# Commands Reference

All commands run from the project root.

## Runtime

| Command | Description |
|---|---|
| `npm run monitor` | Run one price scan cycle (polling mode) |
| `npm run news` | Run one news fetch cycle |
| `npm run live` | Start live/testnet monitor (reconciles positions on startup) |
| `npm run ws-monitor` | Start WebSocket realtime monitor (< 1s signal latency) |
| `npm run paper:status` | Print paper account summary to terminal |
| `npm run report:weekly` | Generate + send weekly review report |
| `npm run health:check` | Run health check (prints status, alerts if issues) |
| `npm run watchdog` | Manual watchdog check (price_monitor liveness) |
| `npm run log:rotate` | Manual log rotation + paper backup cleanup |
| `npm run news:emergency` | Manual emergency news poll + keyword scan |
| `npm run analysis` | On-demand full market analysis (indicators + macro + sentiment) |
| `npm run analysis -- --quick` | Quick market scan (skip slow sources) |
| `npm run attribution` | Signal attribution: win-rate/R:R by signal combination |

## Backtesting

| Command | Description |
|---|---|
| `npm run backtest` | Backtest default strategy, 90 days |
| `npm run backtest -- --strategy short-trend --days 90` | Backtest named strategy |
| `npm run backtest -- --strategy long-short --symbols BTCUSDT,ETHUSDT --days 60` | Custom symbols |
| `npm run backtest -- --timeframe 4h --days 180` | Different timeframe |
| `npm run backtest -- --initial-usdt 5000` | Custom starting capital |
| `npm run backtest -- --no-save` | Print report only (no JSON file) |
| `npm run backtest:compare -- --days 90` | Compare all strategies side-by-side |
| `npm run backtest -- --slippage-sweep` | Test multiple slippage values (sensitivity analysis) |

## Futures Testnet

```bash
# Full connectivity test: ping → balance → open short → cover short
npx tsx src/scripts/test-futures.ts

# Credentials
.secrets/binance-futures-testnet.json    # Futures Testnet key
.secrets/binance-testnet.json           # Spot Testnet key
# Both have .example files as templates
```

## Configuration & Cron

| Command | Description |
|---|---|
| `npm run cron:sync` | Sync `schedule` block from strategy.yaml → system crontab |
| `npm run cron:list` | Show current openclaw-trader cron entries |

## Development

| Command | Description |
|---|---|
| `npm test` | Run all 479 unit tests |
| `npm run typecheck` | TypeScript type check (0 errors target) |
| `npm run lint` | ESLint check (0 errors target) |

## Useful Log Commands

```bash
# Live price monitor output
tail -f logs/price_monitor.log

# Paper account (specific scenario)
cat logs/paper-default.json | jq '{usdt, positions: (.positions | keys)}'

# Latest news sentiment
cat logs/news-report.json | jq '{fearGreed, sentiment, bigMovers}'

# Backtest results
ls logs/backtest/
cat logs/backtest/latest.json | jq '.metrics'
```

## Environment

Binance credentials are stored in `.secrets/` (not `.env`):
```
.secrets/binance.json                  ← Live (⚠️ real money)
.secrets/binance-testnet.json          ← Spot Testnet ($10,000 USDT)
.secrets/binance-futures-testnet.json  ← Futures Testnet ($5,000 USDT)
```

Format:
```json
{ "apiKey": "...", "secretKey": "..." }
```

OpenClaw gateway token (used for notifications):
```
OPENCLAW_GATEWAY_TOKEN=...    # from openclaw.json gateway.auth.token
OPENCLAW_GATEWAY_PORT=18789
```

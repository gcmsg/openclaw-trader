# Commands Reference

All commands run from the project root. Load `.env` first when running manually:
```bash
cd /path/to/openclaw-trader && source .env
```

## Runtime

| Command | Description |
|---|---|
| `npm run monitor` | Run one price scan cycle |
| `npm run news` | Run one news fetch cycle |
| `npm run paper:status` | Print paper account summary to terminal |
| `npm run report:weekly` | Generate + send weekly review report |
| `npm run health:check` | Run health check (prints status, alerts if issues) |

## Configuration & Cron

| Command | Description |
|---|---|
| `npm run cron:sync` | Sync `schedule` block from strategy.yaml → system crontab |
| `npm run cron:list` | Show current openclaw-trader cron entries |

## Development

| Command | Description |
|---|---|
| `npm test` | Run all 104 unit tests |
| `npm run typecheck` | TypeScript type check (no emit) |

## Useful Log Commands

```bash
# Live price monitor output
tail -f logs/price_monitor.log

# Last health check
cat logs/health-snapshot.json | jq .

# Paper account state
cat logs/paper-account.json | jq '{usdt, positions: (.positions | keys)}'

# Latest news sentiment
cat logs/news-report.json | jq '{fearGreed, sentiment, bigMovers}'

# All task heartbeats
cat logs/heartbeat.json | jq 'to_entries[] | {task: .key, lastRun: (.value.lastRunAt | todate), status: .value.lastStatus}'
```

## Environment Variables (.env)

```
BINANCE_API_KEY=...
BINANCE_SECRET_KEY=...
OPENCLAW_GATEWAY_TOKEN=...    # From openclaw.json gateway.auth.token
OPENCLAW_GATEWAY_PORT=18789   # Default
```

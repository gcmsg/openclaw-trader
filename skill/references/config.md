# Config Reference — config/strategy.yaml

## Strategy

```yaml
strategy:
  ma:
    short: 20          # Short MA period (tune: 10-30)
    long: 60           # Long MA period (tune: 40-100)
  rsi:
    period: 14
    oversold: 35       # Buy threshold (tune: 25-40; lower = fewer signals)
    overbought: 65     # Sell threshold (tune: 60-75)
  macd:
    enabled: true
    fast: 12 / slow: 26 / signal: 9   # Standard params, rarely need changing
  volume:
    surge_ratio: 1.5   # Volume spike multiplier for volume_surge signal
    low_ratio: 0.5     # Volume drought multiplier for volume_low signal
```

## Signals (AND logic — all must be true)

Available checkers:
- `ma_bullish` / `ma_bearish` — trend direction
- `ma_golden_cross` / `ma_death_cross` — crossover events (less frequent)
- `rsi_oversold` / `rsi_overbought`
- `macd_bullish` / `macd_bearish` / `macd_golden_cross` / `macd_death_cross`
- `volume_surge` / `volume_low`

More conditions = fewer but higher-quality signals.

## Risk

```yaml
risk:
  stop_loss_percent: 5        # Per-trade stop loss
  take_profit_percent: 10     # Per-trade take profit
  max_total_loss_percent: 20  # Strategy auto-pauses at this drawdown
  position_ratio: 0.2         # Fraction of equity per trade (max 5 simultaneous positions)
```

## Paper Trading

```yaml
paper:
  initial_usdt: 1000          # Starting virtual capital
  report_interval_hours: 24   # Periodic account summary frequency
```

## News & Sentiment Gate

```yaml
news:
  fear_greed_alert: 15        # FGI delta that triggers alert
  price_alert_threshold: 5    # 24h price move % that gets highlighted
```

Sentiment gate rules (hardcoded in `src/news/sentiment-gate.ts`):
- FGI > 80 on buy → reduce position 50%
- FGI < 20 on sell → warn (possible bottom)
- News sentiment bearish on buy → reduce 50%
- FGI drops ≥15 pts + buy signal → skip entirely
- ≥5 important news items → reduce 50%

## Schedule

```yaml
schedule:
  price_monitor:
    enabled: true
    cron: "* * * * *"         # Every minute
    timeout_minutes: 3

  news_collector:
    enabled: true
    cron: "0 */4 * * *"       # Every 4 hours
    timeout_minutes: 260

  weekly_report:
    enabled: true
    cron: "0 22 * * 0"        # Sunday 22:00
    timeout_minutes: 10100

  health_check:
    enabled: true
    cron: "*/30 * * * *"      # Every 30 min
    timeout_minutes: 35
```

After editing: `npm run cron:sync`

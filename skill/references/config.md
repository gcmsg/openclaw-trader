# Config Reference

## config/paper.yaml — Scenario Definitions

Each scenario is an independent paper/testnet trading session with its own account state.

```yaml
scenarios:
  - id: default                 # Unique ID (used as filename: paper-default.json)
    name: "默认模拟盘"
    enabled: true
    strategy_id: "default"      # Matches config/strategies/<id>.yaml
    initial_usdt: 1000
    fee_rate: 0.001             # 0.1% (Binance spot taker)
    slippage_percent: 0.05
    exchange:
      market: spot              # spot | futures | margin
      testnet: false            # true → use testnet endpoint
      credentials_path: ".secrets/binance.json"
    symbols:
      - BTCUSDT
      - ETHUSDT
    risk:                       # Overrides strategy file defaults
      stop_loss_percent: 5
      take_profit_percent: 10
      trailing_stop:
        enabled: true
        activation_percent: 5
        callback_percent: 2
      position_ratio: 0.2
      max_positions: 4
      max_position_per_symbol: 0.3
      max_total_loss_percent: 20
      daily_loss_limit_percent: 8

  # Futures Testnet example
  - id: futures-short-test
    name: "Futures Testnet 空头测试"
    enabled: true
    strategy_id: "short-trend"
    initial_usdt: 5000
    fee_rate: 0.0004            # Futures taker 0.04%
    exchange:
      market: futures           # ← enables short engine
      testnet: true
      credentials_path: ".secrets/binance-futures-testnet.json"
```

## config/strategies/<name>.yaml — Strategy Profiles

```yaml
name: "My Strategy"
timeframe: "1h"
trend_timeframe: "4h"          # MTF filter timeframe (optional)

strategy:
  ma:
    short: 20                  # EMA short period (tune: 10–30)
    long: 60                   # EMA long period (tune: 40–100)
  rsi:
    period: 14
    oversold: 35               # Buy threshold (tune: 25–40)
    overbought: 65             # Sell threshold (tune: 60–75)
  macd:
    enabled: true
    fast: 12
    slow: 26
    signal: 9
  volume:
    surge_ratio: 1.5
    low_ratio: 0.5

# Signal conditions (AND logic — all listed must be true)
signals:
  buy:
    - ma_bullish
    - macd_golden_cross
    - rsi_not_overbought
  sell:
    - ma_bearish
  short:                       # Futures/Margin only
    - ma_bearish
    - macd_death_cross
    - rsi_not_oversold
  cover:                       # Futures/Margin only
    - ma_bullish

risk:
  stop_loss_percent: 5
  take_profit_percent: 10
  trailing_stop:
    enabled: true
    activation_percent: 5      # % gain (long) or drop (short) to activate
    callback_percent: 2        # % reversal from peak/trough to trigger
  position_ratio: 0.2          # Fraction of equity per trade
  max_positions: 4             # Long + short combined
  max_position_per_symbol: 0.3
  max_total_loss_percent: 20
  daily_loss_limit_percent: 8

  # Optional: ATR dynamic position sizing
  atr_position:
    enabled: true
    risk_per_trade_percent: 2  # Max % of equity to risk per trade
    atr_multiplier: 1.5        # Stop distance = ATR × multiplier
    max_position_ratio: 0.3    # Cap position at 30% of equity

  # Optional: staged take-profit (close in tranches)
  take_profit_stages:
    - at_percent: 8            # At +8% gain
      close_ratio: 0.5         # Close 50% of position
    - at_percent: 12
      close_ratio: 0.5         # Close remaining 50%

  # Optional: time stop (exit if no profit after N hours)
  time_stop_hours: 72

  # Optional: correlation filter
  correlation_filter:
    enabled: true
    threshold: 0.7             # Skip if Pearson correlation > 0.7 with existing positions
    lookback: 30               # Lookback candles for correlation calc
```

## Available Signal Conditions

| Category | Condition | Description |
|---|---|---|
| MA | `ma_bullish` / `ma_bearish` | EMA short > / < EMA long |
| MA | `ma_crossover` / `ma_crossunder` | EMA cross this bar (entry timing) |
| RSI | `rsi_bullish` / `rsi_bearish` | RSI below oversold / above overbought |
| RSI | `rsi_not_overbought` / `rsi_not_oversold` | RSI headroom filters |
| RSI | `rsi_bullish_zone` | RSI 40–60 momentum zone |
| RSI | `rsi_overbought_exit` | RSI > `overbought_exit` (default 75) — momentum fade |
| MACD | `macd_bullish` / `macd_bearish` | MACD line vs signal line |
| MACD | `macd_golden_cross` / `macd_death_cross` | MACD just crossed signal |
| MACD | `macd_histogram_shrinking` | 3 consecutive bars shrinking — momentum fade exit |
| Volume | `volume_surge` / `volume_low` | Volume vs 20-period average |
| CVD | `cvd_bullish` / `cvd_bearish` | 20-bar cumulative volume delta |
| VWAP | `price_above_vwap` / `price_below_vwap` | Price vs daily VWAP |
| VWAP | `vwap_bounce` / `vwap_breakdown` | Cross through VWAP (institutional level) |
| VWAP | `price_above_vwap_upper2` / `price_below_vwap_lower2` | ±2σ extreme zones |
| Funding | `funding_rate_overlong` / `funding_rate_overshort` | Crowded position reversal signals |
| Dominance | `btc_dominance_rising` / `btc_dominance_falling` | 7-day BTC dominance trend |

## config/strategy.yaml — Global + Schedule

```yaml
# Global strategy defaults (overridden per scenario in paper.yaml)
strategy: { … }
signals: { buy: […], sell: […] }
risk: { … }

# Cron schedule (edit then run: npm run cron:sync)
schedule:
  price_monitor:
    enabled: true
    cron: "* * * * *"          # Every minute — signal detection
    timeout_minutes: 3
  news_emergency:
    enabled: true
    cron: "*/10 * * * *"       # Every 10 min — critical keyword scan
    timeout_minutes: 5
  watchdog:
    enabled: true
    cron: "*/5 * * * *"        # Every 5 min — price_monitor liveness
    timeout_minutes: 10
  news_collector:
    enabled: true
    cron: "0 */4 * * *"        # Every 4 hours — full sentiment report
    timeout_minutes: 260
  health_check:
    enabled: true
    cron: "*/30 * * * *"       # Every 30 min — task health check
    timeout_minutes: 35
  weekly_report:
    enabled: true
    cron: "0 22 * * 0"         # Sunday 22:00 CST
    timeout_minutes: 10
  log_rotate:
    enabled: true
    cron: "0 0 * * *"          # Daily midnight — archive + cleanup
    timeout_minutes: 10
```

## Sentiment Gate (hardcoded in sentiment-gate.ts)

- Score ≤ −4 on buy signal → **skip entirely**
- Score ≤ −2 on buy signal → **reduce position 50%**
- Score ≥ +4 on sell signal → **warn + reduce 50%**
- 24 bullish keywords / 30 bearish keywords in the scoring list

## Short Engine Reference

| Parameter | Long | Short |
|---|---|---|
| Stop loss trigger | `price ≤ entry × (1 − SL%)` | `price ≥ entry × (1 + SL%)` |
| Take profit trigger | `price ≥ entry × (1 + TP%)` | `price ≤ entry × (1 − TP%)` |
| Trailing activation | Price rises ≥ activation% | Price drops ≥ activation% |
| Trailing trigger | Drops from peak by callback% | Bounces from trough by callback% |
| Binance order | `marketBuy` / `marketSell` | `marketSell` (open) / `marketBuyByQty` (cover) |

**Testnet quirk**: Futures market orders return `status=NEW` immediately. Poll `getOrder()` after ~2 seconds to confirm `FILLED` and get actual fill price.

# openclaw-trader

> AI-powered crypto trading bot built on [OpenClaw](https://openclaw.ai) · 基于 OpenClaw 的 AI 驱动加密货币交易机器人

---

## English

### Features

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
- 📐 **ATR Dynamic Sizing** — Normalize per-trade risk using ATR volatility
- 🎯 **Kelly Position Sizing** — Dynamic position size from rolling win-rate and R:R; half-Kelly mode; fallback to fixed when sample < 10
- 🔗 **Correlation Filter** — Portfolio heat map; Pearson > 0.75 → continuous position reduction (not binary block)
- 💹 **Funding Rate Signals** — `funding_rate_overlong` / `funding_rate_overshort` reversal signals with 10-min cache
- 📈 **BTC Dominance Tracker** — 30-day history; `btc_dominance_rising` / `btc_dominance_falling` signals
- 📡 **WebSocket Monitor** — Real-time kline stream with < 1s signal latency; CVD WebSocket framework
- 🪙 **Multi-symbol** — BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX
- 🧪 **Multi-strategy Scenarios** — Long-only / short-only / bidirectional in parallel
- 📊 **Signal Attribution** — `npm run attribution`: rank signal combinations by win-rate, R:R, avg hold time
- 🩺 **Watchdog** — Every 5 min: alert if `price_monitor` hasn't run within 3 min; 30-min cooldown
- 🗂️ **Log Rotation** — Daily: archive logs > 20 MB / 24h; keep 30 days; clean old paper backups
- 🔄 **Position Reconciliation** — On live-monitor startup: diff local account vs exchange; halt if > 10% mismatch
- ✅ **Tested** — 479 unit tests across indicators, signals, VWAP, CVD, Kelly, attribution, watchdog, reconcile

### Architecture

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

### Quick Start

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

### Environment Variables

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Binance API key (read + spot trade, no withdrawal) |
| `BINANCE_SECRET_KEY` | Binance API secret |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw gateway token for AI agent notifications |
| `OPENCLAW_GATEWAY_PORT` | Gateway port (default: `18789`) |

### Cron Setup

```bash
# Price monitor — every 1 minute
* * * * *  cd /path/to/openclaw-trader && source .env && npx tsx src/monitor.ts >> logs/monitor.log 2>&1

# News collector — every 4 hours
0 */4 * * *  cd /path/to/openclaw-trader && source .env && npx tsx src/news/monitor.ts >> logs/news-monitor.log 2>&1
```

### Backtesting

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

### Strategy Configuration

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

### Buy / Sell Logic

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

### Project Structure

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
│   └── onchain-data.ts     On-chain metrics (stablecoin flow, miner activity)
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
│   └── funding-rate-signal.ts  Funding rate extreme signals + 10-min cache
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
│   └── log-rotate.ts       Daily log archival + paper backup cleanup
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

### Schedule Configuration

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

### Health Monitoring

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

### Roadmap

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
- [ ] Web dashboard

### License

MIT

---

## 中文

### 功能特性

- 📊 **技术分析** — EMA（20/60）+ RSI Wilder（14）+ MACD + ATR + VWAP 日内（±1σ/±2σ）+ CVD
- ⚙️ **配置驱动策略** — 编辑 `config/strategy.yaml` 即可，无需改代码
- 🗞️ **新闻情绪** — 恐惧贪婪 + LLM 语义评分 + 关键词门控 + 6 小时缓存
- 🚨 **突发新闻监控** — 每 10 分钟扫 30 个高危词（hack/SEC/脱锚）；触发后暂停开仓 2 小时
- 🎭 **模拟盘** — 使用真实价格，记录盈亏/胜率/Calmar 比率
- 🔬 **回测引擎** — 夏普/索提诺/Calmar/BTC 基准 Alpha；`--slippage-sweep` 滑点敏感性
- 📉 **空头引擎** — 开空/平空；反向止损/追踪；与多头共享仓位池
- 🏦 **Binance Testnet & 实盘** — Spot + Futures Testnet 已验证
- 🔔 **AI 信号触发** — 无信号时零 token 消耗
- 🛡️ **风险管理** — 止损/止盈/追踪止损/R:R 预过滤/日亏限额/ATR 仓位/分批止盈/时间止损
- 🏁 **市场状态过滤** — 趋势/横盘/突破等状态识别；横盘自动跳过或减半仓位
- 🎯 **Kelly 动态仓位** — 基于近期胜率和盈亏比动态计算，样本不足退化固定比例
- 🔗 **相关性过滤** — 组合热度加权（非二值），阈值 0.75，连续缩减仓位
- 💹 **资金费率信号** — 极端多头/空头拥挤时触发逆向信号，10 分钟缓存
- 📈 **BTC 主导率追踪** — 30 天历史 + 7 日趋势信号（山寨风险/山寨季节）
- 📊 **信号归因分析** — `npm run attribution`：统计各信号组合的胜率/盈亏比/止损次数
- 🩺 **Watchdog 自监控** — 每 5 分钟检查 price_monitor 是否活着；30 分钟冷却告警
- 🗂️ **日志轮转** — 每日凌晨自动归档；保留 30 天；清理旧备份
- 🔄 **持仓对账** — live-monitor 启动时比对本地 vs 交易所；差异 > 10% 暂停启动
- ✅ **完整测试** — 479 条单元测试

### 运行架构

```
┌────────────────────────────────────────────────────────┐
│  每 1 分钟   src/monitor.ts                            │
│  → K 线 → VWAP/CVD/指标 → 信号检测                    │
│  → Regime 过滤 → R:R 检查 → 相关性 → Kelly 仓位       │
│  → 紧急暂停? → 情绪门控 → 执行/通知                   │
├────────────────────────────────────────────────────────┤
│  每 5 分钟   src/health/watchdog.ts                    │
│  → 检查 price_monitor 心跳；超时 → Telegram 告警      │
├────────────────────────────────────────────────────────┤
│  每 10 分钟  src/news/emergency-monitor.ts             │
│  → 扫描最新新闻 30 个高危关键词                        │
│  → 匹配 ≥ 2 → 暂停开仓 2h + 立即 Telegram 告警       │
├────────────────────────────────────────────────────────┤
│  每 4 小时   src/news/monitor.ts                       │
│  → 恐惧贪婪 + 新闻 + 情绪 → news-report.json          │
├────────────────────────────────────────────────────────┤
│  每 30 分钟  src/health/checker.ts                     │
│  → 检查所有 cron 任务状态；异常时告警                  │
├────────────────────────────────────────────────────────┤
│  每天 0 点   src/health/log-rotate.ts                  │
│  → 归档日志 > 20MB/24h；删除 30 天+ 归档              │
└────────────────────────────────────────────────────────┘
```

### 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 填写 API Key

# 编辑策略（实时生效，无需重启）
vim config/strategy.yaml

# 单次运行（测试）
npm run monitor

# 查看模拟盘账户
npm run paper:status

# 运行测试
npm test
```

### 运行模式

| 模式 | 说明 |
|---|---|
| `notify_only` | 只检测信号并通知，不下单 |
| `paper` | 模拟盘：用真实价格模拟交易，追踪盈亏 |
| `auto` | 自动实盘交易（谨慎开启）|

### 买卖逻辑

| 信号 | 触发条件 | 市场 |
|---|---|---|
| **买入** | EMA20 > EMA60（多头）+ MACD 金叉 + RSI 未超买 | Spot / Futures |
| **卖出** | EMA20 < EMA60（趋势反转） | Spot / Futures |
| **开空** | EMA20 < EMA60（空头）+ MACD 死叉 + RSI 未超卖 | **Futures / Margin** |
| **平空** | EMA20 > EMA60（趋势反转） | **Futures / Margin** |
| **止损** | 多头：价格 ≤ 入场价×(1-SL%) · 空头：价格 ≥ 入场价×(1+SL%) | — |
| **止盈** | 多头：价格 ≥ 入场价×(1+TP%) · 空头：价格 ≤ 入场价×(1-TP%) | — |
| **追踪止损** | 盈利达激活阈值后，从极值回撤 callback% 触发 | — |

> 空头引擎采用单向模式（非对冲），多空仓位共享 `max_positions` 上限

### 进度

**Phase 0 — 修复致命问题** ✅
- [x] Regime 市场状态感知（breakout_watch 跳过 / reduced_size 减仓）
- [x] 动量衰竭出场：`macd_histogram_shrinking` + `rsi_overbought_exit`
- [x] 回测参数修正：真实滑点 + `--slippage-sweep` 滑点敏感性
- [x] BTC Benchmark + Calmar 比率 + Alpha 超额收益

**Phase 1 — 核心 Alpha** ✅
- [x] R:R 入场预过滤（`risk.min_rr`，可选开启）
- [x] CVD 累计成交量差值（K 线近似 + aggTrade WebSocket 框架）
- [x] 相关性过滤默认开启（阈值 0.75，连续缩减）
- [x] 资金费率逆向信号（10 分钟缓存）

**Phase 2 — 风险与归因** ✅
- [x] VWAP 日内（±1σ/±2σ）+ 6 个信号条件
- [x] BTC 主导率 30 天历史 + 趋势信号
- [x] 信号归因报告（`npm run attribution`）
- [x] Kelly 动态仓位（半 Kelly，样本不足退化固定）

**Phase 3 — 运维加固** ✅
- [x] Watchdog：price_monitor 超 3 分钟未运行 → Telegram 告警
- [x] 日志轮转：每日归档，保留 30 天，清理 7 天+ 备份
- [x] 启动持仓对账：本地 vs 交易所，差异 > 10% 暂停
- [x] 突发新闻监控：30 个高危词，触发自动暂停开仓 2h

**Phase 4 — 进阶** *(需 50+ 笔真实交易记录)*
- [ ] 实盘自动交易（`mode: auto`）
- [ ] Web 可视化面板

### 回测使用

```bash
# 默认策略回测（90 天）
npm run backtest

# 指定策略和天数
npm run backtest -- --strategy conservative --days 90
npm run backtest -- --strategy aggressive --days 60

# 自定义币种和时间框架
npm run backtest -- --strategy trend --symbols BTCUSDT,ETHUSDT --timeframe 4h --days 180

# 所有策略对比
npm run backtest:compare -- --days 90
```

回测结果包括：总收益、最大回撤、夏普比率、胜率、利润因子、出场原因分布、各币种表现，JSON 报告保存在 `logs/backtest/`。

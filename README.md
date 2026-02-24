# openclaw-trader

> AI-powered crypto trading bot built on [OpenClaw](https://openclaw.ai) · 基于 OpenClaw 的 AI 驱动加密货币交易机器人

---

## English

### Features

- 📊 **Technical Analysis** — MA (20/60) + RSI (14) + MACD (12/26/9) indicator engine
- ⚙️ **Config-driven Strategy** — Edit `config/strategy.yaml`, no code changes needed
- 🗞️ **News & Sentiment** — Fear & Greed Index + CryptoCompare headlines with sentiment gate
- 🎭 **Paper Trading Mode** — Simulates trades using real market prices; tracks P&L, win rate, positions
- 🔬 **Backtesting Engine** — Test any strategy against months of historical data; Sharpe ratio, max drawdown, profit factor
- 🔔 **AI-triggered Signals** — Zero token cost when idle; only wakes the AI agent on signal detection
- 🛡️ **Risk Management** — Stop-loss, take-profit, trailing stop, daily loss limit, total drawdown auto-pause
- 🪙 **Multi-symbol** — BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX
- 🧪 **Multi-strategy Scenarios** — Run aggressive/conservative/rsi-pure strategies in parallel with isolated accounts
- ✅ **Tested** — 171 unit tests across indicators, signals, paper trading, backtest metrics

### Architecture

```
┌─────────────────────────────────────────────┐
│  Every 1 min  (system crontab)              │
│  src/monitor.ts                             │
│  → Fetch klines → Calc MA/RSI → Detect sig  │
│  → paper mode: simulate trade + notify AI   │
├─────────────────────────────────────────────┤
│  Every 4 hrs  (system crontab)              │
│  src/news/monitor.ts                        │
│  → Fear & Greed + Market cap + News filter  │
│  → Write to logs/news-report.json           │
│                                             │
│  Every 4 hrs +2 min  (OpenClaw cron)        │
│  → Trigger AI agent to read & analyze       │
│  → Push summary to Telegram                 │
└─────────────────────────────────────────────┘
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

| Signal | Conditions |
|---|---|
| **Buy** | MA short > MA long (bullish trend) **AND** RSI < 35 (oversold) |
| **Sell** | MA short < MA long (bearish trend) **AND** RSI > 65 (overbought) |
| **Stop Loss** | Position drops ≥ 5% from entry |

### Project Structure

```
src/
├── monitor.ts              Main entry point
├── types.ts                Global TypeScript types
├── exchange/
│   └── binance.ts          Binance REST API wrapper
├── strategy/
│   ├── indicators.ts       SMA / EMA / RSI / MACD calculation
│   └── signals.ts          Signal detection engine
├── paper/
│   ├── account.ts          Virtual account (buy/sell/P&L)
│   ├── engine.ts           Stop-loss & drawdown checks
│   └── status.ts           CLI account status viewer
├── backtest/
│   ├── fetcher.ts          Historical K-line fetcher (paginated + cached)
│   ├── metrics.ts          Performance metrics (Sharpe, drawdown, profit factor…)
│   ├── runner.ts           Multi-symbol backtest simulation engine
│   └── report.ts           Console output + JSON report saver
├── news/
│   ├── fetcher.ts          Fear & Greed + CryptoCompare headlines
│   └── monitor.ts          News scan entry point
├── notify/
│   └── openclaw.ts         OpenClaw agent notifications
├── scripts/
│   ├── backtest.ts         Backtest CLI (npm run backtest)
│   └── sync-cron.ts        Cron sync utility
└── __tests__/
    ├── indicators.test.ts
    ├── signals.test.ts
    ├── paper-account.test.ts
    ├── paper-engine.test.ts
    └── backtest-metrics.test.ts
config/
├── strategy.yaml           Strategy & risk configuration
└── strategies/             Named strategy profiles
    ├── aggressive.yaml
    ├── conservative.yaml
    ├── rsi-pure.yaml
    └── trend.yaml
logs/
├── monitor.log
├── news-report.json        Latest market sentiment report
├── paper-{scenario}.json   Per-scenario paper trading accounts
├── backtest/               Backtest JSON reports
└── kline-cache/            Cached historical K-line data
```

### Schedule Configuration

All scheduled tasks are defined in `config/strategy.yaml` under `schedule:`.
After editing, run `npm run cron:sync` to apply changes to system crontab.

```yaml
schedule:
  price_monitor:
    enabled: true
    cron: "* * * * *"      # Every minute
    timeout_minutes: 3     # Alert if not run within 3 min

  news_collector:
    enabled: true
    cron: "0 */4 * * *"    # Every 4 hours
    timeout_minutes: 260

  health_check:
    enabled: true
    cron: "*/30 * * * *"   # Every 30 minutes
    timeout_minutes: 35
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

- [x] Technical indicator engine (MA + RSI)
- [x] Signal detection with pluggable conditions
- [x] Paper trading mode with real prices
- [x] News & sentiment analysis (every 4h)
- [x] Risk management (stop-loss, max drawdown)
- [x] MACD + volume indicators & signals
- [x] News sentiment gate (position sizing by sentiment)
- [x] Weekly review report (AI-powered, every Sunday 22:00)
- [x] Health monitoring & heartbeat system
- [x] Config-driven schedule management (`cron:sync`)
- [x] 171 unit tests
- [x] Backtesting engine (Sharpe / max drawdown / profit factor / multi-strategy compare)
- [ ] Live trading mode (`mode: auto`)
- [ ] Web dashboard

### License

MIT

---

## 中文

### 功能特性

- 📊 **技术分析** — MA（20/60）+ RSI（14）+ MACD（12/26/9）指标引擎
- ⚙️ **配置驱动策略** — 编辑 `config/strategy.yaml` 即可调整，无需改代码
- 🗞️ **新闻情绪分析** — 恐惧贪婪指数 + CryptoCompare 新闻 + 情绪门控仓位调整
- 🎭 **模拟盘模式** — 使用真实价格模拟交易，完整记录盈亏、胜率、持仓
- 🔬 **回测引擎** — 用历史 K 线验证任意策略；输出夏普比率、最大回撤、利润因子等专业指标
- 🔔 **AI 信号触发** — 无信号时零 token 消耗，仅在发现信号时唤醒 AI Agent
- 🛡️ **风险管理** — 止损/止盈/追踪止损/日亏限额/总亏上限 五重保障
- 🧪 **多策略并行** — 激进/保守/RSI 等多套策略独立账户同时跑
- 🪙 **多币种监控** — BTC、ETH、BNB、SOL、XRP、ADA、DOGE、AVAX
- ✅ **完整测试** — 171 条单元测试，覆盖指标、信号、模拟盘、回测指标

### 运行架构

```
┌─────────────────────────────────────────────┐
│  每 1 分钟（系统 crontab）                    │
│  src/monitor.ts                             │
│  → 拉取 K 线 → 计算 MA/RSI → 检测信号       │
│  → paper 模式：模拟下单 + 通知 AI            │
├─────────────────────────────────────────────┤
│  每 4 小时（系统 crontab）                    │
│  src/news/monitor.ts                        │
│  → 恐惧贪婪 + 市值 + 新闻过滤               │
│  → 写入 logs/news-report.json               │
│                                             │
│  每 4 小时+2分钟（OpenClaw cron）             │
│  → 触发 AI 读取报告并分析                   │
│  → 推送到 Telegram                          │
└─────────────────────────────────────────────┘
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

| 信号 | 触发条件 |
|---|---|
| **买入** | MA 短期 > 长期（多头趋势）**且** RSI < 35（超卖） |
| **卖出** | MA 短期 < 长期（空头趋势）**且** RSI > 65（超买） |
| **止损** | 持仓亏损达到 5% 自动平仓 |

### 进度

- [x] 技术指标引擎（MA + RSI）
- [x] 可插拔信号检测
- [x] 模拟盘（使用真实价格）
- [x] 新闻情绪分析（每 4 小时）
- [x] 风险管理（止损 / 最大回撤）
- [x] MACD + 成交量指标与信号
- [x] 新闻情绪门控（仓位随情绪动态调整）
- [x] 周报复盘功能（AI 深度分析，每周日 22:00）
- [x] 健康监控 + 心跳系统（每 30 分钟检查，异常告警）
- [x] 配置驱动的定时任务管理（`cron:sync` 一键同步）
- [x] 171 条单元测试
- [x] 回测引擎（夏普/最大回撤/利润因子/多策略对比）
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

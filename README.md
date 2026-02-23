# openclaw-trader

> AI-powered crypto trading bot built on [OpenClaw](https://openclaw.ai) · 基于 OpenClaw 的 AI 驱动加密货币交易机器人

---

## English

### Features

- 📊 **Technical Analysis** — MA (20/60) + RSI (14) indicator engine
- ⚙️ **Config-driven Strategy** — Edit `config/strategy.yaml`, no code changes needed
- 🗞️ **News & Sentiment** — Fear & Greed Index, CryptoPanic headlines, CoinGecko market data (every 4h)
- 🎭 **Paper Trading Mode** — Simulates trades using real market prices; tracks P&L, win rate, positions
- 🔔 **AI-triggered Signals** — Zero token cost when idle; only wakes the AI agent on signal detection
- 🛡️ **Risk Management** — Per-trade stop-loss (5%), total drawdown limit (20%), auto-pause
- 🪙 **Multi-symbol** — BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX
- ✅ **Tested** — 70 unit tests across indicators, signals, paper trading engine

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
│   ├── indicators.ts       SMA / EMA / RSI calculation
│   └── signals.ts          Signal detection engine
├── paper/
│   ├── account.ts          Virtual account (buy/sell/P&L)
│   ├── engine.ts           Stop-loss & drawdown checks
│   └── status.ts           CLI account status viewer
├── news/
│   ├── fetcher.ts          Fear & Greed, CryptoPanic, CoinGecko
│   └── monitor.ts          News scan entry point
├── notify/
│   └── openclaw.ts         OpenClaw agent notifications
└── __tests__/
    ├── indicators.test.ts
    ├── signals.test.ts
    ├── paper-account.test.ts
    └── paper-engine.test.ts
config/
└── strategy.yaml           Strategy & risk configuration
logs/
├── monitor.log
├── news-monitor.log
├── news-report.json        Latest market sentiment report
├── paper-account.json      Paper trading account state
└── state.json              Monitor run state
```

### Roadmap

- [x] Technical indicator engine (MA + RSI)
- [x] Signal detection with pluggable conditions
- [x] Paper trading mode with real prices
- [x] News & sentiment analysis (every 4h)
- [x] Risk management (stop-loss, max drawdown)
- [x] 70 unit tests
- [ ] Backtesting module
- [ ] MACD indicator support
- [ ] Live trading mode (`mode: auto`)
- [ ] Web dashboard

### License

MIT

---

## 中文

### 功能特性

- 📊 **技术分析** — MA（20/60）+ RSI（14）指标引擎
- ⚙️ **配置驱动策略** — 编辑 `config/strategy.yaml` 即可调整，无需改代码
- 🗞️ **新闻情绪分析** — 恐惧贪婪指数、CryptoPanic 新闻、CoinGecko 市场数据（每 4 小时）
- 🎭 **模拟盘模式** — 使用真实价格模拟交易，完整记录盈亏、胜率、持仓
- 🔔 **AI 信号触发** — 无信号时零 token 消耗，仅在发现信号时唤醒 AI Agent
- 🛡️ **风险管理** — 单笔止损（5%）、总亏损上限（20%）自动暂停
- 🪙 **多币种监控** — BTC、ETH、BNB、SOL、XRP、ADA、DOGE、AVAX
- ✅ **完整测试** — 70 条单元测试，覆盖指标、信号、模拟交易引擎

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
- [x] 70 条单元测试
- [ ] 回测模块
- [ ] MACD 指标支持
- [ ] 实盘自动交易（`mode: auto`）
- [ ] Web 可视化面板

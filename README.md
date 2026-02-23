# openclaw-trader

AI 驱动的加密货币量化交易机器人，基于 [OpenClaw](https://openclaw.ai) 构建。

## 特性

- 📊 技术指标监控（MA、RSI、MACD）
- ⚙️ 策略配置文件驱动，无需改代码
- 🔔 信号发现时自动通知 AI Agent 决策
- 🛡️ 内置风险控制（止损/止盈/总亏损上限）
- 🪙 支持 BTC、ETH 及主流山寨币
- 🔄 1 分钟轮询，无信号时零 AI token 消耗

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key

# 编辑策略配置
vim config/strategy.yaml

# 单次运行（测试）
npm run monitor

# 通过 OpenClaw cron 设置定时任务（1分钟）
openclaw cron add "* * * * *" "cd /path/to/openclaw-trader && npm run monitor"
```

## 策略配置

编辑 `config/strategy.yaml` 修改策略，无需重启：

```yaml
mode: "notify_only"   # notify_only: 只通知 | auto: 自动下单
symbols:
  - BTCUSDT
  - ETHUSDT
strategy:
  ma:
    short: 20
    long: 60
  rsi:
    oversold: 35      # 低于此值 = 超卖 = 买入参考
    overbought: 65    # 高于此值 = 超买 = 卖出参考
```

## 项目结构

```
src/
├── monitor.ts          # 主入口
├── exchange/
│   └── binance.ts      # 币安 API
├── strategy/
│   ├── indicators.ts   # 技术指标计算
│   └── signals.ts      # 信号判断
├── notify/
│   └── openclaw.ts     # 通知 AI Agent
└── types.ts            # 类型定义
config/
└── strategy.yaml       # 策略配置
```

## License

MIT

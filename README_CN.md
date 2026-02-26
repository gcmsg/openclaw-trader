# openclaw-trader

> 基于 [OpenClaw](https://openclaw.ai) 的 AI 驱动加密货币交易机器人 — 自动信号检测、风险管理、Binance 交易执行

[🇬🇧 English](./README.md)

---

## 简介

openclaw-trader 7×24 监控加密货币市场，通过技术分析 + 情绪分析检测交易信号，在 Binance 上执行交易（模拟盘 / Testnet / 实盘）。AI 代理（通过 OpenClaw）负责市场分析、策略决策和 Telegram 汇报 — 你定规则，它来执行。

**核心循环**（每 60 秒）：
1. 拉取 K 线 → 计算指标（EMA、RSI、MACD、ATR、VWAP、CVD）
2. 识别市场状态 → 风险收益比过滤 → 相关性检查
3. 情绪 + 新闻门控 → Kelly 公式仓位计算
4. 执行或通知 → 管理出场（止损 / 止盈 / 追踪 / ROI Table / 保本止损）

## 核心功能

### 信号检测
- **20+ 信号条件** — MA 交叉、RSI 区间、MACD 柱状、放量、CVD 买卖压力、VWAP 反弹、资金费率极端、BTC 主导率变化
- **多时间框架确认** — 1h / 4h / 1d 趋势对齐后入场
- **市场状态自适应** — 趋势 / 横盘 / 突破 / 缩仓；不同状态自动调整参数
- **可插拔策略** — YAML 配置（默认）或 TypeScript 插件（RSI 均值回归、突破策略、自定义）

### 风险管理
- **入场保护** — R:R 预过滤、入场滑点防护、相关性仓位缩减、Kelly 仓位
- **出场保护** — 止损、止盈、追踪止损（含正偏移）、ROI Table（时间衰减止盈）、分批止盈、时间止损
- **保本止损** — 盈利达阈值后自动移动止损线到入场价；`customStoploss()` 钩子支持动态逻辑
- **出场确认** — 闪崩时拒绝异常出场；`confirmExit()` 策略钩子
- **交易所原生止损** — 成交后在 Binance 挂 `STOP_LOSS_LIMIT`，Bot 崩溃也能保单
- **强制出场** — 出场订单多次超时后市价单紧急平仓
- **熔断器** — 极端回撤或 BTC 暴跌时一键停止所有交易
- **Protection Manager** — 冷却期、最大回撤守卫、止损频率守卫、低利润币种过滤

### 市场情报
- **新闻情绪** — 恐惧贪婪指数 + LLM 语义分析（通过 OpenClaw Gateway）+ 关键词评分
- **紧急暂停** — 每 10 分钟扫描 30 个高危关键词；命中后冻结交易 2 小时
- **清算热力图** — Binance 合约强平数据，多空爆仓检测
- **Reddit 情绪** — r/CryptoCurrency + r/Bitcoin 关键词分析
- **期权信号** — Binance 期权 Put/Call 比率 + 未平仓合约量
- **经济日历** — FOMC / CPI / NFP 等高风险事件门控

### 回测与优化
- **回测引擎** — 历史数据 + 夏普 / 索提诺 / Calmar / 最大回撤 / BTC Alpha / 滑点扫描
- **蜡烛内模拟** — K 线内高低价出场检查
- **贝叶斯优化** — TPE + 精英进化，8 维参数空间，Walk-Forward 验证
- **自动 Walk-Forward** — 定期自动重优化

### 运维
- **Telegram 指令** — `/profit`、`/positions`、`/balance`、`/status`、`/forcesell BTCUSDT`
- **Web 仪表盘** — 实时持仓、资金曲线、交易历史（轻量 Express 服务）
- **动态币种列表** — 每日从 Binance 按成交量/波动率自动选取
- **Watchdog** — 监控进程存活，每 30 分钟健康检查
- **日志轮转** — 每日归档，保留 30 天
- **持仓对账** — 启动时比对本地与交易所状态
- **SQLite 持久化** — 可选 `better-sqlite3` 交易历史

## 快速开始

```bash
npm install
cp .env.example .env          # 填写 Binance API Key
vim config/strategy.yaml       # 配置策略

npm run monitor                # 单次信号扫描
npm run live                   # 启动 Testnet/实盘监控
npm run paper:status           # 查看模拟盘
npm test                       # 运行 1040+ 测试
```

## 配置

### 策略配置（`config/strategy.yaml`）

```yaml
mode: "paper"                    # notify_only | paper | auto

strategy:
  ma: { short: 20, long: 60 }
  rsi: { oversold: 35, overbought: 65 }

risk:
  stop_loss_percent: 5
  take_profit_percent: 15
  position_ratio: 0.2            # 单笔仓位占总资金 20%
  break_even_profit: 0.03        # 盈利 +3% 后移止损到入场价
  minimal_roi:                   # 时间衰减止盈
    "0": 0.08
    "60": 0.04
    "120": 0.02

paper:
  initial_usdt: 1000
```

### 信号条件（`config/strategy.yaml` → `signals`）

所有条件可自由组合：

| 类别 | 条件 |
|------|------|
| **趋势** | `ma_bullish`、`ma_bearish`、`ma_crossover`、`ma_crossunder` |
| **动量** | `rsi_bullish`、`rsi_bearish`、`rsi_bullish_zone`、`rsi_overbought_exit` |
| **MACD** | `macd_bullish`、`macd_bearish`、`macd_histogram_shrinking` |
| **成交量** | `volume_surge`、`volume_low`、`cvd_bullish`、`cvd_bearish` |
| **VWAP** | `price_above_vwap`、`vwap_bounce`、`vwap_breakdown`、`price_below_vwap_lower2` |
| **资金费率** | `funding_rate_overlong`、`funding_rate_overshort` |
| **主导率** | `btc_dominance_rising`、`btc_dominance_falling` |

### 策略插件

用 TypeScript 编写代码策略：

```typescript
// src/strategies/my-plugin.ts
import type { Strategy, StrategyContext } from "./types.js";
import { registerStrategy } from "./registry.js";

const myStrategy: Strategy = {
  id: "my-plugin",
  name: "我的自定义策略",
  populateSignal(ctx) {
    if (ctx.indicators.rsi < 25 && ctx.indicators.maShort > ctx.indicators.maLong) return "buy";
    if (ctx.indicators.rsi > 75) return "sell";
    return "none";
  },
  // 可选钩子：
  // customStoploss?(position, ctx) → number | null    动态止损
  // confirmExit?(position, exitReason, ctx) → boolean  出场确认
  // shouldExit?(position, ctx) → ExitResult | null      自定义出场
  // onTradeClosed?(result, ctx) → void                  交易关闭回调
};

registerStrategy(myStrategy);
```

内置策略：`default`（YAML 条件匹配）、`rsi-reversal`（RSI 均值回归）、`breakout`（趋势突破）

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run monitor` | 单次信号扫描（cron 模式） |
| `npm run live` | 启动 Testnet/实盘监控 |
| `npm run backtest` | 回测（`--strategy`、`--days`、`--symbols`、`--slippage-sweep`） |
| `npm run backtest:compare` | 所有策略并排对比 |
| `npm run hyperopt` | 贝叶斯参数优化（`--trials`、`--walk-forward`） |
| `npm run auto-wf` | 自动 Walk-Forward 重优化 |
| `npm run analysis` | 按需市场分析报告 |
| `npm run attribution` | 信号归因（各信号组合胜率统计） |
| `npm run dashboard` | Web 仪表盘（默认 8080 端口） |
| `npm run pairlist:refresh` | 刷新动态币种列表 |
| `npm run paper:status` | 查看模拟盘状态 |
| `npm run cmd -- "/profit"` | 本地执行 Telegram 指令 |
| `npm run cron:sync` | 同步定时任务到系统 crontab |
| `npm run health:check` | 手动健康检查 |
| `npm test` | 运行全部测试 |

## 定时任务

在 `config/strategy.yaml` → `schedule:` 中配置，`npm run cron:sync` 生效。

| 任务 | 周期 | 说明 |
|------|------|------|
| `price_monitor` | 每 1 分钟 | 信号检测 + 交易执行 |
| `news_emergency` | 每 10 分钟 | 高危关键词扫描；命中暂停 2h |
| `watchdog` | 每 5 分钟 | 监控进程存活检查 |
| `news_collector` | 每 4 小时 | 完整情绪报告（F&G + LLM） |
| `health_check` | 每 30 分钟 | 任务健康状态验证 |
| `log_rotate` | 每天 0 点 | 日志归档 + 清理 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `BINANCE_API_KEY` | Binance API Key（读取 + 交易，无提现权限） |
| `BINANCE_SECRET_KEY` | Binance API Secret |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway Token（AI 通知） |
| `OPENCLAW_GATEWAY_PORT` | Gateway 端口（默认 `18789`） |

## 项目结构

```
src/
├── monitor.ts                  主循环（1 分钟 cron）
├── types.ts                    全局 TypeScript 类型
├── exchange/                   Binance REST/WS、市场数据、币种列表
├── strategy/                   指标、信号、风险过滤、保本止损、ROI Table
├── strategies/                 可插拔策略系统（接口 + 注册中心 + 插件）
├── paper/                      模拟盘引擎（账户、出场、状态）
├── backtest/                   回测引擎（数据拉取、运行、指标、报告）
├── live/                       实盘/Testnet 执行器 + 持仓对账
├── optimization/               超参数优化（贝叶斯 TPE）+ Walk-Forward
├── news/                       情绪分析（F&G、LLM、Reddit、紧急监控）
├── health/                     Watchdog、健康检查、日志轮转、熔断器
├── telegram/                   Telegram 指令处理
├── web/                        仪表盘服务
├── persistence/                SQLite 持久层（可选）
└── scripts/                    CLI 入口脚本
```

## 测试

```bash
npm test                        # 1040+ 测试，约 15 秒
npx tsc --noEmit                # TypeScript 严格模式检查
```

所有网络调用均已 mock，测试覆盖指标、信号、风险管理、订单执行、回测、优化、Telegram 指令等。

## License

MIT

# 模块协作清单 — 确保每个功能都在发挥作用

> 每次改动前/后对照此清单，确保没有模块被遗忘或断开。

## 🔴 核心管线（两条路径必须完全一致）

### 信号检测 → 过滤 → 执行

| 步骤 | 模块 | monitor.ts (cron) | live-monitor.ts (daemon) |
|------|------|:-:|:-:|
| 1. K 线获取 | DataProvider + binance.ts | ✅ | ✅ |
| 2. 统一信号引擎 | signal-engine.ts `processSignal()` | ✅ | ✅ |
| 3. 策略插件 | strategies/registry + default/rsi-reversal/breakout | ✅ | ✅ |
| 4a. Regime 感知 | regime.ts `classifyRegime()` | ✅（引擎内） | ✅（引擎内） |
| 4b. R:R 过滤 | rr-filter.ts | ✅（引擎内） | ✅（引擎内） |
| 4c. 相关性过滤 | correlation.ts | ✅（引擎内） | ✅（引擎内） |
| 4d. Protection | protection-manager.ts | ✅（引擎内） | ✅（引擎内） |
| 5. 紧急暂停 | emergency-monitor.ts | ✅ | ✅ |
| 6. 事件日历 | events-calendar.ts | ✅ | ✅ |
| 7. MTF 趋势过滤 | 手动 calculateIndicators | ✅ | ✅ |
| 8. 情绪门控 | sentiment-gate.ts + sentiment-cache.ts | ✅ | ✅ |
| 9. Kelly 仓位 | kelly.ts | ✅ | ✅ |
| 10. 执行 | paper/engine.ts (cron) / live/executor.ts (daemon) | ✅ | ✅ |
| 11. 信号历史 | signal-history.ts logSignal/closeSignal | ✅ | ✅ |
| 12. 通知 | notify/openclaw.ts | ✅ | ✅ |

**⚠️ 规则：以上表格中任何一行出现 ❌，都必须立即修复。**

### 外部数据注入（ExternalContext）

| 数据 | 来源 | monitor.ts | live-monitor.ts |
|------|------|:-:|:-:|
| CVD | order-flow.ts readCvdCache | ✅ | ✅ |
| 资金费率 | funding-rate-signal.ts | ✅ | ✅ |
| BTC 主导率 | btc-dominance.ts | ✅ | ✅ |
| 持仓方向 | paper/account.ts | ✅ | ✅ |
| 相关性 K 线 | getKlines per held symbol | ✅ | ✅ |

## 🟢 定时任务（Cron）

| 任务 | 频率 | 脚本 | 状态 |
|------|------|------|------|
| 价格监控 | 每分钟 | monitor.ts | ✅ 运行中 |
| 新闻采集 | 每 4 小时 | news/monitor.ts | ✅ 运行中 |
| 周报 | 周日 22:00 CST | report/weekly.ts | ✅ 设置完成 |
| 健康检查 | 每 30 分钟 | health/checker.ts | ✅ 运行中 |
| Watchdog | 每 5 分钟 | health/watchdog.ts | ✅ 运行中 |
| 日志轮转 | 每日 00:00 | health/log-rotate.ts | ✅ 运行中 |
| 紧急新闻 | 每 10 分钟 | news/emergency-monitor.ts | ✅ 运行中 |

## 🟡 常驻进程

| 进程 | tmux session | 脚本 | 状态 |
|------|-------------|------|------|
| Live Monitor | trader-live | live-monitor.ts | ✅ 运行中 |

## 🔵 手动/按需工具

| 工具 | 脚本 | 用途 | 上次使用 |
|------|------|------|---------|
| 回测 | backtest.ts | 策略验证 | 经常 |
| Hyperopt | hyperopt.ts | 参数优化 | 2026-02-26 |
| 市场分析 | market-analysis.ts | 09:00/21:00 分析 | 每日 |
| Mia 交易 | mia-trade.ts | 手动开平仓 | 2026-02-26 |
| 信号统计 | signal-stats.ts | 信号质量分析 | 待积累数据 |
| Drift Monitor | drift-monitor.ts | 执行偏差检测 | 未定期运行 |
| Walk-Forward | auto-wf.ts | 自动前进分析 | 未定期运行 |
| Cycle Analysis | cycle-analysis.ts | 分段周期回测 | 2026-02-26 |
| Regime Backtest | regime-backtest.ts | 自适应回测验证 | 2026-02-26 |
| Dashboard | dashboard.ts | Web 仪表盘 | 未启动 |
| Telegram Bot | telegram-bot.ts | 命令交互 | 未启动 |
| Signal Attribution | signal-attribution.ts | 信号归因 | 未使用 |

## 🔶 未接入但已开发的模块

| 模块 | 文件 | 说明 | 优先级 |
|------|------|------|--------|
| regime-params.ts | strategy/ | Regime 参数自适应 | 低（验证表明滞后，暂不接入） |
| ws-monitor.ts | scripts/ | WebSocket 实时监控 | 中（可替代轮询） |
| dashboard-server.ts | web/ | Web UI | 低 |
| telegram-bot.ts | scripts/ | TG 命令交互 | 中 |

## 📋 改动检查流程

每次修改信号相关代码时：

1. **检查双路径一致性**：monitor.ts 和 live-monitor.ts 是否都受影响？
2. **跑 `npx tsc --noEmit`**：0 errors
3. **跑 `npm test`**：全部通过
4. **重启 live-monitor**：`tmux send-keys -t trader-live C-c; sleep 2; tmux send-keys -t trader-live "npm run live" Enter`
5. **确认启动日志**：看到 `📋 统一信号引擎` 字样

---

*创建：2026-02-26 by Mia*
*目的：确保开发的每一行代码都在实际发挥作用*

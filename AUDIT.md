# 代码审计跟踪文档

> 目的：系统化替代「看到什么改什么」的ad-hoc审计。  
> 原则：同类文件用同一张检查表，跨文件模式用全局扫描覆盖。

---

## 审计方法论

### 为什么需要流程

过去的 ad-hoc 审计暴露了一个规律：**bug 总是成簇出现**。

- `side undefined` bug 同时存在于 3 个 monitor 文件
- HTTP 超时缺失：4 个 exchange 模块里有 1 个漏掉
- `saveAccount` 非原子写：account.ts 修了，mia-trade.ts 自己实现的版本没修
- `ping()` 缺失：3 个 cron 任务同时漏掉

**根因**：审计时以「文件为单位」，但 bug 实际以「模式为单位」传播。

### 两阶段审计法

```
阶段一：逐文件（按类型分组）
  → 每类文件用同一张检查表
  → 同类文件一次性批量审完，避免相同问题遗漏

阶段二：跨文件模式扫描
  → 用 grep/AST 搜索已知高风险模式
  → 不依赖「看到」，而是「主动找」
```

---

## 阶段二：跨文件模式扫描命令

每次大规模代码改动后运行一遍，直接 grep 高风险模式。

```bash
# 1. HTTP 请求无超时（.end() 前没有 .setTimeout）
grep -rn "req\.end()" src/ --include="*.ts" -l

# 2. 非原子文件写入（writeFileSync 但附近没有 renameSync）
grep -rn "writeFileSync" src/ --include="*.ts" | grep -v ".test\|renameSync\|tmp"

# 3. PaperPosition.side 未做 undefined fallback
grep -rn "positions\[.*\]?\.side" src/ --include="*.ts" | grep -v "?? \"long\"\|?? 'long'\|.test"

# 4. Telegram 通知无冷却（sendAlert / notifyError 直接调用无 Map/cooldown）
grep -rn "sendAlert\|notifyError\|notifyStatus" src/ --include="*.ts" | grep -v ".test\|cooldown\|_notify\|Map"

# 5. loadAccount/saveAccount 本地自实现（非从 account.ts 导入）
grep -rn "function loadAccount\|function saveAccount" src/ --include="*.ts" | grep -v "account.ts\|.test"

# 6. cron 脚本缺少 ping()
grep -rn "import.*heartbeat\|from.*heartbeat" src/scripts/ --include="*.ts" -L | head -20

# 7. logger 路径与文件名不符（复制粘贴错误）
grep -rn "createLogger" src/ --include="*.ts" | grep -v ".test"

# 8. Promise 未处理（不在 try/catch 且没有 .catch）
grep -rn "await " src/ --include="*.ts" | grep -v "catch\|try\|\.catch\|.test" | grep -v "//" | head -20
```

---

## 阶段一：分类检查表

### 类型 A：账户状态处理器
**文件：** `paper/account.ts`、`live/executor.ts`、`scripts/mia-trade.ts`、`telegram/command-handler.ts`

| 检查项 | 描述 |
|--------|------|
| A1 | `saveAccount` 使用原子写（.tmp → rename），无本地自实现 |
| A2 | 所有 mutation 后都调用了 `saveAccount` |
| A3 | 交易前调用 `resetDailyLossIfNeeded` |
| A4 | `pos.side` 读取时有 `?? "long"` fallback（旧数据兼容） |
| A5 | `calcTotalEquity` 调用时提供了所有持仓的价格 |
| A6 | equity <= 0 有 guard，不会进入仓位计算 |

### 类型 B：Monitor / 主循环
**文件：** `scripts/live-monitor.ts`、`scripts/ws-monitor.ts`、`monitor.ts`、`news/monitor.ts`、`news/emergency-monitor.ts`、`health/watchdog.ts`

| 检查项 | 描述 |
|--------|------|
| B1 | 每轮 poll 调用 `ping(taskName)` |
| B2 | `LiveExecutor` / `DataProvider` 在 main() 创建一次，不在 poll 里重建 |
| B3 | Telegram 通知有冷却（Map + timestamp 或 state file） |
| B4 | `process.on("unhandledRejection")` 有全局兜底 |
| B5 | 退出条件检查（checkExits）用 fresh account，不用 poll 开始时的快照 |
| B6 | 通知无冷却会导致告警轰炸（特别是 error/halt 类） |

### 类型 C：Exchange API 客户端
**文件：** `exchange/binance.ts`、`exchange/binance-client.ts`、`exchange/futures-data.ts`、`exchange/macro-data.ts`、`exchange/onchain-data.ts`、`exchange/derivatives-data.ts`、`exchange/liquidation-data.ts`、`exchange/options-data.ts`、`exchange/order-flow.ts`

| 检查项 | 描述 |
|--------|------|
| C1 | 所有 HTTP 请求有 `req.setTimeout(N, () => req.destroy())` |
| C2 | 429/418 有处理（或用 `binance-client.ts` 封装） |
| C3 | 单个请求失败不影响批量结果（`.catch(() => null)` / `Promise.allSettled`） |
| C4 | IPv4 强制（国内服务器访问部分 API 需要 `family: 4`） |
| C5 | 响应 JSON 解析有 try/catch，非预期格式不 crash |

### 类型 D：策略逻辑（纯函数）
**文件：** `strategy/signals.ts`、`strategy/signal-engine.ts`、`strategy/indicators.ts`、`strategy/regime.ts`、`strategy/rr-filter.ts`、`strategy/mtf-filter.ts`、`strategy/correlation.ts`、`strategy/break-even.ts`、`strategy/kelly.ts`、`strategy/protection-manager.ts`、`strategy/portfolio-risk.ts`、`strategy/indicators.ts`

| 检查项 | 描述 |
|--------|------|
| D1 | 空数组输入不会 `Math.min/max()` 返回 Infinity/-Infinity |
| D2 | 除法运算有零值 guard（分母为 0 → 返回 0 / NaN / Infinity 需明确） |
| D3 | NaN 不会向下游传播（关键路径上有 `isNaN` 或 fallback） |
| D4 | 外部可选字段（`signal.indicators.atr` 等）有 undefined guard |
| D5 | `positionSide` 未定义时等同于"无仓位"（不误发 buy 信号） |

### 类型 E：回测引擎
**文件：** `backtest/runner.ts`、`backtest/metrics.ts`、`backtest/walk-forward.ts`、`backtest/fetcher.ts`

| 检查项 | 描述 |
|--------|------|
| E1 | 滑点只扣一次（不在 execPrice 之外再扣 slippageUsdt） |
| E2 | 空头 PnL 符号正确：`(entryPrice - exitPrice) * qty - fee` |
| E3 | 手续费方向正确：开仓 / 平仓均从正确一方扣除 |
| E4 | Sharpe/Sortino 分母为零有 guard（返回 0） |
| E5 | 每日亏损重置用 UTC 日期（与 Binance 结算日一致） |
| E6 | 单个 K 线内 SL/TP 同时触发时有明确优先级 |

### 类型 F：配置与 Cron
**文件：** `config/loader.ts`、`scripts/sync-cron.ts`、`config/strategy.yaml`、`config/paper.yaml`

| 检查项 | 描述 |
|--------|------|
| F1 | cron 脚本用 `{ set -a; source .env; set +a; }` 导出 env 变量 |
| F2 | `timeout_minutes` ≥ cron 间隔（避免永久 warn） |
| F3 | `.secrets/` 凭证文件存在且格式正确 |
| F4 | `credentials_path` 指向的文件实际存在 |
| F5 | testnet 场景有 `testnet: true` 标记（避免 monitor.ts 误处理） |

### 类型 G：健康监控
**文件：** `health/checker.ts`、`health/watchdog.ts`、`health/heartbeat.ts`、`health/kill-switch.ts`、`health/log-rotate.ts`

| 检查项 | 描述 |
|--------|------|
| G1 | 每个 cron 任务在 watchdog 的 TASKS_TO_WATCH 里有对应条目 |
| G2 | 告警通知有冷却（持续故障不轰炸） |
| G3 | logger 路径与任务名称一致（无复制粘贴错误） |
| G4 | watchdog 自身的 timeout 阈值 ≥ 其 cron 间隔的 2 倍 |

### 类型 H：通知与外部集成
**文件：** `notify/openclaw.ts`、`news/llm-sentiment.ts`、`news/sentiment-cache.ts`、`news/sentiment-gate.ts`

| 检查项 | 描述 |
|--------|------|
| H1 | LLM 调用有超时保护，失败降级到关键词方案 |
| H2 | 情绪缓存 TTL 合理（目前 6h）且有过期判断 |
| H3 | `OPENCLAW_GATEWAY_TOKEN` 在调用前检查是否存在 |
| H4 | 紧急 halt 的触发文章有 24h 冷却（避免同一文章循环触发） |

---

## 审计进度追踪

> 状态：✅ 已完成 | 🔄 进行中 | ⬜ 待审 | ⏭ 低优先级/跳过
> 优先级：🔴 P0 核心热路径 | 🟠 P1 重要路径 | 🟡 P2 支撑模块 | ⚪ P3 工具/分析

### 类型 A — 账户状态处理器
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `paper/account.ts` | 🔴 | ✅ | — |
| `live/executor.ts` | 🔴 | ✅ | B14: checkExits stale snapshot |
| `scripts/mia-trade.ts` | 🟠 | ✅ | 非原子 saveAccount (已修) |
| `telegram/command-handler.ts` | 🟡 | ✅ | — |

### 类型 B — Monitor / 主循环
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `scripts/live-monitor.ts` | 🔴 | ✅ | 多处（见下方 bug 列表）|
| `scripts/ws-monitor.ts` | 🟠 | ✅ | B18: side undefined |
| `monitor.ts` | 🟠 | ✅ | B4: testnet 场景未过滤；B18: side undefined |
| `news/monitor.ts` | 🟡 | ✅ | — |
| `news/emergency-monitor.ts` | 🟡 | ✅ | B19: halt 循环触发 (已修) |
| `health/watchdog.ts` | 🟡 | ✅ | B6: logger 路径错误；B7: 未 ping() |

### 类型 C — Exchange API
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `exchange/binance-client.ts` | 🔴 | ✅ | — (有完整 429 处理) |
| `exchange/binance.ts` | 🔴 | ✅ | — |
| `exchange/futures-data.ts` | 🟠 | ✅ | 无超时 (已修) |
| `exchange/macro-data.ts` | 🟡 | ✅ | — |
| `exchange/onchain-data.ts` | 🟡 | ✅ | — |
| `exchange/derivatives-data.ts` | 🟡 | ✅ | — |
| `exchange/liquidation-data.ts` | 🟡 | ✅ | — |
| `exchange/options-data.ts` | 🟡 | ⬜ | |
| `exchange/order-flow.ts` | 🟡 | ⬜ | |
| `exchange/data-provider.ts` | 🟠 | ✅ | — |
| `exchange/pairlist.ts` | 🟡 | ✅ | — |
| `exchange/ws.ts` | 🟠 | ✅ | — (有指数退避重连) |

### 类型 D — 策略逻辑（纯函数）
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `strategy/signal-engine.ts` | 🔴 | ✅ | — |
| `strategy/signals.ts` | 🔴 | ✅ | — |
| `strategy/indicators.ts` | 🔴 | ⬜ | |
| `strategy/regime.ts` | 🟠 | ✅ | — |
| `strategy/rr-filter.ts` | 🟠 | ✅ | — |
| `strategy/mtf-filter.ts` | 🟠 | ✅ | — |
| `strategy/correlation.ts` | 🟠 | ✅ | — |
| `strategy/break-even.ts` | 🟡 | ✅ | — |
| `strategy/kelly.ts` | 🟡 | ✅ | — |
| `strategy/protection-manager.ts` | 🟡 | ✅ | — |
| `strategy/portfolio-risk.ts` | 🟡 | ⬜ | |
| `strategy/btc-dominance.ts` | 🟡 | ⬜ | |
| `strategy/confirm-exit.ts` | 🟡 | ⬜ | |
| `strategy/events-calendar.ts` | 🟡 | ⬜ | |
| `strategy/funding-rate-signal.ts` | 🟡 | ⬜ | |
| `strategy/market-context.ts` | 🟡 | ⬜ | |
| `strategy/recent-trades.ts` | 🟡 | ⬜ | |
| `strategy/regime-params.ts` | 🟡 | ⬜ | |
| `strategy/roi-table.ts` | 🟡 | ⬜ | |
| `strategy/signal-history.ts` | 🟠 | ✅ | — |
| `strategy/volume-profile.ts` | 🟡 | ⬜ | |

### 类型 E — 回测引擎
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `backtest/runner.ts` | 🟠 | ✅ | 双重滑点 (已修于早期 commit) |
| `backtest/metrics.ts` | 🟠 | ✅ | — |
| `backtest/walk-forward.ts` | 🟡 | ⬜ | |
| `backtest/fetcher.ts` | 🟡 | ⬜ | |
| `backtest/report.ts` | ⚪ | ⬜ | |
| `backtest/cli-args.ts` | ⚪ | ⬜ | |

### 类型 F — 配置与 Cron
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `config/loader.ts` | 🔴 | ⬜ | |
| `scripts/sync-cron.ts` | 🟠 | ✅ | B17: set -a 缺失 (已修) |
| `config/strategy.yaml` | 🟠 | ✅ | B10: timeout_minutes 不匹配 (已修) |
| `config/paper.yaml` | 🟠 | ✅ | — |

### 类型 G — 健康监控
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `health/checker.ts` | 🟠 | ✅ | B11: 通知无冷却 (已修) |
| `health/watchdog.ts` | 🟠 | ✅ | B6-B9 (已修) |
| `health/heartbeat.ts` | 🟠 | ✅ | — |
| `health/kill-switch.ts` | 🟠 | ✅ | — |
| `health/log-rotate.ts` | 🟡 | ✅ | — |

### 类型 H — 通知与外部集成
| 文件 | 优先级 | 状态 | 发现的 bug |
|------|--------|------|-----------|
| `notify/openclaw.ts` | 🟠 | ⬜ | |
| `news/llm-sentiment.ts` | 🟡 | ⬜ | |
| `news/sentiment-cache.ts` | 🟡 | ✅ | — |
| `news/sentiment-gate.ts` | 🟡 | ✅ | — |
| `news/fetcher.ts` | 🟡 | ⬜ | |
| `news/digest.ts` | 🟡 | ⬜ | |
| `news/reddit-sentiment.ts` | 🟡 | ⬜ | |

### 其他模块（待分类）
| 文件 | 优先级 | 状态 |
|------|--------|------|
| `strategies/ensemble.ts` | 🟡 | ⬜ |
| `strategies/breakout.ts` | 🟡 | ⬜ |
| `strategies/rsi-reversal.ts` | 🟡 | ⬜ |
| `strategies/default.ts` | 🟡 | ⬜ |
| `strategies/state-store.ts` | 🟡 | ⬜ |
| `paper/engine.ts` | 🟠 | ✅ | — |
| `paper/compare.ts` | ⚪ | ⬜ |
| `paper/reset.ts` | ⚪ | ⬜ |
| `paper/status.ts` | ⚪ | ⬜ |
| `persistence/db.ts` | 🟡 | ⬜ |
| `live/reconcile.ts` | 🟡 | ✅ | spot 无法对账（已知设计局限）|
| `analysis/*.ts` | ⚪ | ⬜ |
| `optimization/*.ts` | ⚪ | ⬜ |
| `report/*.ts` | 🟡 | ✅ | weekly 持仓市值未实时计算（已知简化）|
| `web/dashboard-server.ts` | ⚪ | ⬜ | 未运行，暂缓 |
| `scripts/hyperopt.ts` | ⚪ | ⬜ |
| `scripts/drift-monitor.ts` | ⚪ | ⬜ |

---

## 已发现 Bug 汇总

| # | 严重度 | 模块 | 描述 | 状态 | Commit |
|---|--------|------|------|------|--------|
| 1 | P1 | `config/long-short.yaml` | timeframe 1h→4h，macd_death_cross 事件触发永远 false | ✅ | 991f8b0 |
| 2 | P0 | `scripts/live-monitor.ts` | DataProvider 每轮重建，60x API 浪费 | ✅ | bbc3159 |
| 3 | P1 | `strategy/rr-filter.ts` | 微价币 R:R 显示"$0/$0" | ✅ | bbc3159 |
| 4 | P1 | `scripts/live-monitor.ts` | 相同 rejected 信号每 60s 刷屏 | ✅ | bbc3159 |
| 5 | P1 | `monitor.ts` | testnet 场景被 paper monitor 处理，账户双写 | ✅ | 932048c |
| 6 | P1 | `health/watchdog.ts` | logger 路径写成 health_check.log | ✅ | 05bd63b |
| 7 | P2 | `health/checker.ts` | 未调用 ping()，健康快照永远"从未执行" | ✅ | 05bd63b |
| 8 | P2 | `health/watchdog.ts` | 未调用 ping() | ✅ | 05bd63b |
| 9 | P2 | `scripts/refresh-pairlist.ts` | 未调用 ping() | ✅ | 05bd63b |
| 10 | P2 | `config/strategy.yaml` | timeout_minutes 与 cron 频率不匹配 | ✅ | 05bd63b |
| 11 | P2 | `health/checker.ts` | 告警通知无冷却，持续故障轰炸 Telegram | ✅ | e525a0b |
| 12 | P2 | `scripts/live-monitor.ts` | live-monitor 崩溃无人发现（不在 watchdog）| ✅ | 5820f39 |
| 13 | P3→P2 | `scripts/live-monitor.ts` | LiveExecutor 每轮重建，_exitRejectionLog 冷却无效 | ✅ | c3fc498 |
| 14 | P1 | `scripts/live-monitor.ts` | checkExits 用过期 account 传给 checkOrderTimeouts | ✅ | d51124b |
| 15 | P1 | `scripts/live-monitor.ts` | max_total_loss_percent 从未执行（20% 熔断摆设）| ✅ | cf1eab4 |
| 16 | P2 | `scripts/live-monitor.ts` | 总亏损告警无冷却，每 60s 发一次 | ✅ | 8017f3b |
| 17 | P1 | `scripts/sync-cron.ts` | cron source .env 不 export 给子进程 | ✅ | d80a5a1 |
| 18 | P2 | `live-monitor` / `ws-monitor` / `monitor.ts` | PaperPosition.side undefined 被当成无仓位 | ✅ | e232229 / d0c9077 |
| 19 | P2 | `news/emergency-monitor.ts` | 同一文章每 2h 循环触发 halt | ✅ | cb659ac |
| 20 | P2 | `scripts/mia-trade.ts` | 本地 saveAccount 绕过原子写保护 | ✅ | f1e78be |
| 21 | P2 | `exchange/futures-data.ts` | fetchJson 无超时，API 挂起时整个脚本卡死 | ✅ | ceeaaaa |

---

## 审计节奏建议

| 场景 | 做什么 |
|------|--------|
| 每次新功能合并 | 对修改涉及的文件类型，跑对应检查表 |
| 每周一次 | 跑「阶段二：跨文件模式扫描」全套 grep |
| 审计 session | 从进度表里取 2-3 个 ⬜ 文件，用检查表逐项过 |
| 发现新 bug 模式 | 立即加入「阶段二 grep 命令」和对应检查表 |

---

*文档创建：2026-03-02 by Mia*  
*上次更新：2026-03-02*

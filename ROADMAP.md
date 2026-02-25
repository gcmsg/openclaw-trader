# openclaw-trader Roadmap

> 最后更新：2026-02-25 · 基于全面代码审计 + 交易员视角评估  
> 原则：先修破洞，再造武器，最后优化细节

---

## ✅ Phase 0 — 修复致命问题（已完成）

- [x] P0.1 Regime 感知驱动信号执行（breakout_watch 跳过 / reduced_size 减仓）
- [x] P0.2 出场逻辑：`macd_histogram_shrinking` + `rsi_overbought_exit`
- [x] P0.3 回测配置修正：真实滑点 + `--slippage-sweep` 滑点敏感性
- [x] P0.4 BTC Benchmark + Calmar 比率 + Alpha

---

## ✅ Phase 1 — 核心 Alpha 提升（已完成）

- [x] P1.1 R:R 入场预过滤（`risk.min_rr`，可选）
- [x] P1.2 CVD 累计成交量差值（K 线近似 + aggTrade WebSocket 框架）
- [x] P1.4 相关性过滤默认开启（阈值 0.75，连续缩减）
- [x] P1.5 资金费率逆向信号（10 分钟缓存）

---

## ✅ Phase 2 — 风险与归因（已完成）

- [x] P2.1 信号归因分析（`npm run attribution`）
- [x] P2.2 Kelly 动态仓位（半 Kelly，样本 < 10 退化固定）
- [x] P2.3 VWAP 日内（±1σ/±2σ，6 个信号条件）
- [x] P2.4 BTC 主导率 30 天趋势信号

---

## ✅ Phase 3 — 运维加固（已完成）

- [x] P3.1 Watchdog：price_monitor 超 3 分钟告警，30 分钟冷却
- [x] P3.2 日志轮转：每日 0 点，>20MB/24h 归档，30 天保留
- [x] P3.3 持仓对账：live-monitor 启动比对本地 vs 交易所
- [x] P3.4 突发新闻监控：30 个高危词，≥2 触发 halt，2 小时自动过期

---

## 🔴 Phase 3.5 — 关键 Bug 修复（立即）

> 代码审计发现的硬伤，影响生产正确性，必须在 v1.0 前全部修复

### ✅ B1 持仓对账是空壳 — **已修复** (commit `b167e77`)
`executor.getExchangePositions()` 调用 `/fapi/v2/positionRisk`，live-monitor.ts 启动时传入 reconcile。

---

### ✅ B2 CVD 是 K 线近似，信号质量低 — **已修复** (commit `084607c`)
`order-flow.ts` aggressor 符号修正（m=true=卖方主动→bearish）；live-monitor.ts 启动 CvdManager WebSocket；monitor.ts 读 cvd-state.json 缓存（<5min 有效）覆盖 K 线近似值。

---

### ✅ B3 LLM 情绪实际上是关键词降级 — **已修复** (commit `084607c`)
`news/monitor.ts` 在 news_collector 完成后自动调 Gateway LLM → `writeSentimentCache()`；不再依赖手动触发。

---

### ✅ B4 没有 SIGTERM 优雅退出 — **已修复** (commit `b167e77`)
live-monitor.ts 注册 SIGTERM/SIGINT，完成当前轮次后退出。

---

### ✅ B5 Binance 限速无保护 — **已修复** (commit `084607c`)
`binance-client.ts` 令牌桶（600 req/min），HTTP 429 自动识别并暂停队列。

---

### ✅ B6 ATR 动态止损未接入 live 模式 — **已修复** (commit `b167e77`)
`executor.ts` handleBuy/handleShort 使用 `avgPrice ± signalAtr × multiplier` 计算止损；fallback 到 stop_loss_percent。

---

### ✅ B7 paper 账户关闭信号时 pnl 计算未扣手续费 — **已验证无问题**
`handleSell`：`pnl = netUsdt - costBasis`，`netUsdt = grossUsdt - totalFee`  
`handleCover`：`pnl = (entryPrice - avgPrice) × execQty - totalFee`  
`closeSignal(sigHistId, e.trade.price, reason, e.trade.pnl)` 直接使用已扣费的 pnl，无需额外修复。

---

---

## 🔵 Phase F — Freqtrade 借鉴实现（v0.3 优先项）

> 通过对比 Freqtrade / NautilusTrader / Hummingbot / Jesse 源码，梳理出值得直接借鉴的设计。
> 核心参考：[freqtrade/freqtrade](https://github.com/freqtrade/freqtrade)（~40k stars，7年生产验证）

### F1 ROI Table 时间衰减止盈 🔴 **高优先级**
**问题**：固定 `take_profit_percent: 10%` 大多数情况等不到，导致"看着涨然后全跌回来"  
**Freqtrade 设计**：`minimal_roi` 时间衰减表，持仓越久目标越低  
```yaml
minimal_roi:
  "0":   0.08   # 刚开仓：等 8% 再走
  "60":  0.04   # 持仓 1h：4% 就走
  "120": 0.02   # 持仓 2h：2% 就走
  "240": 0.01   # 持仓 4h：1% 就走
  "480": 0.00   # 持仓 8h：保本就走
```
**预期效果**：实测比固定止盈提升 15-25% 盈利交易比例  
**实现位置**：`types.ts` + `engine.ts` / `executor.ts` checkExits  
**对应分批止盈**：可与 `take_profit_stages` 融合为统一出场逻辑

---

### F2 订单超时 + 部分成交处理 🔴 **高优先级**
**问题**：当前下单后完全不检查成交状态；PARTIALLY_FILLED 会永远挂着；下单失败无重试  
**Freqtrade 设计**：`unfilledtimeout` 买单 N 分钟未成交→自动取消；卖单→降价重试  
**实现设计**：
- `executor.ts`：`pollOrderStatus(orderId, timeoutMs)` — 轮询到 FILLED/CANCELLED/PARTIALLY_FILLED
- 部分成交：按实际 `executedQty` 更新持仓，取消剩余部分
- 订单超时（默认 5 分钟）：市价单按当前价补单；限价单取消并重下
- `live-monitor.ts`：启动时扫描 `account.openOrders`，处理遗留未成交单

---

### F3 回测/实盘统一策略层 🟡 **中优先级**
**问题**：`monitor.ts`（实盘）和 `backtest/runner.ts`（回测）是两套信号生成代码，容易不同步  
**NautilusTrader 原则**：策略代码只写一次，通过切换 Data Engine 区分实盘/回测  
**实现方向**：
- 抽取 `src/strategy/signal-engine.ts` —— 纯函数：`(klines, indicators, config) → Signal[]`
- `monitor.ts` 和 `runner.ts` 都调用同一 `signal-engine.ts`，消除逻辑分叉
- 中期重构，不阻塞当前开发

---

### F4 `confirm_trade_entry()` 防闪崩确认 🟡 **中优先级**
**问题**：信号触发时价格可能已经大幅偏离（新闻闪崩/滑点），入场前无最终确认  
**Freqtrade 设计**：`confirm_trade_entry()` 回调 — 检查当前价与信号价偏差 > N% 则取消  
**实现**：`executor.ts` handleBuy 前加 `entryPriceSlippage` 检查（默认 0.5%，可配置）

---

### F5 Hummingbot 订单状态机 🟡 **中优先级**
**问题**：当前无订单生命周期追踪，进行中的订单状态不透明  
**Hummingbot 设计**：`PENDING_CREATE → OPEN → PARTIALLY_FILLED → FILLED/CANCELLED`  
**实现**：`account.ts` 扩展 `openOrders: Record<string, OrderState>`，持久化到 JSON

---

### F6 SQLite 交易记录数据库 🟢 **低优先级**
**问题**：`signal-history.jsonl` 是 append-only，无法高效查询/聚合  
**Freqtrade 设计**：SQLite 存储所有 Trade 记录，支持任意维度查询  
**评估**：当前 JSONL 在 <1000 笔规模够用；100 笔后考虑迁移

---

### F7 HyperOpt 策略参数自动优化 🟢 **低优先级**
**问题**：RSI 阈值/MA 周期/止损比例目前手动调参，效率低  
**Freqtrade 设计**：HyperOpt 在参数空间内做贝叶斯优化，自动找最优区间  
**实现方向**：`scripts/hyperopt.ts` — 网格搜索 + backtest runner，按 Sharpe 排序输出  
**前提**：需 Walk-Forward 验证（P4.3）防止过拟合

---

## 🟠 Phase 4 — 信号质量提升（需要 50+ 真实交易记录）

### P4.1 信号统计分析
**前提**：`logs/signal-history.jsonl` 积累 ≥ 50 笔已关闭交易  
**目标**：`getSignalStats()` 分析胜率/盈亏比/最优入场时段；输出排行榜供策略迭代

### P4.2 真实 CVD（aggTrade WebSocket）
**目标**：`CvdManager` 接入真实逐笔成交流，替换 K 线近似  
框架已有（`order-flow.ts`），需要接入 Binance aggTrade 流并持久化状态

### P4.3 Walk-Forward 回测验证
**目标**：前 70% 样本调参，后 30% 验证，滚动推进 6 次  
防止回测过拟合；输出 OOS（样本外）净值曲线

### P4.4 Monte Carlo 风险模拟
**目标**：用历史胜率/盈亏分布模拟 1000 次账户路径  
输出：最大连续亏损次数、99% 置信区间内最大回撤

### P4.5 LLM 情绪自动化闭环
**目标**：`news_collector` 完成后自动调用 OpenClaw Gateway LLM 分析 → 写缓存  
当前是手动触发；应当 24h 内至少自动分析 2 次

### P4.6 支撑阻力算法升级
**现状**：Pivot Point 用近期高低点，无成交量加权，假信号多  
**目标**：Volume Profile（价格成交量分布）+ 历史多次测试次数加权

---

## 🟡 Phase 5 — 进阶功能（外部条件就绪时）

### P5.1 订单簿深度分析
大单挂墙（>100 BTC 买单）/ 大单撤单 / 买卖压力比  
需要 Binance WebSocket 订单簿流（Level 2）

### P5.2 波动率自适应参数
BTC 年化波动率 >80% → 宽 MA 周期；<40% → 窄 MA 周期  
前提：P4.3 Walk-Forward 先验证基础参数有效性

### P5.3 清算热力图（Coinglass）
大量强平聚集价位 = 价格磁铁，可作为止盈目标参考  
前提：Coinglass API 评估成本（目前需付费）

### P5.4 社交情绪监控（Twitter/Reddit）
比新闻领先 2-4 小时；Twitter API 成本较高，需评估 ROI

### P5.5 多策略自动切换
根据当前 Regime（趋势/横盘/高波动）自动选择最优策略配置  
前提：需要 P4.1 信号统计 + P4.3 Walk-Forward 验证

### P5.6 Web 实时仪表盘
持仓状态 / 实时 P&L / 信号历史 / 资金曲线可视化  
已有 `report/dashboard.ts` 基础框架

---

## 📦 v1.0 发布标准

> 满足以下所有条件方可标记 v1.0

### 必要条件（Must Have）
- [x] **B1-B7 全部 bug 修复** ✅（commits `b167e77`, `084607c`）
- [x] SIGTERM 优雅退出（B4）✅
- [ ] 信号历史 ≥ 50 笔已关闭 testnet 交易（P4.1 数据前提）
- [ ] Walk-Forward 验证至少一套策略有正的 OOS 收益（P4.3）
- [ ] live-monitor 持续运行 ≥ 7 天无崩溃

### 推荐条件（Should Have）
- [x] 真实 CVD 接入（B2）✅
- [x] LLM 情绪自动化（B3）✅
- [ ] Monte Carlo 风险报告（P4.4）

### 不阻塞发布（Nice to Have）
- [ ] 订单簿深度（P5.1）
- [ ] Web 仪表盘（P5.6）
- [ ] 社交情绪（P5.4）

---

## 当前项目状态（2026-02-25 22:xx CST）

| 指标 | 数值 |
|------|------|
| 测试覆盖 | **489 tests passing** |
| TypeScript errors | **0** |
| ESLint warnings | **0** |
| 最新 commit | `084607c` |
| Testnet 状态 | 🟢 运行中（tmux: trader-live） |
| Phase 0-3 | ✅ 全部完成 |
| Phase 3.5 Bug | ✅ B1-B7 全部修复/验证 |
| 总体评分 | **7.2/10** → v1.0 目标 **8.5/10** |

---

*创建：2026-02-25 by Mia*  
*基于全面代码审计和交易员视角评估*

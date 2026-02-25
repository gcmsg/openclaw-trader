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

### B1 持仓对账是空壳 ⚠️ **高危**
**现状**：`reconcile.ts` 中 `reconcilePositions(account, [])` 第二参数永远是空数组  
真正的交易所持仓从未读取，对账形同虚设

**修复**：`live-monitor.ts` 启动时调用 `executor.getExchangePositions()` → 传入 reconcile

---

### B2 CVD 是 K 线近似，信号质量低 ⚠️ **高危**
**现状**：用 `close > open ? +volume : -volume` 近似 CVD，误差极大  
真实 CVD 需要 aggTrade 逐笔成交（买方主动 vs 卖方主动）

**修复**：实现 aggTrade WebSocket → CvdManager 真实计算

---

### B3 LLM 情绪实际上是关键词降级 ⚠️ **中危**
**现状**：`evaluateSentimentGate()` 优先读 6h 缓存，但缓存通常是空的  
降级到关键词计数（24 牛 / 30 熊），不是真正的语义分析  
真正的 LLM 分析只在我手动调用时写入，且 6h 后过期

**修复**：晚间分析脚本运行后自动写入缓存；或在 `news_collector` 触发后调用 Gateway LLM

---

### B4 没有 SIGTERM 优雅退出
**现状**：`Ctrl+C` 或 `kill` 直接终止进程，进行中的订单可能留下未确认状态  
**修复**：在 `live-monitor.ts` 和 `monitor.ts` 注册 `SIGTERM/SIGINT` handler，完成当前轮次后退出

---

### B5 Binance 限速无保护
**现状**：高并发信号时可能触发 Binance 1200 weight/min 限制，当前无全局速率控制  
**修复**：`binance-client.ts` 增加请求队列 + 权重计数；超限时自动等待

---

### B6 ATR 动态止损未接入 live 模式
**现状**：`atr_position` 配置了基于 ATR 的仓位大小，但止损距离仍用固定 `stop_loss_percent`  
应当用 `ATR × multiplier` 动态计算止损价，在高波动时自动放宽

**修复**：`engine.ts` / `executor.ts` 在开仓时计算 ATR 止损并写入持仓

---

### B7 paper 账户关闭信号时 pnl 计算未扣手续费
**现状**：`closeSignal()` 写入的 `pnl` 直接用传入值，但 paper 引擎的 pnl 扣除了手续费  
live-monitor.ts 的 checkExits 没有传正确的 pnl

**修复**：`checkExits` 使用出场交易的实际 `pnl`（含手续费）传给 `closeSignal`

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
- [ ] **B1-B7 全部 bug 修复**
- [ ] 信号历史 ≥ 50 笔已关闭 testnet 交易（P4.1 数据前提）
- [ ] Walk-Forward 验证至少一套策略有正的 OOS 收益（P4.3）
- [ ] SIGTERM 优雅退出（B4）
- [ ] live-monitor 持续运行 ≥ 7 天无崩溃

### 推荐条件（Should Have）
- [ ] 真实 CVD 接入（P4.2）
- [ ] LLM 情绪自动化（P4.5）
- [ ] Monte Carlo 风险报告（P4.4）

### 不阻塞发布（Nice to Have）
- [ ] 订单簿深度（P5.1）
- [ ] Web 仪表盘（P5.6）
- [ ] 社交情绪（P5.4）

---

## 当前项目状态（2026-02-25 21:xx CST）

| 指标 | 数值 |
|------|------|
| 测试覆盖 | **479 tests passing** |
| TypeScript errors | **0** |
| ESLint warnings | **0** |
| 最新 commit | `3921d38` |
| Testnet 状态 | 🟢 运行中（tmux: trader-live） |
| Phase 0-3 | ✅ 全部完成 |
| 已知 Bug | 7 项（B1-B7）待修复 |
| 总体评分 | **6.8/10** → v1.0 目标 **8.5/10** |

---

*创建：2026-02-25 by Mia*  
*基于全面代码审计和交易员视角评估*

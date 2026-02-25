# openclaw-trader Roadmap

> 基于 2026-02-25 全面评审，从交易员视角排列优先级  
> 原则：先修破洞，再造武器，最后优化细节

---

## Phase 0 — 修复致命问题（立即）

> **不修这些，后续所有开发都建立在错误基础上**

### P0.1 Regime 感知真正驱动信号执行
**现状**：`classifyRegime()` 已存在，但结果只影响 Telegram 通知里的"信号强度"标签，
不阻止实际开仓。市场 70% 时间横盘，等于 70% 的信号是噪声。

**目标**：在 `monitor.ts` / `backtest/runner.ts` 的信号决策路径中接入 regime 判断：
- `signalFilter = "breakout_watch"` → 跳过所有开仓信号
- `signalFilter = "reduced_size"` → 仓位减半
- 仅在趋势明确（ADX > 25 + Bollinger 扩张）时正常开仓

**验收**：回测中横盘区间的开仓次数 ≤ 趋势区间的 20%

---

### P0.2 出场逻辑升级
**现状**：卖出信号只有 `ma_bearish`（EMA20 < EMA60），从最高点回撤 5-10% 后才离场，
几乎把所有浮盈都还回去。

**目标**：新增两类出场信号：
1. **动量衰竭出场**：MACD histogram 连续 3 根收缩 + RSI 从超买区回落 → 趋势减弱，减仓
2. **RSI 超买离场**：RSI > 75 时部分止盈（触发 take_profit_stages 第一档）

对应 `config/strategy.yaml` 新增 `sell` 可选条件：
`macd_histogram_shrinking`（新信号检测器）+ `rsi_overbought_exit`

**验收**：历史回测中平均持仓时长缩短，平均出场点位更接近阶段高点

---

### P0.3 回测配置修正（止损 + 滑点）
**现状**：testnet 场景 `slippage_percent: 0`，`stop_loss_percent: 5`。
回测结果虚假乐观，与真实交易差距巨大。

**目标**：
- 默认场景 slippage 改为 `0.05`（市价单典型滑点）
- 提供两套 stop_loss 预设：
  - 紧止损 `2.5%`（1h 图，快进快出）
  - 宽止损 `5%`（4h 图，趋势跟随）
- 回测报告新增"滑点敏感性分析"（slippage = 0 / 0.05 / 0.1 / 0.2% 各跑一次对比）

---

### P0.4 回测 Benchmark 对比（BTC Buy & Hold）
**现状**：回测报告无基准对比，无法判断是否有 alpha。

**目标**：`BacktestMetrics` 新增：
- `benchmarkReturn`：同期 BTC 简单持有收益率
- `alpha`：策略收益 - BTC 收益
- `calmarRatio`：年化收益 / 最大回撤（比夏普更适合加密）

周报和 Dashboard 同步展示。

---

## Phase 1 — 核心 Alpha 提升（1-2 周）

> **影响每笔交易质量的关键功能**

### P1.1 入场前风险/回报预检查（R:R Filter）
**逻辑**：
```
距最近阻力位（止盈目标）/ 距最近支撑位（止损距离）< 1.5 → 拒绝信号
```
利用已有的 Pivot Point 支撑/阻力位，在 `detectSignal()` 后、实际开仓前增加一道过滤。

已具备：`pivotPP / pivotS1 / pivotR1` 来自 `estimateKeyLevels()`  
需要：在 `monitor.ts` 的 sentiment gate 之后、`handleSignal()` 之前接入

---

### P1.2 累计成交量差值（CVD）
**为什么重要**：价格上涨但 CVD 下降 = 假突破（被动成交推上去，没有主动买盘）。  
这是区分"真趋势"和"做市商拉盘"的核心指标。

**实现**：
- `src/exchange/order-flow.ts`：从 WebSocket 逐笔成交（`aggTrade`）累计 CVD
- 计算方法：买方主动成交 +volume，卖方主动成交 -volume，累计求和
- 新信号条件：`cvd_bullish`（近 N 笔 CVD > 0）/ `cvd_bearish`
- 整合进 `Indicators` 类型和 `calculateIndicators()`

---

### P1.3 交易所净流入/流出
**数据源**：CryptoQuant 提供免费 API（有限频次）；  
备用：从 on-chain 数据推算（已有 `onchain-data.ts`）

**目标**：
- 获取 BTC/ETH 7 日交易所净流入数据
- 净流入 > 阈值（大量币从冷钱包转入交易所）→ 潜在卖压，买入信号降权
- 整合进 `market-analysis.ts` 报告和 sentiment gate

---

### P1.4 相关性过滤默认开启
**现状**：`correlation_filter` 已实现但注释掉，BTC/ETH/BNB/SOL 相关性 >0.85。

**目标**：
- 在 `config/strategy.yaml` 默认开启，阈值 0.75
- 连续相关性仓位缩减（已有 `calcCorrelationAdjustedSize()`）正式接入主流程
- 回测中验证：开启后最大回撤是否降低

---

### P1.5 资金费率逆向策略
**逻辑**：资金费率极端代表市场严重偏向一侧，往往是反转前兆：
- 资金费率 > 0.3% → 多头极度拥挤 → 逆向做空信号
- 资金费率 < -0.15% → 空头极度拥挤 → 逆向做多信号

**实现**：
- `src/strategy/funding-rate-signal.ts`：新信号生成器
- 可选接入主策略作为辅助信号，或作为独立的 `funding-reversal` 策略场景

---

## Phase 2 — 风险与归因（2-3 周）

> **让我真正理解"为什么赚/亏"**

### P2.1 交易归因分析（Signal Attribution）
**目标**：分析每种信号组合的历史盈亏贡献：
- 哪种 `(buy_conditions, sell_conditions)` 组合胜率最高？
- 哪个 Regime 下该策略有正期望值？
- 一目了然告诉我：该强化什么、该砍掉什么

**实现**：`src/scripts/signal-attribution.ts`，读取 `signal-history.jsonl`，
按信号组合分组统计，输出排行榜

---

### P2.2 Kelly 公式仓位（可选模式）
**现状**：固定 `position_ratio: 0.2`，无论过去信号质量如何都一样大仓。

**目标**：基于最近 N 笔交易的真实胜率和盈亏比，动态计算 Kelly 仓位：
```
Kelly% = W - (1-W) / R
W = 胜率, R = 盈亏比
```
使用半 Kelly（× 0.5）降低方差。

作为 `risk.position_sizing: "kelly"` 的可选模式，不影响默认行为。

---

### P2.3 VWAP（成交量加权均价）
**为什么机构都用**：VWAP 是当日平均成本，价格在 VWAP 上方 = 多头主导，下方 = 空头主导。
机构在 VWAP 附近挂大单，VWAP 回踩往往是最好的加仓点。

**实现**：
- 日内 VWAP 从 WebSocket 逐K线累计
- VWAP 偏差带（±1σ、±2σ）作为动态支撑阻力
- 新信号条件：`price_above_vwap` / `vwap_bounce`

---

### P2.4 BTC 主导率趋势信号
**数据已有**：`market-analysis.ts` 已获取 `btcDominance`

**目标**：
- 追踪主导率 7 日趋势
- 主导率上升（BTC 强于山寨）→ 山寨减仓警告
- 主导率下降且 BTC 稳 → 山寨行情信号
- 整合进信号过滤和市场分析报告

---

## Phase 3 — 运维加固（持续）

> **让系统可以不间断运行，出问题有人知道**

### P3.1 Monitor 自监控（Watchdog）
**现状**：`price_monitor` cron 每分钟跑，但没有机制检测它是否真的在跑。

**目标**：
- 在 `health/heartbeat.ts` 中新增 `checkCronAlive()`：
  距上次 `ping("price_monitor")` 超过 3 分钟 → 发 Telegram 告警
- 在 OpenClaw heartbeat 中加入该检查（已有 `HEARTBEAT.md`）

---

### P3.2 日志轮转
**现状**：`logs/monitor.log` 无限增长，时间长了磁盘撑满。

**目标**：
- 使用 `logrotate` 或手写日志滚动逻辑（每天一个文件，保留 30 天）
- 清理 7 天前的 `logs/paper-spot-*.json` 备份

---

### P3.3 持仓启动恢复
**现状**：服务器重启后，本地 `paper-spot.json` 的持仓可能与交易所实际持仓不一致。

**目标**：
- `live-monitor.ts` 启动时调用 `syncBalance()` + `client.getOpenOrders()`
- 对比本地账户和交易所持仓，差异超过 5% → 告警并暂停，等待手动确认
- 自动同步：交易所有但本地没有的持仓 → 写入本地账户

---

### P3.4 新闻实时 Webhook（升级情绪时效性）
**现状**：`news_collector` 每 4 小时跑一次，重大新闻可能 3.5 小时后才被感知。

**目标**：
- 接入 CryptoPanic Webhooks 或轮询（免费 API，5min 间隔）
- 检测到带 `important` 标签的新闻 → 立即触发 LLM 分析 → 更新 sentiment cache
- 突发性负面新闻（hack / ban / SEC 起诉）→ 立即暂停所有开仓信号

---

## Phase 4 — 进阶功能（条件成熟时）

> **需要数据积累或外部条件就绪**

### P4.1 信号统计分析（`getSignalStats()`）
**前提**：需要 50+ 笔真实交易记录  
**目标**：分析历史信号质量，找出最优参数区间，为策略迭代提供数据支撑

### P4.2 波动率自适应参数
**逻辑**：BTC 年化波动率 >80% 时用更宽的 MA 周期（减少噪声），<40% 时用更窄的  
**前提**：需要 P0.3（回测配置修正）先完成，验证不同参数在不同 VIX 区间的表现

### P4.3 清算热力图（Coinglass）
**逻辑**：大量强平订单聚集的价位 = 价格磁铁  
**前提**：Coinglass API 需要付费，或找到可靠的免费替代源

### P4.4 社交情绪监控
**逻辑**：Twitter/Reddit 情绪比新闻领先 2-4 小时  
**前提**：Twitter API 现在价格很高，需要评估成本效益

---

## 优先级总览

```
P0（立即修）     → Regime驱动信号 · 出场逻辑 · 回测配置 · Benchmark
P1（本周）       → R:R预检查 · CVD · 交易所流入 · 相关性开启 · 资金费率策略
P2（下周）       → 归因分析 · Kelly仓位 · VWAP · 主导率信号
P3（持续维护）   → Watchdog · 日志轮转 · 持仓恢复 · 新闻Webhook
P4（条件成熟）   → 信号统计 · 自适应参数 · 清算热力图 · 社交情绪
```

---

## 当前项目状态（2026-02-25）

| 指标 | 数值 |
|------|------|
| 测试覆盖 | 366 tests passing |
| TypeScript errors | 0 |
| ESLint warnings | 0 |
| 最新 commit | 9cc7573 |
| Testnet 状态 | 就绪（余额 $4993） |
| 总体评分 | **6.0/10** → 目标 **8.5/10** |

---

*创建：2026-02-25 by Mia*  
*基于全面代码审计和交易员视角评估*

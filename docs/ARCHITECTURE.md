# openclaw-trader 产品架构文档

> 基于代码审计生成，与实际代码保持一致。

---

## 目录

1. [项目定位与设计理念](#1-项目定位与设计理念)
2. [系统架构总览](#2-系统架构总览)
3. [信号管线详解](#3-信号管线详解)
4. [执行引擎详解](#4-执行引擎详解)
5. [配置体系](#5-配置体系)
6. [数据流与存储](#6-数据流与存储)
7. [定时任务体系](#7-定时任务体系)
8. [风控体系](#8-风控体系)
9. [辅助工具](#9-辅助工具)
10. [审计发现](#审计发现)

---

## 1. 项目定位与设计理念

### 1.1 项目是什么

openclaw-trader 是一套**加密货币量化交易系统**，核心定位是「**感知 + 执行工具**」，而非全自动决策系统。

系统设计遵循三方分工原则：

```
┌─────────────────────────────────────────────────────────────┐
│                     三方角色分工                              │
│                                                             │
│  openclaw-trader（系统）                                     │
│    └── 感知工具：行情采集、指标计算、信号过滤、风险检查        │
│          ↓ 信号通知（Telegram）                              │
│  AI Agent                                                     │
│    └── 解读信号、综合宏观判断、提出建议                       │
│          ↓ 汇报 + 建议                                       │
│  The User (final decision maker)                              │
│    └── 审批交易、调整策略参数、最终拍板                       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心原则

| 原则 | 说明 |
|------|------|
| **不自动开仓（主网）** | 实盘信号仅通知，由用户授权后执行 |
| **testnet 除外** | Testnet 场景可自动下单，用于策略验证 |
| **信号需授权** | live-monitor 在实盘模式下需配置 `allowed: true` 才执行 |
| **多层防护** | Kill Switch / Emergency Halt / Daily Loss Limit / Protection Manager |

### 1.3 技术栈

- 语言：TypeScript（ESM 模块）
- 运行时：Node.js v25+
- 行情数据：Binance REST API
- 配置：YAML 三层合并
- 持久化：JSON 文件（原子写入）+ SQLite（可选，`G5`）
- 通知：Telegram Bot（via openclaw 通知中心）

---

## 2. 系统架构总览

### 2.1 数据流 ASCII 架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         openclaw-trader 数据流                                │
│                                                                              │
│  ┌──────────────┐                                                            │
│  │ Binance API  │                                                            │
│  │ (REST/WS)    │                                                            │
│  └──────┬───────┘                                                            │
│         │ K线数据（1h + 4h MTF）                                              │
│         ▼                                                                    │
│  ┌──────────────────┐                                                        │
│  │  DataProvider    │  批量拉取 + 内存缓存（减少重复 API 请求）               │
│  │  data-provider.ts│                                                        │
│  └──────┬───────────┘                                                        │
│         │ Kline[]                                                            │
│         ▼                                                                    │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                 指标计算（calculateIndicators）            │               │
│  │  EMA(20/60) · RSI(14) · MACD(12/26/9) · ATR · VWAP · CVD │               │
│  │  indicators.ts                                           │               │
│  └──────┬───────────────────────────────────────────────────┘               │
│         │                                                                    │
│         │ 注入外部数据（资金费率 · BTC主导率 · CVD缓存 · 持仓方向）            │
│         ▼                                                                    │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │              统一信号引擎 processSignal()                  │               │
│  │  signal-engine.ts                                        │               │
│  │                                                          │               │
│  │  策略插件选择 → 信号检测 → Regime过滤 → R:R过滤            │               │
│  │  → 相关性过滤 → Protection Manager                        │               │
│  └──────┬───────────────────────────────────────────────────┘               │
│         │                                                                    │
│         │ 后续过滤链（在 monitor.ts / live-monitor.ts 中执行）                │
│         ▼                                                                    │
│  ┌──────────────────────┐   ┌──────────────────────────────────────┐        │
│  │  紧急暂停检查         │   │  事件日历风险控制                     │        │
│  │  readEmergencyHalt() │   │  checkEventRisk()                   │        │
│  └──────┬───────────────┘   └──────┬───────────────────────────────┘        │
│         │                          │                                         │
│         ▼                          ▼                                         │
│  ┌──────────────────────┐   ┌──────────────────────────────────────┐        │
│  │  MTF 趋势过滤        │   │  情绪门控                             │        │
│  │  4h EMA 多空判断     │   │  evaluateSentimentGate()            │        │
│  └──────┬───────────────┘   └──────┬───────────────────────────────┘        │
│         │                          │                                         │
│         └──────────┬───────────────┘                                         │
│                    ▼                                                         │
│  ┌──────────────────────────────────────┐                                   │
│  │         Kelly 仓位计算               │                                   │
│  │         calcKellyRatio()             │                                   │
│  └──────┬───────────────────────────────┘                                   │
│         │                                                                    │
│         ▼                                                                    │
│  ┌───────────────────┐         ┌───────────────────────────────┐            │
│  │ Paper Engine      │         │ Live Executor                 │            │
│  │ engine.ts         │         │ executor.ts                   │            │
│  │ (模拟下单)         │         │ (真实 Binance API 下单)        │            │
│  └──────┬────────────┘         └──────────┬────────────────────┘            │
│         │                                 │                                  │
│         └──────────────┬──────────────────┘                                  │
│                        ▼                                                     │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │                   通知中心                                │               │
│  │   notify/openclaw.ts → Telegram                          │               │
│  └──────────────────────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 双管线架构

系统以**两条并行管线**覆盖不同需求：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          双管线并行架构                                        │
│                                                                             │
│  ┌──────────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │  管线 A：Cron Monitor             │  │  管线 B：Live Monitor Daemon     │  │
│  │  src/monitor.ts                  │  │  src/scripts/live-monitor.ts    │  │
│  │                                  │  │                                 │  │
│  │  触发方式：cron 每分钟执行         │  │  触发方式：常驻 tmux 进程轮询    │  │
│  │  执行引擎：Paper Engine           │  │  执行引擎：Live Executor         │  │
│  │  模式：    模拟交易（paper）       │  │  模式：    真实/Testnet 下单     │  │
│  │  状态文件：logs/state-{id}.json   │  │  状态：    内存 + 账户文件       │  │
│  │                                  │  │                                 │  │
│  │  并行运行所有 enabled 场景         │  │  运行 testnet-default 场景       │  │
│  └──────────────────────────────────┘  └─────────────────────────────────┘  │
│                                                                             │
│  ⚠️  两条管线共同约束：必须调用同一个 processSignal() 函数                     │
│      任何信号逻辑只改一处，必须同时确保两条管线均同步                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**关键规则**：`signal-engine.ts` 中的 `processSignal()` 是唯一的信号逻辑源头。`monitor.ts` 和 `live-monitor.ts` 都以完全相同的参数调用它，禁止在各自文件内单独实现信号条件。

---

## 3. 信号管线详解

整个信号管线按顺序执行以下步骤。下表为总览：

| 步骤 | 模块文件 | 函数 | 状态 |
|------|----------|------|------|
| 1. K线获取 | `exchange/data-provider.ts` | `DataProvider.get()` | ✅ |
| 2. 指标计算 | `strategy/indicators.ts` | `calculateIndicators()` | ✅ |
| 3. 外部数据注入 | 多模块 | 见下文 | ✅ |
| 4. 策略插件选择 | `strategies/registry.ts` | `getStrategy()` | ✅ |
| 5. 信号条件匹配 | `strategy/signals.ts` | `detectSignal()` | ✅ |
| 6. Regime 感知过滤 | `strategy/regime.ts` | `classifyRegime()` | ✅ |
| 7. R:R 过滤 | `strategy/rr-filter.ts` | `checkRiskReward()` | ✅ |
| 8. 相关性过滤 | `strategy/correlation.ts` | `checkCorrelation()` | ✅ |
| 9. Protection Manager | `strategy/protection-manager.ts` | `checkProtections()` | ✅ |
| 10. 紧急暂停 | `news/emergency-monitor.ts` | `readEmergencyHalt()` | ✅ |
| 11. 事件日历 | `strategy/events-calendar.ts` | `checkEventRisk()` | ✅ |
| 12. MTF 趋势过滤 | `monitor.ts` / `live-monitor.ts` | 手动 `calculateIndicators` | ✅ |
| 13. 情绪门控 | `news/sentiment-gate.ts` | `evaluateSentimentGate()` | ✅ |
| 14. Kelly 仓位 | `strategy/kelly.ts` | `calcKellyRatio()` | ⏳ |
| 15. 执行 | `paper/engine.ts` / `live/executor.ts` | `handleSignal()` | ✅ |

---

### 步骤 1：K线获取

**文件**：`src/exchange/data-provider.ts`、`src/exchange/binance.ts`

`DataProvider` 是 K 线数据的统一入口，支持批量预拉取和内存缓存。

```
DataProvider.prefetch(symbols, timeframe, limit)
  → 批量并行请求 Binance REST API
  → 将结果存入内存 Map<symbol-timeframe, Kline[]>

DataProvider.get(symbol, timeframe)
  → 直接返回缓存（O(1)，避免重复请求）
  → 缓存未命中 → 回退到 getKlines() 直接拉取
```

每次扫描所需 K 线数量：

```typescript
const limit = Math.max(cfg.strategy.ma.long, cfg.strategy.rsi.period, macdMinBars) + 10;
// 例如：max(60, 14, 26+9+1) + 10 = 60 + 10 = 70 根
```

K 线类型（`src/types.ts`，`Kline` 接口）：

```typescript
interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}
```

---

### 步骤 2：指标计算

**文件**：`src/strategy/indicators.ts`

函数 `calculateIndicators(klines, maShort, maLong, rsiPeriod, macdCfg)` 返回 `Indicators | null`（数据不足时返回 null）。

计算的指标：

| 指标 | 算法 | 配置参数 |
|------|------|---------|
| EMA Short | 指数移动平均 | `strategy.ma.short`（默认 20）|
| EMA Long | 指数移动平均 | `strategy.ma.long`（默认 60）|
| RSI | 相对强弱指数 | `strategy.rsi.period`（默认 14）|
| MACD | MACD(12,26,9) | `strategy.macd.fast/slow/signal` |
| ATR | 平均真实波幅 | 内部计算，用于动态仓位 |
| VWAP | 成交量加权均价 | 自动计算，含上下 2σ 带 |
| 成交量 | 当前 vs 均量 | `strategy.volume.surge_ratio` |

`Indicators` 接口（`src/types.ts`）包含：
- `maShort`, `maLong`：当前 EMA 值
- `prevMaShort`, `prevMaLong`：前一根 K 线 EMA（用于判断金叉/死叉）
- `rsi`：当前 RSI
- `macd`：`{ macd, signal, histogram, prevMacd, prevSignal, prevHistogram, prevPrevHistogram }`
- `atr`：当前 ATR 值
- `vwap`, `vwapUpper2`, `vwapLower2`：VWAP 及布林带
- `price`, `prevPrice`：当前/前一根收盘价
- `volume`, `avgVolume`：当前成交量 / 近 20 根均量

外部注入字段（步骤 3 写入）：
- `cvd`：累计成交量差值
- `fundingRate`：资金费率百分比
- `btcDominance`, `btcDomChange`：BTC 主导率及变化

---

### 步骤 3：外部数据注入

**文件**：
- `src/exchange/order-flow.ts` → CVD 缓存
- `src/strategy/funding-rate-signal.ts` → 资金费率
- `src/strategy/btc-dominance.ts` → BTC 主导率

在 `processSignal()` 调用之前，`monitor.ts` / `live-monitor.ts` 分别注入以下外部上下文：

```
ExternalContext {
  cvd?         ← order-flow.ts readCvdCache(symbol)（5分钟有效期）
  fundingRate? ← funding-rate-signal.ts fetchFundingRatePct(symbol)（10分钟缓存）
  btcDominance? ← btc-dominance.ts getBtcDominanceTrend().latest
  btcDomChange? ← btc-dominance.ts getBtcDominanceTrend().change（7日变化）
  currentPosSide? ← paper/account.ts loadAccount().positions[symbol].side
  heldKlinesMap?  ← 相关性检查用：已持仓各 symbol 的 K 线
}
```

注入逻辑（两条管线完全一致）：

```typescript
// 资金费率（期货/永续合约，带10分钟缓存，失败静默跳过）
const frPct = await fetchFundingRatePct(symbol);

// BTC 主导率趋势（读历史文件，非阻塞）
const domTrend = getBtcDominanceTrend();

// 真实 CVD（若 CvdManager 已写入缓存，优先用真实数据，5分钟内有效）
const realCvd = readCvdCache(symbol);

// 持仓方向 + 相关性K线
const currentPosSide = loadAccount(...).positions[symbol]?.side;
```

---

### 步骤 4：策略插件选择

**文件**：`src/strategies/registry.ts`、`src/strategies/index.ts`、`src/strategies/types.ts`

系统支持策略插件机制（`F4`）：

```
strategy_id（来自配置）
  ↓
"default" → 走经典 detectSignal() 路径（SIGNAL_CHECKERS map）
其他值    → getStrategy(strategyId) → plugin.populateSignal(ctx)
```

内置策略：
- `default`：经典 MA + RSI + MACD 趋势跟随
- `rsi-reversal`：RSI 超买超卖反转策略
- `breakout`：突破策略

插件接口（`StrategyContext`）：
```typescript
interface StrategyContext {
  klines: Kline[];
  cfg: StrategyConfig;
  indicators: Indicators;
  currentPosSide?: "long" | "short";
}
```

`populateSignal(ctx)` 返回 `Signal["type"]`（`"buy" | "sell" | "short" | "cover" | "none"`）。

---

### 步骤 5：信号条件匹配

**文件**：`src/strategy/signals.ts`

`SIGNAL_CHECKERS` 是一个字符串 → 函数的映射表，所有可用条件均在此注册：

```
SIGNAL_CHECKERS: Record<string, SignalChecker>
  ma_golden_cross / ma_death_cross / ma_bullish / ma_bearish
  rsi_oversold / rsi_overbought / rsi_not_overbought / rsi_not_oversold
  rsi_bullish_zone / rsi_overbought_exit
  macd_golden_cross / macd_death_cross / macd_bullish / macd_bearish
  macd_histogram_expanding / macd_histogram_shrinking
  price_above_vwap / price_below_vwap / vwap_bounce / vwap_breakdown
  price_above_vwap_upper2 / price_below_vwap_lower2
  btc_dominance_rising / btc_dominance_falling
  funding_rate_overlong / funding_rate_overshort
  cvd_bullish / cvd_bearish
  volume_surge / volume_low
```

`detectSignal()` 函数实现持仓感知的优先级逻辑：

```
持多头（long）→ 只检查 sell 条件（平多），忽略 buy/short/cover
持空头（short）→ 只检查 cover 条件（平空），忽略 sell/buy/short
无持仓         → 先检查 buy → 再检查 short（多头优先）
```

信号条件 **全部满足** 才触发（AND 逻辑）。当前 `long-short` 策略条件：

| 信号类型 | 条件 |
|---------|------|
| buy（开多） | `ma_bullish` AND `macd_golden_cross` AND `rsi_not_overbought` |
| sell（平多） | `ma_bearish` |
| short（开空）| `ma_bearish` AND `macd_death_cross` AND `rsi_not_oversold` |
| cover（平空）| `ma_bullish` |

---

### 步骤 6：Regime 感知过滤

**文件**：`src/strategy/regime.ts`

在 `processSignal()` 内部，对 **开仓信号（buy/short）** 执行市场环境（Regime）分类：

```typescript
const regime = classifyRegime(klines);
// 返回：{ label, signalFilter, confidence, detail }
```

`signalFilter` 取值及对应行为：

| 值 | 含义 | 行为 |
|----|------|------|
| `breakout_watch` | 突破观察期，信号不可靠 | **拒绝**信号 |
| `reduced_size` | 减仓模式，趋势不明朗 | 仓位 × **0.5**（缩减但不拒绝）|
| `all_clear` | 正常市场 | 不做限制 |

置信度阈值：`regime.confidence >= 60` 时才生效。

如果配置了 `cfg.regime_overrides`，Regime 过滤同时会合并覆盖 `effectiveRisk`（如调整 SL/TP 百分比）。

> ⚠️ **当前状态**：`regime_overrides` 验证表明过滤存在滞后现象，testnet-default 场景中**未启用**（❌）。

---

### 步骤 7：R:R 过滤

**文件**：`src/strategy/rr-filter.ts`

函数 `checkRiskReward(klines, price, side, minRr)` 基于近期 K 线的波动范围，估算当前入场的风险/回报比：

```
R:R = 预期盈利空间 / 预期亏损空间
```

配置项：`risk.min_rr`（默认 1.5，0 = 禁用）

仅对 **开仓信号** 执行，平仓信号不受影响。

---

### 步骤 8：相关性过滤

**文件**：`src/strategy/correlation.ts`

函数 `checkCorrelation(symbol, klines, heldMap, threshold)` 使用 Pearson 相关系数检测新信号与已持仓资产的相关性。

```
如果 相关系数 > threshold（默认 0.75）：
  → 缩仓 50%（不直接拒绝，仅缩减仓位）

如果已持仓多个高相关资产：
  → 可能累计缩仓多次
```

配置项：
```yaml
correlation_filter:
  enabled: true
  threshold: 0.75   # 皮尔逊相关系数阈值
  lookback: 60      # 用最近 60 根 K 线计算
```

相关性过滤与 Regime 缩仓是叠加关系（两者均触发时仓位可能被缩至原来的 25%）。

---

### 步骤 9：Protection Manager

**文件**：`src/strategy/protection-manager.ts`

函数 `checkProtections(symbol, protectionCfg, recentTrades, candleIntervalMs)` 提供三种保护：

| 保护类型 | 说明 | 触发结果 |
|---------|------|---------|
| `cooldown` | 最近一笔交易亏损后冷却 N 根 K 线 | 拒绝开仓 |
| `stoploss_guard` | 近 N 笔亏损占比超过阈值 | 拒绝开仓 |
| `max_drawdown` | 单币种最大回撤超过阈值 | 拒绝开仓 |

在 `processSignal()` 中仅对 **开仓信号** 执行，需传入 `recentTrades`（历史平仓记录）。

---

### 步骤 10：紧急暂停

**文件**：`src/news/emergency-monitor.ts`

```typescript
const emergencyState = readEmergencyHalt();
// emergencyState.halt === true → 停止所有开仓
```

紧急暂停由 `news_emergency` cron（每 10 分钟）通过 `news/emergency-monitor.ts` 检测突发高危新闻后自动写入状态文件。**仅影响开仓信号**，止损/止盈平仓不受影响。

---

### 步骤 11：事件日历

**文件**：`src/strategy/events-calendar.ts`

函数 `checkEventRisk(calendar)` 检查当前是否处于宏观事件窗口期：

| 事件阶段 | 含义 | 行为 |
|---------|------|------|
| `during` | 正在事件窗口期（如 FOMC 发布） | **暂停**所有开仓 |
| `pre` | 事件前预警期 | 仓位 × `positionRatioMultiplier`（日志提示） |
| `post` | 事件后观察期 | 仓位 × `positionRatioMultiplier`（日志提示） |
| `none` | 无事件 | 正常执行 |

日历文件通过外部配置维护，`loadCalendar()` 从磁盘读取。

---

### 步骤 12：MTF 趋势过滤

**文件**：`src/monitor.ts`、`src/scripts/live-monitor.ts`

MTF（多时间框架）过滤在 `processSignal()` 之外、执行之前，在各管线脚本中独立实现：

```
配置：trend_timeframe = "4h"（4 小时大趋势）

拉取 4h K 线 → calculateIndicators() → 判断 EMA20 vs EMA60

买入信号（buy）  + 4h 空头（EMA20 < EMA60）→ 🚫 跳过
开空信号（short）+ 4h 多头（EMA20 > EMA60）→ 🚫 跳过
平仓信号（sell/cover）→ 不受 MTF 限制
```

> ⚠️ **注意**：MTF 过滤代码在 `monitor.ts` 和 `live-monitor.ts` 中分别实现，**未通过 `processSignal()` 统一**。这是已知的代码重复问题，详见「审计发现」章节。

---

### 步骤 13：情绪门控

**文件**：`src/news/sentiment-gate.ts`、`src/news/sentiment-cache.ts`

```typescript
const newsReport = loadNewsReport();      // 最新新闻报告（每4小时采集）
const sentimentCache = readSentimentCache(); // LLM情绪缓存（关键词去重）
const gate = evaluateSentimentGate(signal, newsReport, baseForGate, sentimentCache);
```

`gate.action` 取值：
- `"proceed"`：正常执行，仓位比例 = `gate.positionRatio`
- `"reduce"`：减仓执行，仓位比例降低
- `"skip"`：跳过本次信号

情绪门控以「组合调整后的仓位比例」为基准（Regime + 相关性调整之后的值），可以再次缩减。

**依赖关系**：情绪门控需要新闻采集 cron（`news/monitor.ts`，每 4 小时）提前运行，将报告写入磁盘。

---

### 步骤 14：Kelly 仓位

**文件**：`src/strategy/kelly.ts`

函数 `calcKellyRatio(closedTrades, options)` 使用 Kelly 公式动态计算最优仓位比例：

```
Kelly = W - (1-W)/R
半 Kelly = Kelly × 0.5
```

其中：
- `W`：历史胜率
- `R`：平均盈亏比

配置项：
```yaml
position_sizing: "kelly"  # "fixed"（默认）| "kelly"
kelly_lookback: 30        # 参考最近 30 笔平仓
kelly_half: true          # 半 Kelly（默认，降低方差）
kelly_min_ratio: 0.05     # 仓位下限 5%
kelly_max_ratio: 0.40     # 仓位上限 40%
```

**启用条件**：需要 **至少 10 笔历史平仓记录**（`calcKellyRatio` 内部强制检查），否则回退到 `fallback` 固定仓位。

> ⏳ **当前状态**：testnet-default 场景 `position_sizing` 为 `"fixed"`，Kelly 仓位**尚未启用**，等待积累 30+ 笔历史后再切换。

---

### 步骤 15：执行

**文件**：`src/paper/engine.ts`（Paper）、`src/live/executor.ts`（Live）

调用 `handleSignal(signal, cfg)` 进入执行引擎（详见第 4 章）。

---

## 4. 执行引擎详解

### 4.1 Paper Engine（模拟引擎）

**文件**：`src/paper/engine.ts`

Paper Engine 模拟真实交易流程，所有状态存入本地 JSON 文件。

#### 4.1.1 开仓流程

```
handleSignal(signal, cfg)
  │
  ├─ buy 信号
  │    ├─ 检查 max_positions（超出 → skip）
  │    ├─ 检查账户净值（≤0 → skip）
  │    ├─ 检查单币占比 max_position_per_symbol
  │    ├─ 检查每日亏损 daily_loss_limit_percent
  │    ├─ ATR 动态仓位计算（calcAtrPositionSize）
  │    └─ paperBuy() → 更新账户 positions
  │
  ├─ short 信号
  │    ├─ 检查市场类型（spot → skip，仅 futures/margin 有效）
  │    ├─ （同 buy 的 max_positions / 净值 / 单币占比 / 日亏损检查）
  │    ├─ ATR 动态仓位计算
  │    └─ paperOpenShort() → 更新账户 positions
  │
  ├─ sell 信号 → paperSell()
  └─ cover 信号 → paperCoverShort()
```

#### 4.1.2 出场流程

`checkExitConditions()` 每分钟遍历所有持仓，按以下**优先级顺序**检查：

```
出场优先级（从高到低）：
  1. force_exit_timeout   超时出场（exitTimeoutCount ≥ 3 → 强制市价）
  2. stop_loss            止损触发
  3. ROI Table            时间衰减止盈（checkMinimalRoi）
  4. take_profit          固定止盈
  5. trailing_stop        追踪止损（updateTrailingStop）
  6. time_stop            时间止损（持仓 > time_stop_hours 且无盈利）
  7. staged_TP            分批止盈（checkStagedTakeProfit，并行检查）
```

#### 4.1.3 保本止损（Break-Even Stop）

**文件**：`src/strategy/break-even.ts`

函数 `resolveNewStopLoss()` 在每次检查出场条件前调用，当盈利达到 `break_even_profit` 阈值后，将止损线上移至 `入场价 + break_even_stop`：

```yaml
break_even_profit: 0.03   # 盈利 ≥ 3% 后激活
break_even_stop: 0.001    # 止损线移至入场价 +0.1%
```

#### 4.1.4 出场确认（confirm_trade_exit）

**文件**：`src/strategy/confirm-exit.ts`

`shouldConfirmExit()` 提供可选的出场确认机制，避免因短暂波动误触出场。已实现但需配置 `confirm_trade_exit` 启用。

### 4.2 Live Executor（实盘执行器）

**文件**：`src/live/executor.ts`

Live Executor 通过 Binance 真实 API 下单。

```typescript
const executor = createLiveExecutor(cfg);
// 执行开仓
await executor.openPosition(signal, adjustedCfg);
// 执行平仓
await executor.closePosition(symbol, reason, cfg);
```

Testnet 模式下通过 `exchange.testnet: true` 连接 `testapi.binance.vision`。

仓位同步：`reconcilePositions()` / `formatReconcileReport()` 用于对账 API 持仓与本地账户文件的差异。

---

## 5. 配置体系

### 5.1 三层合并架构

```
┌─────────────────────────────────────────────────────────────┐
│                    配置优先级（从低到高）                       │
│                                                             │
│  第 1 层：config/strategy.yaml（全局默认）                    │
│    └── 全局指标参数、信号条件、风控基准、cron 计划              │
│                                                             │
│  第 2 层：config/strategies/{strategy_id}.yaml（策略 profile）│
│    └── 覆盖：signals, strategy, risk, timeframe              │
│                                                             │
│  第 3 层：config/paper.yaml → scenarios[n]（场景覆盖）        │
│    └── 覆盖：risk, symbols, exchange, initial_usdt 等         │
└─────────────────────────────────────────────────────────────┘
```

**文件**：`src/config/loader.ts`

合并函数：
- `mergeRisk(base, ...overrides)` — 深合并 `RiskConfig`，嵌套对象（`trailing_stop`, `atr_position`, `correlation_filter`）逐字段合并，不会因部分覆盖丢失基础配置
- `mergeStrategySection(base, override)` — 深合并 `strategy`（`ma`, `rsi`, `macd`, `volume`）

构建函数：
- `buildPaperRuntime(base, paperCfg, scenario)` — 为单个场景构建 `RuntimeConfig`
- `loadRuntimeConfigs()` — 加载所有 `enabled` 场景

### 5.2 testnet-default 场景完整配置

```yaml
# config/paper.yaml → scenarios → testnet-default
id: "testnet-default"
name: "Testnet × 默认策略"
enabled: true
strategy_id: "long-short"    # 使用 config/strategies/long-short.yaml
initial_usdt: 10000
fee_rate: 0.001
slippage_percent: 0.05

exchange:
  market: "spot"
  testnet: true
  credentials_path: ".secrets/binance-testnet.json"
  leverage:
    enabled: false
    default: 1
    max: 1

risk:
  stop_loss_percent: 5
  take_profit_percent: 15
  trailing_stop:
    enabled: true
    activation_percent: 8
    callback_percent: 2
  position_ratio: 0.2         # fallback仓位
  max_positions: 3
  max_position_per_symbol: 0.3
  max_total_loss_percent: 20
  daily_loss_limit_percent: 8
  atr_position:
    enabled: true
    risk_per_trade_percent: 2
    atr_multiplier: 1.5
    max_position_ratio: 0.3
  take_profit_stages:         # 分批止盈
    - at_percent: 8
      close_ratio: 0.5
    - at_percent: 12
      close_ratio: 0.5
  time_stop_hours: 72
  break_even_profit: 0.03
  break_even_stop: 0.001
```

合并后 `RuntimeConfig` 关键字段（来自 strategy.yaml + long-short.yaml + testnet-default）：

| 字段 | 值 | 来源 |
|------|-----|------|
| `timeframe` | `"1h"` | long-short.yaml |
| `trend_timeframe` | `"4h"` | long-short.yaml |
| `strategy.ma.short/long` | `20 / 60` | 两层一致 |
| `strategy.rsi.oversold/overbought` | `35 / 65` | long-short.yaml（覆盖全局 30/65）|
| `signals.buy` | `ma_bullish + macd_golden_cross + rsi_not_overbought` | long-short.yaml |
| `signals.short` | `ma_bearish + macd_death_cross + rsi_not_oversold` | long-short.yaml |
| `risk.min_rr` | `1.5` | strategy.yaml（全局）|
| `risk.correlation_filter.enabled` | `true` | strategy.yaml（全局）|

---

## 6. 数据流与存储

### 6.1 文件存储总览

```
logs/
├── paper-{scenarioId}.json        # 账户文件（原子写入）
├── signal-history.jsonl           # 信号历史（JSONL 追加）
├── signal-notify-dedup.json       # 通知去重状态
├── state-{scenarioId}.json        # Monitor 状态（上次信号 + 时间戳）
├── monitor.log                    # Cron 监控日志
├── health/
│   ├── heartbeat-{scenarioId}.json  # 健康心跳
│   └── ...
├── backtest/
│   └── report-{timestamp}.json    # 回测报告
└── trades-{scenarioId}.db         # SQLite 交易记录（G5，可选）
```

### 6.2 账户文件结构

**文件**：`logs/paper-{scenarioId}.json`（通过 `src/paper/account.ts` 管理）

```json
{
  "balance": 9500.0,
  "positions": {
    "BTCUSDT": {
      "symbol": "BTCUSDT",
      "side": "long",
      "quantity": 0.001,
      "entryPrice": 42000,
      "entryTime": 1700000000000,
      "stopLoss": 39900,
      "takeProfit": 48300,
      "signalHistoryId": "sig_xxxx",
      "tpStages": [...],
      "dcaState": null
    }
  },
  "trades": [...],
  "dailyLoss": { "date": "2026-02-26", "loss": 0 }
}
```

原子写入：先写临时文件，再 `fs.renameSync()` 替换，避免写入中断导致文件损坏。

### 6.3 信号历史

**文件**：`logs/signal-history.jsonl`

每笔信号一行 JSON，通过 `src/strategy/signal-history.ts` 管理：
- `logSignal()` — 开仓时写入（status: "open"）
- `closeSignal(id, exitPrice, reason, pnl)` — 平仓时更新（status: "closed"）

Kelly 仓位计算读取此文件的 `status === "closed"` 记录。

### 6.4 通知去重

**文件**：`logs/signal-notify-dedup.json`（通过 `monitor.ts` 中 `state.lastSignals` 管理）

每个 symbol 记录上次通知的信号类型和时间戳，`shouldNotify()` 基于 `min_interval_minutes`（默认 30 分钟）判断是否需要再次通知。

---

## 7. 定时任务体系

### 7.1 Cron 任务列表

**配置**：`config/strategy.yaml → schedule`
**同步脚本**：`src/scripts/sync-cron.ts`（`npm run cron:sync` 写入系统 crontab）

| 任务 | Cron 表达式 | 脚本路径 | 超时 | 状态 |
|------|------------|----------|------|------|
| 价格监控 | `* * * * *`（每分钟）| `src/monitor.ts` | 3 分钟 | ✅ |
| 新闻采集 | `0 */4 * * *`（每 4 小时）| `src/news/monitor.ts` | 260 分钟 | ✅ |
| 周报 | `0 14 * * 0`（周日 22:00 CST）| `src/report/weekly.ts` | 10 分钟 | ✅ |
| 健康检查 | `*/30 * * * *`（每 30 分钟）| `src/health/checker.ts` | 35 分钟 | ✅ |
| Watchdog | `*/5 * * * *`（每 5 分钟）| `src/health/watchdog.ts` | 10 分钟 | ✅ |
| 日志轮转 | `0 0 * * *`（每日 0 点）| `src/health/log-rotate.ts` | 10 分钟 | ✅ |
| 紧急新闻 | `*/10 * * * *`（每 10 分钟）| `src/news/emergency-monitor.ts` | 5 分钟 | ✅ |
| 币种刷新 | `0 0 * * *`（每日 0 点）| `src/scripts/refresh-pairlist.ts` | 5 分钟 | ✅ |

### 7.2 常驻进程

| 进程 | tmux session | 命令 | 状态 |
|------|-------------|------|------|
| Live Monitor | `trader-live` | `npm run live` | ✅ 运行中 |

重启命令：
```bash
tmux send-keys -t trader-live C-c
sleep 2
tmux send-keys -t trader-live "npm run live" Enter
```

### 7.3 任务依赖关系

```
                        ┌─────────────────────────────────────┐
                        │          任务依赖链                    │
                        │                                     │
  news/monitor.ts ─────→│ 写入新闻报告                         │
  （每4小时）             │ logs/news-report-*.json              │
                        │          ↓                          │
  news/emergency-monitor→│ 检测高危新闻 → emergency halt 文件    │
  （每10分钟）            │          ↓                          │
                        │ monitor.ts / live-monitor.ts         │
                        │   └─ readEmergencyHalt() 读取         │
                        │   └─ loadNewsReport() 读取            │
                        │   └─ readSentimentCache() 读取        │
                        │          ↓                          │
                        │ evaluateSentimentGate() 执行情绪门控  │
                        └─────────────────────────────────────┘

  health/watchdog.ts ──→ 检查 monitor.ts 上次运行时间
  （每5分钟）              → 超时未运行 → Telegram 告警

  health/checker.ts ───→ 检查账户状态 / 系统健康
  （每30分钟）             → 写入 logs/health/ 心跳文件
```

**关键依赖**：情绪门控（步骤 13）依赖新闻采集 cron 定期运行。若新闻采集停止，`loadNewsReport()` 将读取旧报告，情绪门控可能基于过期数据做决策。

---

## 8. 风控体系

### 8.1 风控层级总览

```
┌──────────────────────────────────────────────────────────────┐
│                      风控层级                                  │
│                                                              │
│  单笔交易层（per-trade）                                       │
│  ├── 止损（Stop Loss）：- stop_loss_percent = 5%              │
│  ├── 止盈（Take Profit）：take_profit_percent = 15%           │
│  ├── 分批止盈（Staged TP）：8%/50% → 12%/50%                  │
│  ├── 追踪止损（Trailing Stop）：激活 8%，回调 2%               │
│  ├── 时间止损（Time Stop）：72 小时无盈利强制出场               │
│  ├── 保本止损（Break-Even）：盈利 3% → 止损移至 +0.1%          │
│  └── R:R 过滤：盈亏比 ≥ 1.5 才入场                           │
│                                                              │
│  组合层（portfolio）                                           │
│  ├── 最大持仓数：max_positions = 3                             │
│  ├── 单币占比：max_position_per_symbol = 30%                  │
│  └── 相关性过滤：高相关（>0.75）缩仓 50%                        │
│                                                              │
│  每日层（daily）                                              │
│  └── 每日亏损限制：daily_loss_limit_percent = 8%              │
│                                                              │
│  全局层（global）                                             │
│  ├── 总亏损上限：max_total_loss_percent = 20%                 │
│  ├── Kill Switch：自动触发，停止所有新开仓                       │
│  ├── 紧急暂停：突发新闻触发，readEmergencyHalt()               │
│  └── BTC 崩盘检测：1h 跌幅 > 8% → activateKillSwitch()       │
│                                                              │
│  仓位层（position sizing）                                     │
│  ├── ATR 动态仓位：risk_per_trade=2%, ATR×1.5 为止损距离       │
│  ├── Kelly 动态（待启用）：半 Kelly，10 笔以上历史              │
│  ├── Regime 缩减：市场异常时仓位 × 0.5                         │
│  ├── 相关性缩减：高相关时仓位 × 0.5                             │
│  └── 事件乘数：事件前/后 × positionRatioMultiplier             │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 仓位计算详解

当 `atr_position.enabled = true` 时，ATR 动态仓位优先于固定 `position_ratio`：

```
仓位 USDT = (账户净值 × risk_per_trade_percent) / (ATR × atr_multiplier / 价格)

例：
  净值 = 10,000 USDT
  risk_per_trade = 2% = 200 USDT
  ATR = 500 USDT
  atr_multiplier = 1.5 → 止损距离 = 750 USDT
  仓位 = 200 / (750/价格) ≈ 取决于当前价格
```

`calcAtrPositionSize()` 定义在 `src/strategy/indicators.ts`，受 `max_position_ratio = 0.3` 上限约束。

### 8.3 Kill Switch

**文件**：`src/health/kill-switch.ts`

触发条件：
- BTC 1 小时内跌幅 > `BTC_CRASH_THRESHOLD_PCT`（默认 8%）→ `checkBtcCrash()` 自动触发
- 手动：`src/scripts/kill-switch-cli.ts`

激活后：`isKillSwitchActive()` 返回 `true`，所有管线跳过新开仓。

---

## 9. 辅助工具

### 9.1 回测系统

**文件**：`src/backtest/runner.ts`（通过 `src/scripts/backtest.ts` 调用）

| 功能 | 状态 |
|------|------|
| 历史 K 线回测 | ✅ 经常使用 |
| 调用 `processSignal()` 统一引擎 | ✅ 与实盘一致 |
| 输出回测报告到 `logs/backtest/` | ✅ |
| 手续费/滑点模拟 | ✅ |

### 9.2 Hyperopt 超参数优化

**文件**：`src/optimization/bayesian.ts`（通过 `src/scripts/hyperopt.ts` 调用）

| 功能 | 状态 |
|------|------|
| 贝叶斯优化搜索最优参数 | ✅ |
| 参数空间：MA/RSI/MACD/SL/TP 等 | ✅ |
| 输出最优参数到配置 | ⏳ 需手动更新 |

### 9.3 Walk-Forward 分析

**文件**：`src/optimization/auto-wf.ts`（通过 `src/scripts/auto-wf.ts` 调用）

| 功能 | 状态 |
|------|------|
| 自动滚动窗口分析（训练 + 验证） | ❌ 未定期运行 |
| 防止过拟合，检验参数稳健性 | ✅ 已实现 |

### 9.4 信号统计分析

**文件**：`src/analysis/signal-stats.ts`（通过 `src/scripts/signal-stats.ts` 调用）

| 功能 | 状态 |
|------|------|
| 分析 signal-history.jsonl 统计胜率/盈亏比 | ⏳ 待积累足够数据 |
| 分条件统计（MA/RSI/MACD 各条件胜率）| ✅ 已实现 |

### 9.5 周报

**文件**：`src/report/weekly.ts`（通过 `src/scripts/weekly-report.ts` 调用）

| 功能 | 状态 |
|------|------|
| 每周日 22:00 CST 自动生成 | ✅ cron 已设置 |
| 统计收益、胜率、最大回撤 | ✅ |
| 发送 Telegram 通知 | ✅ |

### 9.6 Telegram 命令交互

**文件**：`src/telegram/command-handler.ts`（通过 `src/scripts/telegram-bot.ts` 启动）

| 命令 | 功能 | 状态 |
|------|------|------|
| `/status` | 查看账户状态 | ✅ 已实现 |
| `/positions` | 查看当前持仓 | ✅ 已实现 |
| `/pause` / `/resume` | 暂停/恢复监控 | ✅ 已实现 |
| `/halt` / `/resume-halt` | 触发/解除紧急暂停 | ✅ 已实现 |

> ❌ **当前状态**：Telegram Bot 尚未作为独立进程启动（`npm run telegram-bot` 未运行）。

### 9.7 Web 仪表盘

**文件**：`src/web/dashboard-server.ts`（通过 `src/scripts/dashboard.ts` 启动）

| 功能 | 状态 |
|------|------|
| 实时账户状态 Web UI | ❌ 未启动 |
| REST API 接口 | ✅ 已实现 |

### 9.8 其他脚本工具

| 工具 | 文件 | 说明 | 状态 |
|------|------|------|------|
| 市场分析 | `scripts/market-analysis.ts` | 09:00/21:00 手动分析 | ✅ 每日使用 |
| 手动交易 | `scripts/manual-trade.ts` | 手动开平仓工具 | ✅ 按需使用 |
| 漂移检测 | `scripts/drift-monitor.ts` | 检测实盘 vs 模拟的执行偏差 | ❌ 未定期运行 |
| 周期分析 | `scripts/cycle-analysis.ts` | 分段周期回测 | ✅ |
| Regime 回测 | `scripts/regime-backtest.ts` | 自适应回测验证 | ✅ |
| 信号归因 | `scripts/signal-attribution.ts` | 分析各条件对盈亏的贡献 | ❌ 未使用 |
| WebSocket 监控 | `scripts/ws-monitor.ts` | 替代轮询的实时监控 | ❌ 未接入 |

---

## 审计发现

> 本章节记录对照代码审查发现的问题、不一致点和潜在风险。
> 格式：编号 / 类型 / 描述 / 影响 / 建议

---

### A-001 ✅ [已修复 47f6366] MTF 趋势过滤代码重复，非统一管线

**类型**：代码重复 / 维护风险

**描述**：
MTF（多时间框架）趋势过滤逻辑在 `src/monitor.ts`（约 L110-L140）和 `src/scripts/live-monitor.ts`（约 L190-L215）中分别实现，没有复用 `processSignal()` 统一管线。两处代码当前内容一致，但未来任一修改未同步就会导致行为差异。

**影响**：中等。当前两侧代码功能一致，不影响实际信号。但若修改一侧忘记同步另一侧，会造成两条管线行为不一致，违反「双路径必须完全一致」核心规则。

**建议**：将 MTF 过滤封装为 `checkMtfTrend(symbol, cfg, provider): Promise<boolean | null>` 并在两处统一调用，或纳入 `processSignal()` 内部。

---

### A-002 ⚠️ 通知冷却在 MTF/情绪过滤之前消耗，可能静默丢弃有效信号

**类型**：逻辑问题

**描述**：
`monitor.ts` 中，`shouldNotify()` 冷却检查和 `state.lastSignals` 时间戳更新（约 L240）发生在 MTF 趋势过滤和情绪门控**之前**。这意味着：若一个信号通过了 `processSignal()` 但被 MTF 或情绪过滤拒绝，仍然消耗了通知冷却窗口。

**代码注释**（L238）：
```typescript
// 🐛 Fix: 通知冷却在 MTF/情绪过滤之前生效，防止被过滤的信号绕过 min_interval_minutes
```

这段注释说明这是**有意为之的 bug fix**，目的是防止同一类型信号在冷却期内被过滤后立即重新通知。但也意味着在冷却期内被 MTF 过滤的有效方向变化将被静默丢弃。

**影响**：低。在策略趋于稳定的情况下，同一信号类型在 30 分钟内通常不会来回切换方向。但在市场快速变化时，可能导致重要信号被冷却窗口屏蔽。

**建议**：添加日志记录被冷却屏蔽的信号类型，方便事后分析。

---

### A-003 ℹ️ short 信号在 spot 市场被静默跳过，仅 paper engine 层面

**类型**：信息说明 / 潜在误导

**描述**：
`engine.ts` 中 `handleSignal()` 对 `short` 信号有市场类型检查：

```typescript
if (market !== "futures" && market !== "margin") {
  skipped = `开空信号被忽略：当前市场类型为 ${market}，做空需要 futures 或 margin`;
}
```

但 testnet-default 场景配置 `exchange.market: "spot"` 且 `strategy_id: "long-short"`（包含 short/cover 信号）。这意味着：**做空信号会被检测到、通知发出，但执行时被 paper engine 静默跳过**。

**影响**：在 spot 市场下做空信号不会被实际执行，但会产生通知。可能造成误解，认为已开空仓位但实际没有。

**建议**：
1. 在 `live-monitor.ts` 和 `monitor.ts` 的信号检测阶段增加市场类型前置检查，对 spot 市场直接跳过 `short` 信号，避免发出无法执行的通知。
2. 或者将 testnet-default 场景切换为 `market: "futures"` 以真正启用双向交易。

---

### A-004 ℹ️ Kelly 仓位读取 signal-history.jsonl 路径的计算方式

**类型**：代码健壮性

**描述**：
`monitor.ts` 和 `live-monitor.ts` 中 Kelly 仓位的 `histPath` 均通过 `import.meta.url` 计算：

```typescript
const histPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../logs/signal-history.jsonl"
);
```

`monitor.ts` 在 `src/` 目录，`live-monitor.ts` 在 `src/scripts/` 目录，两者路径计算不同（`../../logs` vs `../../logs`）但均正确指向 `logs/signal-history.jsonl`。

**影响**：无，路径计算均正确。记录供后续维护者参考，避免误改路径层级。

---

### A-005 ✅ [已修复 47f6366] Protection Manager 的 recentTrades 在 monitor.ts 中未传入

**类型**：功能未激活

**描述**：
`processSignal()` 的第 5 个参数 `recentTrades` 用于 Protection Manager。查看 `monitor.ts` 调用：

```typescript
const engineResult = processSignal(symbol, klines, cfg, externalCtx);
// ↑ 没有传入 recentTrades
```

`live-monitor.ts` 同样没有传入 `recentTrades`。

**影响**：Protection Manager（cooldown / stoploss_guard / max_drawdown 保护）**实际未生效**，尽管代码已实现。

**建议**：从 `signal-history.jsonl` 读取最近平仓记录并传入 `processSignal()`，激活 Protection Manager 功能。

---

### A-006 ℹ️ Regime 过滤置信度阈值为 60，未通过配置文件暴露

**类型**：配置硬编码

**描述**：
`signal-engine.ts` 中：
```typescript
if (regime.confidence >= 60) {
```
阈值 `60` 硬编码，无法通过 YAML 配置调整。

**影响**：低。但若需要调整灵敏度（如升至 75 减少误触发），需修改代码。

**建议**：将阈值提取为配置项 `regime_confidence_threshold`。

---

### A-007 ✅ [已修复 47f6366] 分批止盈（staged_TP）仅支持多头，空头持仓无 tpStages 初始化

**类型**：功能缺口

**描述**：
`engine.ts` 中，`tpStages` 初始化在 buy 信号处理逻辑中（约 L137-145）。short 信号处理块（约 L200-260）中**未初始化** `tpStages`。

**影响**：做空时分批止盈不生效，空头持仓只有固定止盈触发。

**建议**：在 short 信号的 `newShortPos` 初始化后，添加同 buy 逻辑一致的 `tpStages` 初始化代码。

---

### A-008 ℹ️ 状态文件路径不一致：getStatePath 使用 state-，部分文档引用 monitor-state-

**类型**：文档不一致

**描述**：
`monitor.ts` 中定义：
```typescript
function getStatePath(scenarioId: string): string {
  return path.resolve(__dirname, `../logs/state-${scenarioId}.json`);
}
```
实际路径为 `logs/state-{scenarioId}.json`，但本文档要求描述为 `logs/monitor-state-{scenarioId}.json`。

**影响**：仅文档不一致，不影响功能。

**建议**：统一文档描述为 `logs/state-{scenarioId}.json`（以代码为准）。

---

*本文档与实际代码保持同步*

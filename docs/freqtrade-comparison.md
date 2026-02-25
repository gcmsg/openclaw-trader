# Freqtrade vs openclaw-trader 深度对比分析

> 分析时间：2026-02-25 · Freqtrade 版本：2026.2-dev-402ef21  
> 本文基于对 Freqtrade 核心源码的直接阅读（freqtradebot.py / strategy/interface.py / persistence/trade_model.py / exchange/exchange.py）

---

## 一、架构对比

### 主循环设计

**Freqtrade `process()` 结构**（freqtradebot.py:247）
```
process()
├── exchange.reload_markets()            ← 市场数据刷新（含精度/手续费）
├── update_trades_without_assigned_fees() ← 补录缺失手续费
├── dataprovider.refresh(candles)        ← 集中刷新所有 pair 的 K 线（一次 API）
├── strategy.analyze()                   ← 统一计算指标 + 信号（计算一次，所有地方复用）
├── manage_open_orders()                 ← ⭐ 订单超时检查 + 取消/替换
├── exit_positions()                     ← 出场检查（SL/ROI/信号）
├── process_open_trade_positions()       ← DCA/加仓调整
└── enter_positions()                    ← 新入场信号
```

**openclaw-trader `live-monitor.ts` 主循环**
```
for(;;)
├── checkEmergencyHalt()                 ← 突发新闻检查
├── executor.getExchangePositions()      ← 持仓对账
├── for each scenario:
│   ├── loadAccount()                    ← 从 JSON 加载账户状态
│   ├── checkExitConditions()            ← 出场检查（SL/TP/本地轮询）
│   └── for each symbol:
│       ├── getKlines() × 3 TF           ← ⚠️ 每 symbol 单独请求（API 密集）
│       ├── computeIndicators()
│       ├── checkCVD/Regime/Correlation/Kelly
│       └── signal → handleBuy/handleShort
├── checkDcaTranches()
└── sleep(60s)
```

**关键差异**：Freqtrade 用 `DataProvider` 集中缓存 K 线，`strategy.analyze()` 只调用一次；我们每轮每个 symbol 单独 `getKlines()` 调用，8 个币种 × 3 TF = 最多 24 次 API 请求/轮。

---

## 二、核心功能对比表

| 功能 | Freqtrade | openclaw-trader | 差距等级 |
|------|-----------|-----------------|----------|
| **止盈逻辑** | ROI Table（时间衰减，分段目标） | 固定 `take_profit_percent` | 🔴 大 |
| **订单超时** | `unfilledtimeout` 自动取消/重下 | ❌ 无 | 🔴 大 |
| **部分成交** | `update_trade_state()` 按实际 filled 更新 | ❌ 假设 100% 成交 | 🔴 大 |
| **持久化** | SQLite（SQLAlchemy ORM，崩溃安全） | JSONL 文件（append-only，无法查询） | 🟡 中 |
| **订单状态机** | `PENDING→OPEN→PARTIALLY_FILLED→FILLED/CANCELLED` | ❌ 无状态追踪 | 🔴 大 |
| **策略设计** | Class 继承 IStrategy，插件式 | Config YAML + 纯函数 | 🟡 中 |
| **入场确认** | `confirm_trade_entry()` 最终校验 | ❌ 无 | 🟡 中 |
| **K 线缓存** | DataProvider 集中缓存 | 每 symbol 单独请求 | 🟡 中 |
| **保护机制** | CooldownPeriod/MaxDrawdown/StoplossGuard | 简单 totalLoss 暂停 | 🟡 中 |
| **DCA** | `adjust_trade_position()` 策略回调 | 硬编码 checkDcaTranches() | 🟡 中 |
| **回测/实盘统一** | ✅ 同一套策略代码 | ❌ monitor.ts vs runner.ts 两套 | 🔴 大 |
| **多空支持** | ✅ Long/Short 统一 Trade 模型 | ✅ spot buy + futures short | 相当 |
| **LLM 情绪** | ❌（FreqAI 是 ML，不是 LLM） | ✅ Gateway LLM 分析 | 我们领先 |
| **VWAP 偏差带** | ❌ 需自行实现 | ✅ ±1σ/±2σ，6 个信号 | 我们领先 |
| **BTC 主导率信号** | ❌ | ✅ 30 日趋势 | 我们领先 |
| **CVD 真实 aggTrade** | ✅（Orderflow 模块，可选） | ✅（WebSocket 已接入） | 相当 |
| **Kelly 仓位** | ❌（固定 stake_amount） | ✅ 半 Kelly | 我们领先 |
| **组合相关性管理** | ❌ | ✅ 热度加权缩减 | 我们领先 |
| **MTF 多时间框架** | ✅（informative_pairs 机制） | ✅ 1h/4h/1d | 相当 |
| **Walk-Forward 回测** | ✅ HyperOpt + 回测引擎 | ⭕ 待实现（P4.3） | 🟡 中 |
| **Web UI** | ✅ FreqUI（React，实时） | ⭕ 静态 HTML dashboard | 🟡 中 |

---

## 三、Freqtrade 关键代码解析

### 3.1 ROI Table 实现（strategy/interface.py:1650）

```python
# 策略配置
minimal_roi = {
    0:   0.08,   # 0分钟：需要 8% 才出
    60:  0.04,   # 60分钟：4% 就出
    120: 0.02,   # 120分钟：2% 就出
    480: 0.00,   # 480分钟：保本就出
}

def min_roi_reached_entry(self, trade, trade_dur, current_time):
    # 找到所有 key <= 当前持仓时长的条目
    roi_list = [x for x in self.minimal_roi.keys() if x <= trade_dur]
    if roi_list:
        roi_entry = max(roi_list)       # 取最新的那个（最小的阈值）
        min_roi = self.minimal_roi[roi_entry]
    # custom_roi 可进一步覆盖（动态逻辑）
    return roi_entry, min_roi

def min_roi_reached(self, trade, current_profit, current_time):
    trade_dur = int((current_time - trade.open_date_utc).total_seconds() // 60)
    _, roi = self.min_roi_reached_entry(trade, trade_dur, current_time)
    return current_profit > roi   # 当前盈利 > 当前阶段目标 → 出场
```

**我们如何实现**（计划在 F1 实现）：
```typescript
// types.ts 新增
interface RoiTable {
  [minutesStr: string]: number;   // "0": 0.08, "60": 0.04 ...
}

// engine.ts / executor.ts
function checkRoiTable(roiTable: RoiTable, holdMinutes: number, currentProfitRatio: number): boolean {
  const applicableKeys = Object.keys(roiTable)
    .map(Number)
    .filter(k => k <= holdMinutes)
    .sort((a, b) => b - a);
  if (applicableKeys.length === 0) return false;
  const threshold = roiTable[String(applicableKeys[0])];
  return currentProfitRatio >= threshold;
}
```

---

### 3.2 订单超时实现（freqtradebot.py:1575）

```python
def manage_open_orders(self) -> None:
    for trade in Trade.get_open_trades():
        for open_order in trade.open_orders:
            order = self.exchange.fetch_order(open_order.order_id, trade.pair)
            fully_cancelled = self.update_trade_state(trade, open_order.order_id, order)
            not_closed = order["status"] == "open" or fully_cancelled

            if not_closed:
                if self.strategy.ft_check_timed_out(trade, open_order, datetime.now(UTC)):
                    self.handle_cancel_order(order, open_order, trade, CANCEL_REASON["TIMEOUT"])
                else:
                    self.replace_order(order, open_order, trade)   # 新 K 线 → 价格调整

# 配置
unfilledtimeout = {
    "entry": 10,        # 买单 10 分钟未成交 → 取消
    "exit": 30,         # 卖单 30 分钟未成交 → 降价重试
    "unit": "minutes",
    "exit_timeout_count": 0,  # 卖单超时 N 次后强制市价出场
}
```

**关键点**：
- 超时取消 entry：直接 cancel，不重下（防止市况已变）
- 超时取消 exit：先取消，然后用新价格重新挂单（保证能卖出）
- `exit_timeout_count`：如果卖单超时多次 → `emergency_exit()` 市价强制出

---

### 3.3 部分成交处理（persistence/trade_model.py）

```python
class Order(ModelBase):
    status: str         # 'open' / 'partially_filled' / 'filled' / 'cancelled'
    amount: float       # 原始下单量
    filled: float       # 已成交量
    remaining: float    # 未成交量 = amount - filled

    @property
    def safe_remaining(self):
        return max(self.safe_amount - (self.filled or 0.0), 0)

# 当 order 变为 partially_filled：
def update_trade(self, order: Order, ...):
    if order.ft_order_side == self.entry_side:
        # 部分成交：更新持仓量为已成交部分
        self.amount = order.safe_amount_after_fee
        self.open_rate = order.safe_price    # 实际成交均价
    # 剩余未成交 → 继续挂单（直到超时再取消）
```

---

### 3.4 confirm_trade_entry 入场确认（freqtradebot.py:914）

```python
# execute_entry 中，下单前调用
if not strategy_safe_wrapper(self.strategy.confirm_trade_entry, default_retval=True)(
    pair=pair,
    order_type=order_type,
    amount=amount,
    rate=enter_limit_requested,   # 计划入场价
    time_in_force=time_in_force,
    current_time=datetime.now(UTC),
    entry_tag=enter_tag,
    side=trade_side,
):
    logger.info(f"User denied entry for {pair}.")
    return False
```

策略可以在 `confirm_trade_entry()` 里检查：
- 当前价与信号价偏差 > X%（闪崩保护）
- 已有太多同向持仓
- 当前时段不适合入场（如重大新闻前）

---

### 3.5 Trade 模型与 SQLite 持久化

```python
class Trade(ModelBase):
    # 核心字段
    id: int                     # 自增主键
    pair: str                   # "BTC/USDT"
    is_short: bool
    stake_amount: float         # 投入本金（USDT）
    amount: float               # 实际持仓量（BTC）
    open_rate: float            # 实际入场均价
    open_date: datetime
    close_rate: float | None
    close_date: datetime | None
    stop_loss: float
    initial_stop_loss: float
    is_stop_loss_trailing: bool

    # 关联订单（一对多）
    orders: list[Order]

    # 计算属性
    @property
    def open_orders(self) -> list[Order]:
        return [o for o in self.orders if o.ft_is_open and o.ft_order_side != "stoploss"]

    @property
    def has_open_orders(self) -> bool:
        return len([o for o in self.open_orders if o.ft_order_side != "stoploss"]) > 0

    def calc_profit_ratio(self, rate: float | None = None) -> float:
        # 含手续费的精确盈亏比
        close_trade_value = self.calc_close_trade_value(rate or self.close_rate)
        profit = close_trade_value - self.open_trade_value
        return profit / self.open_trade_value
```

**我们目前的等价物**：
```typescript
// account.ts
interface PaperPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  // ❌ 无 orderId 追踪
  // ❌ 无 openDate（无法计算持仓时长）
  // ❌ 无 filled/remaining（假设 100%）
  signalHistoryId?: string;
  dcaState?: DcaState;
}
```

---

## 四、差距优先级矩阵

### 🔴 高优先级（直接影响盈利 / 资金安全）

| 差距 | Freqtrade 方案 | 实现代价 | 预期收益 |
|------|----------------|----------|----------|
| ROI Table | `minimal_roi` dict + `min_roi_reached()` | 低（2天） | 胜率 +15~25% |
| 订单超时 | `manage_open_orders()` + `unfilledtimeout` | 中（3天） | 防幽灵订单 |
| 部分成交处理 | `Order.filled` + `safe_remaining` | 中（3天） | 持仓精度 |
| 持仓时长追踪 | `open_date` 字段 | 低（1天） | ROI Table 前提 |

### 🟡 中优先级（稳健性提升）

| 差距 | Freqtrade 方案 | 实现代价 | 预期收益 |
|------|----------------|----------|----------|
| confirm_trade_entry | 策略回调 hook | 低（1天） | 防闪崩误买 |
| 订单状态机 | Order Model + status | 中（4天） | 崩溃恢复 |
| K 线集中缓存 | DataProvider | 高（重构） | API 请求 -60% |
| 回测/实盘统一 | IStrategy 接口 | 高（重构） | 减少 bug 温床 |

### 🟢 低优先级（长期演化）

| 差距 | Freqtrade 方案 | 实现代价 | 预期收益 |
|------|----------------|----------|----------|
| SQLite 持久化 | SQLAlchemy ORM | 高（重构） | 崩溃安全，可查询 |
| HyperOpt 参数优化 | Bayesian Search | 高 | 防过拟合 |
| 保护机制 | CooldownPeriod/StoplossGuard | 中 | 防止频繁触发 |
| Web UI | FreqUI（React） | 高 | 用户体验 |

---

## 五、我们领先 Freqtrade 的地方

这些功能 Freqtrade 没有或需要大量配置才能实现：

| 功能 | 说明 |
|------|------|
| **LLM 语义情绪分析** | 调用 OpenClaw Gateway，自动写缓存，news_collector 触发 |
| **Kelly 动态仓位** | 基于历史胜率/盈亏比动态计算，Freqtrade 用固定 stake |
| **组合相关性热度管理** | Pearson 相关矩阵 → 仓位连续缩减，Freqtrade 无原生支持 |
| **BTC 主导率趋势信号** | 30 日趋势追踪，影响山寨币开仓方向 |
| **VWAP ±1σ/±2σ 偏差带** | 6 个专用信号条件 |
| **突发新闻 halt** | 30 个高危关键词，≥2 触发 2h 冻结 |
| **Pivot Point S/R** | 日线 Pivot Point + 4h 高低点双层算法 |
| **Watchdog 自监控** | cron 超时 → Telegram 告警 |
| **市场分析 + Telegram** | 09:00/21:00 CST 自动发送深度分析 |

---

## 六、行动建议

### 立即实现（v0.3 阶段，F1+F2）

**1. ROI Table（1-2天）**
```typescript
// types.ts
interface RiskConfig {
  minimal_roi?: Record<string, number>;  // "0": 0.08, "60": 0.04
  take_profit_percent?: number;           // 保留旧字段作为 fallback
}

// engine.ts / executor.ts
function checkMinimalRoi(roiTable, holdMinutes, profitRatio): boolean
```

**2. 持仓时长记录（半天）**
```typescript
interface PaperPosition {
  openTimestamp: number;  // Date.now() at entry
}
```

**3. 订单超时（2-3天）**
```typescript
// executor.ts
interface PendingOrder {
  orderId: number;
  symbol: string;
  side: 'buy' | 'sell' | 'short' | 'cover';
  placedAt: number;       // timestamp
  timeoutMs: number;      // default: 5min for entry, 10min for exit
}

async pollOrderUntilFilled(orderId, symbol, timeoutMs): PaperTrade | 'cancelled'
```

**4. confirm_trade_entry（1天）**
```typescript
// executor.ts handleBuy/handleShort 前
function confirmEntryPriceSlippage(signalPrice, currentPrice, maxSlippage = 0.005): boolean
```

### 中期（v0.5 之前）

- 部分成交处理：按实际 `executedQty` 更新持仓
- 订单状态机：`account.openOrders` 持久化
- 回测/实盘信号层统一（`signal-engine.ts`）

### 长期（v1.0 阶段）

- SQLite 持久化（`better-sqlite3`）替换 JSON 账户文件
- HyperOpt 风格的策略参数搜索

---

## 七、结论

Freqtrade 是 7 年生产验证的成熟框架，在**订单执行可靠性**上远超我们：订单超时、部分成交、状态机、SQLite 持久化是它的核心竞争力。

我们在**信号质量**上有明显领先：LLM 情绪、Kelly 仓位、组合相关性、BTC 主导率是 Freqtrade 没有的能力。

**综合评估**：
- Freqtrade 适合"追求执行可靠性，信号逻辑简单"的场景
- openclaw-trader 适合"信号质量驱动，愿意承担工程复杂度"的场景

我们不需要 fork Freqtrade，而是**借鉴它的执行层设计**（ROI Table + 订单超时 + 部分成交），同时保留我们在信号层的优势。

---

*编写：Mia · 2026-02-25*  
*参考源码：freqtrade 2026.2-dev-402ef21，本地路径：/home/ubuntu/freqtrade/*

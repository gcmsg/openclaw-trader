# ROADMAP — 运营优化阶段

> 功能开发暂停，进入"让系统跑起来"阶段。
> 目标：2 周内积累 50+ 笔交易，用数据验证策略有效性。

## Phase A：精简与加速（本周）

### A1. 场景精简 ✅ → 3 个核心场景
- testnet-default（实盘模拟，SL5%/TP15%）
- rsi-spot（RSI 均值回归，rsi-reversal 插件）
- aggressive-spot（激进策略，更高频）
- 其余全部 `enabled: false`

### A2. 信号频率提升
- 当前 90 天只有 12 笔交易 → 胜率 25% 没有统计意义
- 方案：去掉 MTF 4h 趋势过滤（这是最大的信号杀手）
- 在 testnet-default 上先试 1 周，对比有无 MTF 的差异

### A3. 止损执行验证
- 确认 live-monitor 真的会触发止损卖出
- 方法：查看 ws-monitor 和 cron 的止损代码路径

### A4. 自动周报
- 设置 weekly-report 每周日 22:00 CST 自动运行 + 发 Telegram

## Phase B：数据驱动优化（下周）

### B1. Hyperopt 参数优化
- 用 90 天数据跑一次 Bayesian 优化
- 关注：MA 周期、RSI 阈值、SL/TP 比例

### B2. 信号统计分析
- 等积累 30+ 笔交易后运行 `npm run signal-stats`
- 识别哪些信号组合真正盈利

### B3. 策略对比
- testnet-default vs rsi-spot vs aggressive-spot
- 用 `npm run paper:compare` 对比胜率、收益、回撤

## Phase C：决策点（2 周后）

- 如果某策略持续盈利 → 讨论实盘
- 如果全部亏损 → 回到信号质量优化
- 如果数据不够 → 继续跑或缩短 K 线周期

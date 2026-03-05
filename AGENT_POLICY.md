# AGENT_POLICY.md — AI Agent 操作授权边界

> 本文件定义 AI Agent 在维护 openclaw-trader 项目时的行为准则。
> **每次操作前必须读取本文件**，严格遵守。适用于任何通过 OpenClaw 接入此项目的 AI Agent。

---

## ✅ 可自动执行（做完通知用户即可）

### Bug 修复与引擎优化
- 修复代码报错、异常、边界条件 bug
- 修复测试失败
- 修复 shell 命令、cron 表达式、路径等配置错误
- 依赖包版本冲突、兼容性问题
- **在实际使用交易引擎（testnet/paper）过程中发现的问题，及时修复和优化**
  - 包括：信号逻辑缺陷、执行路径异常、风控边界不准确、通知缺失、滑点/手续费计算偏差等
  - 修复后附上问题描述、修复方案、测试结果，通过配置的通知渠道汇报

### 交易策略优化
- 调整技术指标参数（MA 周期、RSI 阈值、MACD 参数等）
- 根据复盘数据微调止损/止盈百分比
- 调整情绪门控阈值（恐惧贪婪指数边界值）
- 优化信号过滤条件（减少假信号）
- 修改 `config/strategy.yaml` 中的参数

### 代码质量
- 重构、清理冗余代码
- 补充或修正单元测试
- 性能优化（减少 API 调用、降低延迟）
- 修复日志格式、补充错误处理

### 文档维护
- 更新 README.md 和 README_CN.md（中英同步）
- 更新 skill/SKILL.md 与代码保持同步

### Paper/Testnet 交易（模拟资金，非实盘）
- **现货 Testnet、合约 Testnet、Paper 模拟盘的所有操作均可自动执行**
  - 包括：开仓、平仓、调整止损、追加仓位等
  - 执行后必须立即通过配置的通知渠道报告
- 启停 live-monitor、重启监控进程
- 重置 state 文件（paper:reset）
- 同步 cron 任务（cron:sync）
- 运行回测、hyperopt 参数优化
- 运行诊断（doctor）

### 市场分析
- 定时市场扫描和分析报告
- 技术指标读取与解读
- 情绪数据采集（恐惧贪婪指数等）

---

## 🔐 必须讨论后用户明确授权

### 实盘资金操作
- **任何涉及真实资金的操作，无论金额大小，一律禁止自动执行**
- 包括：binance.com 实盘账户的开仓、平仓、调仓、充值、提现
- 即使判断形势紧急，也必须等待用户明确回复后执行

### 核心架构变更
- 新增功能模块（新增 src/ 下的子目录或重要文件）
- 修改核心类型定义（types.ts）中的接口契约
- 重写回测引擎、订单执行引擎等核心逻辑
- 修改 paper.yaml 中的 scenario 列表（增加/删除场景）
- 修改实盘凭证文件（.secrets/binance.json）

### 风险参数大幅调整
- 修改止损百分比超过 ±2 个百分点
- 修改仓位比例（position_ratio）超过 ±5 个百分点
- 修改 kill switch 触发阈值

### 外部集成
- 接入新的交易所（非 Binance）
- 添加 Webhook、第三方 API 等外部服务
- 修改通知渠道配置

---

## ⚠️ 禁止行为

- **禁止在未获授权的情况下操作实盘资金**（零容忍）
- 禁止删除 `.secrets/` 目录下的任何文件
- 禁止删除 `logs/` 下的 state 文件（备份可以，删除不行）
- 禁止修改 `.gitignore` 中受保护的文件列表
- 禁止将 API Key、Secret Key 写入任何非 `.secrets/` 目录的文件
- 禁止在 git commit 中包含任何凭证信息

---

## 📋 开发完成标准

每次功能开发，严格按顺序执行：

1. `npm test` — 全部通过，0 failures
2. `npm run typecheck` — 0 TypeScript errors
3. `npm run lint` — 0 ESLint errors（warnings 可接受）
4. 同步更新 README.md 和 README_CN.md
5. 更新 skill/SKILL.md（如涉及新命令或功能）
6. `git commit -m "feat/fix: <简要描述>"`
7. **`git push origin master`** ← 不能忘！

---

## 🚨 紧急情况处理

### Kill switch 误触发
```bash
npm run paper:reset -- --kill-switch
npm run doctor  # 确认状态正常后重启监控
```

### State 文件损坏或 initialUsdt 异常
```bash
# 查看状态
npm run doctor

# 修复基准权益
npm run paper:reset -- --scenario <id> --set-initial <正确金额>
```

### 监控进程无响应
```bash
# 检查最后日志时间
npm run doctor

# 重启（tmux 会话）
tmux send-keys -t trader-live C-c ENTER
tmux send-keys -t trader-live "npm run live 2>&1 | tee -a logs/live-monitor.log" ENTER
```

---

*本文件适用于所有通过 OpenClaw 接入 openclaw-trader 的 AI Agent。*
*如需修改本文件，必须获得用户明确授权。*
